// AtomicVaultReader — vault logic.
//
// Classic script, not an ES module (D-CR-002 spike finding: a module import is a
// second fetch, and a failed fetch imitates the Crostini path trap).
//
// Pure logic. No DOM, no chrome.* API. The node harness in tests/run.js loads this
// file with vm, so every top-level declaration must be `var` or `function`.

var VAULT_WALK_CAP = 5000;

// C3 (Sprint 1 code review). A symlink loop or a pathological tree must not
// recurse without an end. 64 levels is far past any real vault.
var VAULT_DEPTH_CAP = 64;

var vaultCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

// --- errors ---------------------------------------------------------------

function vaultPathError(message) {
  var err = new Error(message);
  err.name = "PathTraversalError";
  return err;
}

// --- paths ----------------------------------------------------------------

// The only path parser in the codebase. vaultReadFile and the stored-path
// validator both go through it.
function vaultSplitPath(path) {
  if (typeof path !== "string") throw vaultPathError("Path is not a string.");
  if (path.length === 0) throw vaultPathError("Path is empty.");
  if (path.charAt(0) === "/") throw vaultPathError("Path starts with a slash.");
  if (path.indexOf("\\") !== -1) throw vaultPathError("Path holds a backslash.");

  var segments = path.split("/");
  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i];
    if (segment === "") throw vaultPathError("Path holds an empty segment.");
    if (segment === ".") throw vaultPathError("Path holds a '.' segment.");
    if (segment === "..") throw vaultPathError("Path holds a '..' segment.");
  }
  return segments;
}

// The join rule that vaultWalk uses. The root node carries an empty path, so a
// first-level child must not gain a leading slash (QA finding P1).
function vaultJoinPath(parentPath, name) {
  return parentPath ? parentPath + "/" + name : name;
}

// Guards the chrome.storage.local value. Never throws.
function vaultIsValidStoredPath(value) {
  if (typeof value !== "string") return false;
  if (value.length >= 4096) return false;
  try {
    vaultSplitPath(value);
  } catch (err) {
    return false;
  }
  return true;
}

function vaultIsMarkdown(name) {
  return /\.md$/i.test(name);
}

function vaultIsImage(name) {
  if (typeof name !== "string") return false;
  return /\.(png|jpg|jpeg|gif|webp|svg|avif|bmp)$/i.test(name);
}

// --- character references -------------------------------------------------

// C2-1 (Sprint 2 code review). marked's lexer hands back the source characters,
// so `&amp;` reaches the DOM as five characters. CommonMark asks for one.
//
// An explicit table and a bounded numeric parser, never an HTML parser. A
// DOMParser call here would rebuild the injection path Sprint 2 refused to
// build, for a cosmetic gain.
var VAULT_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", middot: "\u00b7",
  bull: "\u2022", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  deg: "\u00b0", plusmn: "\u00b1", times: "\u00d7", divide: "\u00f7",
  laquo: "\u00ab", raquo: "\u00bb", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d",
  eacute: "\u00e9", egrave: "\u00e8", ecirc: "\u00ea", agrave: "\u00e0",
  acirc: "\u00e2", ccedil: "\u00e7", icirc: "\u00ee", iuml: "\u00ef",
  ocirc: "\u00f4", ucirc: "\u00fb", ugrave: "\u00f9"
};

var VAULT_ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g;

// S3-2. Tab, line feed and carriage return are legitimate text. Every other C0
// control, DEL, the surrogate range and anything past the Unicode maximum are
// refused, and the reference stays literal.
function vaultIsTextCodePoint(code) {
  if (!isFinite(code) || code <= 0 || code > 0x10ffff) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code === 0x7f) return false;
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  return true;
}

// Decodes well-formed character references. Never throws. An unknown name or an
// invalid code point stays literal: the reader never swallows what it cannot
// name.
function vaultDecodeEntities(text) {
  if (typeof text !== "string") return "";
  if (text.indexOf("&") === -1) return text;

  return text.replace(VAULT_ENTITY_RE, function (whole, body) {
    if (body.charAt(0) === "#") {
      var isHex = body.charAt(1) === "x" || body.charAt(1) === "X";
      var digits = isHex ? body.slice(2) : body.slice(1);
      var code = parseInt(digits, isHex ? 16 : 10);
      if (!vaultIsTextCodePoint(code)) return whole;
      try {
        return String.fromCodePoint(code);
      } catch (err) {
        return whole;
      }
    }

    var named = VAULT_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

// The parent path of a vault path. A first-level file has the root as parent,
// and the root carries an empty path.
function vaultDirname(path) {
  if (typeof path !== "string") return "";
  var cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

// --- permission -----------------------------------------------------------

// D-CR-002: never assume a stored handle is live. This is the only query path.
function vaultCheckPermission(handle) {
  return handle.queryPermission({ mode: "read" });
}

// Callers must invoke this inside a user gesture.
function vaultRequestPermission(handle) {
  return handle.requestPermission({ mode: "read" });
}

// --- walk -----------------------------------------------------------------

async function vaultWalk(handle) {
  // Two flags, two meanings (QA finding S2). `stopped` aborts the whole walk at
  // the entry cap. `truncated` is the user-visible flag, and both caps raise it.
  var state = { count: 0, fileCount: 0, mdCount: 0, truncated: false, stopped: false };
  var tree = { name: handle.name, kind: "dir", isMd: false, path: "", children: [] };
  await vaultWalkDir(handle, tree, state, 0);
  return {
    tree: tree,
    fileCount: state.fileCount,
    mdCount: state.mdCount,
    truncated: state.truncated
  };
}

async function vaultWalkDir(dirHandle, node, state, depth) {
  // The depth cap stops this branch only. Siblings still get walked.
  if (depth > VAULT_DEPTH_CAP) {
    state.truncated = true;
    return;
  }

  for await (var pair of dirHandle.entries()) {
    if (state.stopped) return;

    var name = pair[0];
    var entry = pair[1];

    // Dotfiles stay invisible. Tier 0 must not surface .pkms-* artifacts.
    if (name.charAt(0) === ".") continue;

    if (state.count >= VAULT_WALK_CAP) {
      state.truncated = true;
      state.stopped = true;
      return;
    }
    state.count++;

    var childPath = vaultJoinPath(node.path, name);

    if (entry.kind === "directory") {
      var dirNode = { name: name, kind: "dir", isMd: false, path: childPath, children: [] };
      node.children.push(dirNode);
      await vaultWalkDir(entry, dirNode, state, depth + 1);
    } else {
      var isMd = vaultIsMarkdown(name);
      node.children.push({ name: name, kind: "file", isMd: isMd, path: childPath });
      state.fileCount++;
      if (isMd) state.mdCount++;
    }
  }
}

// --- sort -----------------------------------------------------------------

// D-CR-002 sort mandate. entries() returns no guaranteed order, so a tree whose
// order changes between launches is a defect. Directories first, then files.
// The raw-name tie-break keeps the order deterministic when the collator calls
// two names equal (it ignores case at sensitivity 'base').
function vaultSortTree(node) {
  if (!node || !node.children) return node;

  node.children.sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    var byCollator = vaultCollator.compare(a.name, b.name);
    if (byCollator !== 0) return byCollator;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  for (var i = 0; i < node.children.length; i++) vaultSortTree(node.children[i]);
  return node;
}

// --- tree projections -----------------------------------------------------

// C2-5 (Sprint 2 code review). treeHasFile walked the whole tree once per link,
// which costs a note with 200 links against a 5000-entry vault a million
// comparisons. One O(n) build gives O(1) lookups instead.
//
// The kind comes with it, which is what lets C2-2 tell a folder from decay.
// The root carries an empty path and is not an entry.
function vaultPathIndex(node, index) {
  var map = index || new Map();
  if (!node || !node.children) return map;

  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i];
    map.set(child.path, child.kind === "dir" ? "dir" : "file");
    if (child.kind === "dir") vaultPathIndex(child, map);
  }
  return map;
}

// Every Markdown file, in tree order. The caller sorts the tree first, so the
// order is deterministic — the same D-CR-002 rule the tree itself obeys.
function vaultListMdFiles(node, out) {
  var paths = out || [];
  if (!node || !node.children) return paths;

  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i];
    if (child.kind === "dir") vaultListMdFiles(child, paths);
    else if (child.isMd) paths.push(child.path);
  }
  return paths;
}

// --- read -----------------------------------------------------------------

// The one file-reaching path. vaultReadFile and the image loader both go
// through it, so both inherit the vaultSplitPath gate.
async function vaultGetFile(rootHandle, path) {
  var segments = vaultSplitPath(path);
  var dir = rootHandle;
  for (var i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i]);
  }
  var fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
  return fileHandle.getFile();
}

async function vaultReadFile(rootHandle, path) {
  var file = await vaultGetFile(rootHandle, path);
  return file.text();
}

// --- frontmatter ----------------------------------------------------------

function vaultStripCr(line) {
  return line.charAt(line.length - 1) === "\r" ? line.slice(0, -1) : line;
}

// Splits a note into its frontmatter block and its body. Never throws.
//
// A fence counts only when the first line of the file is exactly `---` and a
// later line is exactly `---`. An opening fence with no close is body text: the
// reader never swallows content it cannot name.
function vaultParseFrontmatter(text) {
  if (typeof text !== "string") return { frontmatter: null, body: "", fields: [] };

  var lines = text.split("\n");
  if (vaultStripCr(lines[0]) !== "---") return { frontmatter: null, body: text, fields: [] };

  var close = -1;
  for (var i = 1; i < lines.length; i++) {
    if (vaultStripCr(lines[i]) === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return { frontmatter: null, body: text, fields: [] };

  var frontmatter = lines.slice(1, close).join("\n");
  return {
    frontmatter: frontmatter,
    body: lines.slice(close + 1).join("\n"),
    fields: vaultFrontmatterFields(frontmatter)
  };
}

// Display only. This is not a YAML parser and must never grow into one: it
// splits on the first colon and keeps every other line whole.
function vaultFrontmatterFields(frontmatter) {
  var fields = [];
  if (typeof frontmatter !== "string") return fields;

  var lines = frontmatter.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = vaultStripCr(lines[i]);
    if (line.trim() === "") continue;

    var cut = line.indexOf(":");
    if (cut <= 0) {
      fields.push(["", line]);
      continue;
    }
    fields.push([line.slice(0, cut).trim(), line.slice(cut + 1).trim()]);
  }
  return fields;
}

// --- link resolution ------------------------------------------------------

var VAULT_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Maps a link href to one of four kinds. Pure: existence is the caller's
// problem, because reachability is state and resolution is not.
//
//   external — http or https, opened in a new tab
//   vault    — a normalized root-relative path, vaultSplitPath-clean
//   broken   — a path that leaves the vault, or cannot be named
//   inert    — rendered as plain text, never clickable
//
// `javascript:` lands on inert. That line is a security control, not a
// formatting choice.
function vaultResolveLink(currentPath, href) {
  if (typeof href !== "string") return { kind: "inert" };

  var raw = href.trim();
  if (raw.length === 0) return { kind: "inert" };
  if (raw.charAt(0) === "#") return { kind: "inert" };

  var scheme = VAULT_SCHEME_RE.exec(raw);
  if (scheme) {
    var name = scheme[0].slice(0, -1).toLowerCase();
    if (name === "http" || name === "https") return { kind: "external", url: raw };
    return { kind: "inert" };
  }

  if (raw.charAt(0) === "/") return { kind: "broken" };
  if (raw.indexOf("\\") !== -1) return { kind: "broken" };

  // Sprint 2 strips the fragment and the query. Heading anchors belong to
  // Sprint 3.
  var cut = raw.search(/[#?]/);
  var target = cut === -1 ? raw : raw.slice(0, cut);
  if (target.length === 0) return { kind: "inert" };

  var base = vaultDirname(typeof currentPath === "string" ? currentPath : "");
  var stack = base ? base.split("/") : [];

  var parts = target.split("/");
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part === "" || part === ".") continue;

    if (part === "..") {
      if (stack.length === 0) return { kind: "broken" };
      stack.pop();
      continue;
    }

    var decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch (err) {
      return { kind: "inert" };
    }

    // A decoded separator is an escape attempt, not a file name.
    if (decoded === "" || decoded === "." || decoded === "..") return { kind: "broken" };
    if (decoded.indexOf("/") !== -1 || decoded.indexOf("\\") !== -1) return { kind: "broken" };

    stack.push(decoded);
  }

  if (stack.length === 0) return { kind: "inert" };
  return { kind: "vault", path: stack.join("/") };
}

// Every directory path in a walked tree, in tree order — the order
// vaultSortTree() leaves, which puts every directory before every file.
//
// Pure: it reads the walked tree and touches no DOM and no storage. The reader
// collects its open folders from the DOM instead, because only the DOM knows
// which ones are open. This exists so the folder-path rule is pinned by a test
// that tests/run.js can actually reach, and so Sprint 7 has it ready.
function vaultFolderPaths(node) {
  var out = [];
  collect(node && node.children ? node.children : []);
  return out;

  function collect(children) {
    for (var i = 0; i < children.length; i++) {
      if (children[i].kind !== "dir") continue;
      out.push(children[i].path);
      collect(children[i].children);
    }
  }
}
