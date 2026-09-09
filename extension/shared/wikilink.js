// AtomicVaultReader — wikilink parsing and resolution (Sprint 5).
//
// Classic script. Loaded after shared/vault.js and before shared/index.js:
// index.js calls wikiResolve, and a classic script has no module graph, so the
// page order is the dependency.
//
// Pure. No DOM, no chrome.* API, no directory handle. The node harness in
// tests/run.js loads it with vm, so every top-level declaration is `var` or
// `function`.
//
// C4: a wikilink target resolves from the VAULT ROOT. vaultResolveLink
// resolves an href relative to the current note's folder. Two input grammars
// over one validated path type — vaultSplitPath stays the only path parser,
// and every candidate path goes through it.

// Shape tests. Canonical ULID is uppercase Crockford base32. Neither regex is
// global, so neither carries a lastIndex.
var WIKI_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
var WIKI_KEY_RE  = /^K-\d{1,10}$/;

// The one pattern. `!` prefix marks an embed (C6). Inner text excludes brackets,
// and the 256 cap matches the Sprint 2 chip pattern.
//
// m1: a /g regex carries lastIndex between calls, and two files run this one.
// Never call WIKI_RE.test(). Set WIKI_RE.lastIndex = 0 before every exec loop,
// even a loop that runs to null. Sprint 2 avoided this by building a fresh
// pattern inside renderText; a shared regex cannot.
var WIKI_RE = /(!?)\[\[([^\[\]]{1,256}?)\]\]/g;

function wikiIsId(target) {
  if (typeof target !== "string") return false;
  return WIKI_ULID_RE.test(target) || WIKI_KEY_RE.test(target);
}

// B2: the pkms-lint order — code-unit order over the whole root-relative path.
//
// NEVER Intl.Collator: it is locale-dependent. Never vaultSortTree's comparator
// either, which answers a different question — what a human reads down a tree,
// directories first. Tree order and path order disagree whenever a directory
// name sorts after a file name, and then this reader and pkms-lint would keep
// different winners for one duplicated id.
//
// Known limit: Python compares by code point and JavaScript by UTF-16 code
// unit. The two differ only outside the Basic Multilingual Plane.
function wikiComparePaths(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Splits on the FIRST `|` for the alias, then the left part on the FIRST `#`
// for the fragment. Returns null when nothing is left to resolve.
function wikiParse(inner) {
  if (typeof inner !== "string") return null;

  var left = inner;
  var alias = null;

  var bar = left.indexOf("|");
  if (bar !== -1) {
    alias = left.slice(bar + 1).trim();
    left = left.slice(0, bar);
    if (alias.length === 0) alias = null;
  }

  var fragment = null;
  var hash = left.indexOf("#");
  if (hash !== -1) {
    fragment = left.slice(hash + 1).trim();
    left = left.slice(0, hash);
    if (fragment.length === 0) fragment = null;
  }

  var target = left.trim();

  // [[#heading|alias]] — measured twice in the live vault. It is a jump inside
  // the note, not a link to one. C6 discards the fragment, so nothing is left.
  if (target.length === 0) return null;

  return { target: target, alias: alias, fragment: fragment };
}

// C1: a resolved path is not always a note. Step 2 asks the walked tree, and
// the tree holds every file. openFile has no vaultIsMarkdown guard, so a .png
// that reached it would render as Markdown.
function wikiKindOf(path) {
  var name = path.slice(path.lastIndexOf("/") + 1);
  return vaultIsMarkdown(name) ? "note" : "file";
}

function wikiHit(path) {
  return { kind: wikiKindOf(path), path: path };
}

function wikiIsValidPath(path) {
  try {
    vaultSplitPath(path);
  } catch (err) {
    return false;
  }
  return true;
}

// The C1 cascade. `ctx` carries three functions this file must not own:
//   idPath(id)      -> a path, or null            (index.ids)
//   stemPaths(stem) -> an array, possibly empty   (index.stems)
//   hasFile(path)   -> boolean                    (the walked tree)
function wikiResolve(target, ctx) {
  if (typeof target !== "string") return { kind: "inert" };

  var trimmed = target.trim();
  if (trimmed.length === 0) return { kind: "inert" };

  // The target is a vault-root path, so it meets the one path parser before
  // anything else. This is also what keeps [[../outside]] inert: were it to
  // fall through, the stem match would find `outside.md` and follow it.
  if (!wikiIsValidPath(trimmed)) return { kind: "inert" };
  if (!ctx) return { kind: "inert" };

  // Step 1 — an id. A ULID is unique by construction, so this returns one file
  // or nothing, and a ULID never reaches step 3.
  //
  // It FALLS THROUGH; it does not short-circuit to broken. A vault may hold a
  // note named K-0142.md, and refusing it would be a wrong answer rather than
  // a surfaced one.
  if (wikiIsId(trimmed) && ctx.idPath) {
    var byId = ctx.idPath(trimmed);
    if (byId) return wikiHit(byId);
  }

  // Step 2 — an exact path from the vault root, `.md` optional.
  if (ctx.hasFile) {
    if (ctx.hasFile(trimmed)) return wikiHit(trimmed);

    if (!vaultIsMarkdown(trimmed)) {
      var withMd = trimmed + ".md";
      if (wikiIsValidPath(withMd) && ctx.hasFile(withMd)) return wikiHit(withMd);
    }
  }

  // Step 3 — a stem match on the last segment. C2: compare VERBATIM. There is
  // no toLowerCase anywhere in this file. Archive.md and archive.md are two
  // files on Linux, and a reader that opens the wrong one is worse than a
  // reader that reports a miss.
  var stem = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (!vaultIsMarkdown(stem)) stem = stem + ".md";

  var matches = ctx.stemPaths ? ctx.stemPaths(stem) : [];
  if (!matches || matches.length === 0) return { kind: "broken" };
  if (matches.length === 1) return wikiHit(matches[0]);

  // C3: a collision is surfaced, never guessed. Sort a COPY — the array the
  // index hands back is the live one.
  return { kind: "ambiguous", candidates: matches.slice().sort(wikiComparePaths) };
}
