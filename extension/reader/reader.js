// AtomicVaultReader — the reader page.
//
// Classic script. Loaded after shared/idb.js and shared/vault.js, which it uses
// through their globals.
//
// Two rules govern this file:
//   1. The read guard (D-CR-002). Every path that touches the file system calls
//      readerGuard() immediately before the access. A boot check does not license
//      a later read.
//   2. Vault content reaches the DOM through textContent only. This file never
//      assigns an HTML string to an element, so both views are XSS-safe by
//      construction.

var SCREENS = ["screen-onboarding", "screen-reopen", "screen-error", "screen-main"];

var vaultHandle = null;
var vaultTree = null;

// C2-5: path -> "file" | "dir", built once per walk. A link lookup is O(1).
var vaultPaths = new Map();

// The in-memory Tier 0 index (D-CR-010). null means "not ready": either the
// build still runs, or it failed. `indexState` says which.
var vaultIndex = null;
var indexState = "idle";
var indexEpoch = 0;

var searchTimer = null;

// The open note. The raw text stays in memory so the Raw toggle re-paints
// without a second read.
var readerPath = null;
var readerText = null;
var readerView = "rendered";

// Both tools start off. A note opens as prose; metadata and navigation are
// asked for, not imposed. The choice survives note changes inside one session.
var readerShowFrontmatter = false;
var readerShowToc = false;
var readerFmFields = [];

// "system" | "light" | "dark". theme.js already stamped the system answer on
// <html> before the first paint; this holds the reader's own choice on top.
var readerTheme = "system";

// Remembered layout. Width and the hidden flag are about the window, so they
// are global. Open folders are about one vault's paths, so they are keyed by
// vault. `null` means "nothing stored yet", which is not the same as "the
// reader closed everything" — the first opens the default top level, the
// second opens nothing.
// C4-1: a vault folder named __proto__ would hit the prototype setter on a
// plain object and lose the remembered folders with no error.
var readerUi = { sidebarWidth: null, sidebarHidden: false, openFolders: Object.create(null) };
var readerUiLoaded = false;
var readerTreeReady = false;

// Object URLs live exactly as long as the note that created them. The epoch
// counter drops a URL that arrives after the reader moved on.
var readerImageUrls = [];
var readerEpoch = 0;

document.addEventListener("DOMContentLoaded", function () {
  announceReaderTab();
  wireHandlers();
  boot();
});

// --- tab registration -----------------------------------------------------

// D-CR-006: the worker remembers this tab id so the toolbar icon can focus the
// page instead of opening a second one. The worker sends no reply, so the
// promise rejects; that rejection is expected and carries no meaning.
function announceReaderTab() {
  try {
    var sending = chrome.runtime.sendMessage({ type: "reader-ready" });
    if (sending && typeof sending.catch === "function") sending.catch(function () {});
  } catch (err) {
    // No worker to talk to. The icon still opens a tab.
  }
}

// --- screens --------------------------------------------------------------

function showScreen(id) {
  for (var i = 0; i < SCREENS.length; i++) {
    document.getElementById(SCREENS[i]).hidden = SCREENS[i] !== id;
  }
  if (id === "screen-onboarding") focusElement("btn-grant");
  if (id === "screen-reopen") focusElement("btn-reopen");
  if (id === "screen-error") focusElement("btn-error-pick");
  // The main screen does not focus here. restoreLastFile() runs after this
  // call, so a focus taken now lands on the first row, and the restored note
  // then takes the selection border. The reader sees two marked rows
  // (PO UAT F, step 31, 2026-09-08). boot() focuses after the restore.
}

// A tool says the same thing to the pointer and to a screen reader: `title`
// draws the tooltip, `aria-label` is read aloud, and they never disagree.
function labelTool(tool, text) {
  tool.setAttribute("aria-label", text);
  tool.setAttribute("title", text);
}

function focusElement(id) {
  var node = document.getElementById(id);
  if (node) node.focus();
}

// The reader is the task; Change vault is an escape hatch. Focus the restored
// note first, then the first visible file entry, then the button when the tree
// holds none (QA finding P4).
//
// Sublevels start collapsed, so the first entry in document order can sit inside
// a closed folder. Focus there lands on something the reader cannot see, so the
// search skips hidden rows.
function focusMain() {
  // A read error during the restore routes to another screen. Do not pull the
  // focus back to a tree the reader no longer looks at.
  var screen = document.getElementById("screen-main");
  if (!screen || screen.hidden) return;

  // The restored note owns the focus. One row then carries the selection
  // border and the focus ring, and no second row is marked.
  var current = document.querySelector('#tree button[aria-current="true"]');
  if (current && isRevealed(current)) {
    current.focus();
    return;
  }

  var buttons = document.querySelectorAll("#tree button:not(:disabled)");
  for (var i = 0; i < buttons.length; i++) {
    if (isRevealed(buttons[i])) {
      buttons[i].focus();
      return;
    }
  }
  focusElement("btn-change-vault");
}

// True when no <details> between the node and the tree root is closed.
function isRevealed(node) {
  var parent = node.parentNode;
  while (parent && parent.tagName) {
    if (parent.tagName === "DETAILS" && !parent.open) return false;
    if (parent.id === "tree") return true;
    parent = parent.parentNode;
  }
  return true;
}

// Open every folder above a row. A collapsed folder must never hide the note
// the reader just opened.
//
// M3: it returns true only when it actually opened something. markSelected()
// writes storage on that answer, so a note clicked inside a folder that is
// already open still writes nothing — which is what C4-4 asks for.
function revealInTree(node) {
  var parent = node.parentNode;
  var opened = false;
  while (parent && parent.tagName) {
    if (parent.tagName === "DETAILS" && !parent.open) {
      parent.open = true;
      opened = true;
    }
    if (parent.id === "tree") return opened;
    parent = parent.parentNode;
  }
  return opened;
}

// C2: a picker failure is not a missing folder. The default copy still names a
// moved vault; the picker path says what actually happened.
function showVaultError(err, headline) {
  var name = vaultHandle && vaultHandle.name ? vaultHandle.name : "the vault folder";
  var isPicker = !!headline;

  document.getElementById("error-headline").textContent = headline || "Vault not found";
  document.getElementById("error-vault-name").textContent = name;
  document.getElementById("error-body-moved").hidden = isPicker;
  document.getElementById("error-body-picker").hidden = !isPicker;
  document.getElementById("error-detail").textContent = describeError(err);
  showScreen("screen-error");
}

function describeError(err) {
  if (!err) return "";
  return (err.name || "Error") + ": " + (err.message || "");
}

// --- the read guard -------------------------------------------------------

// The single implementation of the D-CR-002 mandate. Returns true only when a
// read may proceed.
async function readerGuard() {
  if (!vaultHandle) {
    showScreen("screen-onboarding");
    return false;
  }

  var state;
  try {
    state = await vaultCheckPermission(vaultHandle);
  } catch (err) {
    showVaultError(err);
    return false;
  }

  if (state === "granted") return true;
  if (state === "prompt") {
    showScreen("screen-reopen");
    return false;
  }

  // denied. The handle is dead; only a fresh pick recovers it.
  showScreen("screen-onboarding");
  return false;
}

// Permission can drop during an operation, which no guard prevents.
function routeReadError(err) {
  if (err && err.name === "NotAllowedError") {
    showScreen("screen-reopen");
    return;
  }
  showVaultError(err);
}

// --- boot -----------------------------------------------------------------

async function boot() {
  try {
    vaultHandle = await idbGetHandle();
  } catch (err) {
    vaultHandle = null;
  }

  if (!vaultHandle) {
    showScreen("screen-onboarding");
    return;
  }

  // C1: one routing site. readerGuard() inside enterMain already sends
  // `prompt` to the reopen screen and `denied` to onboarding.
  await enterMain();
}

async function enterMain() {
  if (!(await readerGuard())) return;

  // The tree is built from the remembered folder set, so the read must have
  // answered first. In practice the vault walk is slower, but "in practice" is
  // not a guarantee.
  await uiReady();

  var walked;
  try {
    walked = await vaultWalk(vaultHandle);
  } catch (err) {
    routeReadError(err);
    return;
  }

  vaultSortTree(walked.tree);
  vaultTree = walked.tree;
  vaultPaths = vaultPathIndex(walked.tree);

  document.getElementById("vault-name").textContent = vaultHandle.name;
  document.getElementById("vault-truncated").hidden = !walked.truncated;

  renderTree(walked.tree);
  showScreen("screen-main");

  await restoreLastFile();

  // After the restore, never before it. focusMain() prefers the restored note.
  focusMain();

  // Fire and forget. The tree and the open note never wait for the index.
  buildVaultIndex();
}

// --- tree rendering -------------------------------------------------------

// createElement + textContent only. No HTML string assembly.
// CR6-1: `toggle` fires asynchronously, so a synchronous false-then-true guard
// is back to true before the burst lands. Every late event then runs
// onFolderToggle, which since Sprint 6 refreshes the toggle button — one
// querySelectorAll over the tree per folder.
//
// Restoring the flag from a timeout holds the guard across the burst. A real
// click cannot land between synchronous code and the next task, so no toggle a
// reader performed is lost.
function releaseTreeGuard() {
  setTimeout(function () { readerTreeReady = true; }, 0);
}

function renderTree(root) {
  var container = document.getElementById("tree");
  container.textContent = "";
  // The guard silences the initial burst of `toggle` events, which fire
  // asynchronously and so may land after this function returns. Correctness
  // does not rest on it: rememberFolder() writes only when the new state
  // differs from the stored one, and on load they agree by construction. The
  // guard saves the events, not the data.
  readerTreeReady = false;
  container.appendChild(buildList(root.children, 0));
  refreshTreeToggle();
  releaseTreeGuard();
}

function buildList(children, depth) {
  var list = document.createElement("ul");
  var remembered = openFolderSet();

  for (var i = 0; i < children.length; i++) {
    var node = children[i];
    var item = document.createElement("li");

    if (node.kind === "dir") {
      // <details> carries the open state, the keyboard and the ARIA. A hand-built
      // toggle would carry none of the three.
      var details = document.createElement("details");
      details.dataset.path = node.path;

      // Two rules, and the order matters. With nothing remembered for this
      // vault, only the top level opens — a deep vault that unfolds itself is a
      // wall of file names. Once the reader has opened or closed anything, the
      // remembered set is the whole answer, so a closed top-level folder stays
      // closed.
      details.open = remembered === null
        ? depth === 0
        : remembered.indexOf(node.path) !== -1;

      details.addEventListener("toggle", onFolderToggle);

      var summary = document.createElement("summary");
      summary.textContent = node.name;

      details.appendChild(summary);
      details.appendChild(buildList(node.children, depth + 1));
      item.appendChild(details);
    } else {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = node.name;
      button.dataset.path = node.path;
      if (node.isMd) {
        button.addEventListener("click", onTreeClick);
      } else {
        // D-CR-005: greyed and inert, never hidden. Hiding them would misreport
        // the folder's content.
        button.className = "non-md";
        button.disabled = true;
      }
      item.appendChild(button);
    }

    list.appendChild(item);
  }

  return list;
}

// `toggle` fires for a click and for a programmatic open alike, which is what
// makes revealInTree() persist too: a folder opened to show the restored note
// is a folder the reader wants open. The guard keeps the initial build silent —
// without it, every folder would write on every load.
function onFolderToggle(event) {
  if (!readerTreeReady) return;
  rememberFolder(event.currentTarget.dataset.path, event.currentTarget.open);
  // A single folder closed by hand can be the last open one, and the toggle
  // must follow the tree.
  refreshTreeToggle();
}

function markSelected(path) {
  var buttons = document.querySelectorAll("#tree button");
  var revealed = null;

  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].dataset.path === path) {
      buttons[i].setAttribute("aria-current", "true");
      revealed = buttons[i];
    } else {
      buttons[i].removeAttribute("aria-current");
    }
  }

  if (!revealed) return;

  // C4-4: one write, not one per ancestor — and no write at all in the common
  // case, where the note sits in a folder that is already open. An
  // unconditional write here would be worse than the finding it closes.
  readerTreeReady = false;
  var opened = revealInTree(revealed);

  if (opened) {
    rememberOpenFolders();
    refreshTreeToggle();
  }
  releaseTreeGuard();
}

// --- expand and collapse every folder -------------------------------------

// C1: setAllFolders is the only function that changes more than one folder.
// Both named actions go through it, and no trigger writes details.open itself.
function collapseAllFolders() { setAllFolders(false); }
function expandAllFolders() { setAllFolders(true); }

// One suppress-and-write-once frame. onFolderToggle fires for a programmatic
// open exactly as it fires for a click, so a naive loop would write storage once
// per folder. readerTreeReady is the guard renderTree() already uses for the
// same reason; there is no second flag.
function setAllFolders(open) {
  var folders = document.querySelectorAll("#tree details");
  if (!folders.length) return;

  // C8: a closed <details> stops rendering its contents, and focus inside it
  // falls to <body>. Test before the mutation, move after it.
  var rescue = !open && treeContainsFocus();

  readerTreeReady = false;
  for (var i = 0; i < folders.length; i++) folders[i].open = open;

  // C1: rememberOpenFolders() is the only writer of openFolders[key]. Do not
  // build the array here as well. It runs before the toggle burst lands, so the
  // late rememberFolder() calls compare a state that already agrees.
  rememberOpenFolders();

  refreshTreeToggle();
  if (rescue) focusElement("btn-tree-toggle");
  releaseTreeGuard();
}

// True when the focused element sits inside the tree.
function treeContainsFocus() {
  var tree = document.getElementById("tree");
  var active = document.activeElement;
  return !!(tree && active && active !== document.body && tree.contains(active));
}

// C7: derived from the DOM, never stored. "Any folder open" and not "every
// folder open" — the other rule answers a click on a half-open tree with a full
// expansion, which is the wall of file names Sprint 4 increment 8 removed.
function refreshTreeToggle() {
  var button = document.getElementById("btn-tree-toggle");
  var folders = document.querySelectorAll("#tree details");
  var anyOpen = false;

  for (var i = 0; i < folders.length; i++) {
    if (folders[i].open) { anyOpen = true; break; }
  }

  if (!folders.length) {
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-disabled", "true");
    labelTool(button, "No folders to expand");
    return;
  }

  button.removeAttribute("aria-disabled");
  button.setAttribute("aria-expanded", anyOpen ? "true" : "false");
  labelTool(button, anyOpen ? "Collapse all folders" : "Expand all folders");
}

function onTreeToggleClick() {
  var button = document.getElementById("btn-tree-toggle");
  // C4-2: aria-disabled keeps the button reachable, so the handler must refuse
  // the click that a `disabled` attribute would have swallowed.
  if (button.getAttribute("aria-disabled") === "true") return;
  if (button.getAttribute("aria-expanded") === "true") collapseAllFolders();
  else expandAllFolders();
}

// D-CR-017: the worker broadcasts when the extension icon focused this tab. A
// broadcast reaches every extension context, so filter on the type and on
// nothing else.
//
// Return undefined. An async listener returns a promise, which Chrome reads as
// "a reply is coming", and the message channel stays open with no reply.
function onWorkerMessage(message) {
  if (!message || message.type !== "collapse-tree") return;
  collapseAllFolders();
}

// C2-5: one map lookup, not a walk of the whole tree per link.
function treeHasFile(path) {
  return vaultPaths.get(path) === "file";
}

function treeHasDir(path) {
  return vaultPaths.get(path) === "dir";
}

// --- reading --------------------------------------------------------------

function onTreeClick(event) {
  openFile(event.currentTarget.dataset.path);
}

async function openFile(path) {
  // The before-every-read mandate, applied at the entry point. A link click
  // enters here too, so a followed link is guarded by construction.
  if (!(await readerGuard())) return;

  var text;
  try {
    text = await vaultReadFile(vaultHandle, path);
  } catch (err) {
    routeReadError(err);
    return;
  }

  readerPath = path;
  readerText = text;
  readerView = "rendered";

  document.getElementById("file-path").textContent = path;
  document.getElementById("btn-view").hidden = false;
  clearStatus();
  clearChooser();
  markSelected(path);
  paintContent();
  paintBacklinks();
  document.getElementById("file-body").scrollTop = 0;

  try {
    await chrome.storage.local.set({ lastFile: path });
  } catch (err) {
    // Navigation state is a convenience. A failed write never blocks reading.
  }
}

// Paints the open note in the current view. Both views come from memory, so a
// toggle never reads the file twice.
function paintContent() {
  readerEpoch++;
  revokeImageUrls();

  var parsed = vaultParseFrontmatter(readerText === null ? "" : readerText);
  var rendered = document.getElementById("file-rendered");
  var raw = document.getElementById("file-raw");
  var button = document.getElementById("btn-view");

  if (readerView === "raw") {
    // The Sprint 1 view: the exact bytes, frontmatter included. The
    // key-value block would repeat what the reader already shows.
    paintFrontmatter([]);
    rendered.textContent = "";
    rendered.hidden = true;
    paintToc();
    raw.textContent = readerText === null ? "" : readerText;
    raw.hidden = false;
    button.textContent = "Rendered";
    return;
  }

  paintFrontmatter(parsed.fields);
  raw.textContent = "";
  raw.hidden = true;
  rendered.hidden = false;
  renderMarkdown(rendered, parsed.body, readerPath, readerContext());
  paintToc();
  button.textContent = "Raw";
}

// createElement + textContent, exactly like the tree. The frontmatter is vault
// data and gets the same treatment.
function paintFrontmatter(fields) {
  var block = document.getElementById("fm-block");
  block.textContent = "";
  readerFmFields = fields && fields.length ? fields : [];

  for (var i = 0; i < readerFmFields.length; i++) {
    var term = document.createElement("dt");
    term.textContent = readerFmFields[i][0];
    var value = document.createElement("dd");
    value.textContent = readerFmFields[i][1];
    block.appendChild(term);
    block.appendChild(value);
  }

  syncFrontmatterTool();
}

// Two facts decide the block: has this note any frontmatter, and did the reader
// ask to see it. The tool goes inert on the first, pressed on the second.
function syncFrontmatterTool() {
  var block = document.getElementById("fm-block");
  var tool = document.getElementById("btn-frontmatter");
  var has = readerFmFields.length > 0;
  var shown = has && readerShowFrontmatter;

  block.hidden = !shown;
  tool.disabled = !has;
  tool.setAttribute("aria-pressed", shown ? "true" : "false");
  labelTool(tool, !has ? "This note has no frontmatter"
                       : shown ? "Hide the frontmatter" : "Show the frontmatter");
}

function toggleFrontmatter() {
  readerShowFrontmatter = !readerShowFrontmatter;
  syncFrontmatterTool();
}

// --- table of contents ----------------------------------------------------

// Built from the rendered DOM, not from the tokens. render.js stays a pure
// token walker, and the heading text never leaves textContent: the anchor is a
// generated index, never a slug of vault content.
function paintToc() {
  var list = document.getElementById("toc-list");
  list.textContent = "";

  var headings = document.querySelectorAll(
    "#file-rendered h1, #file-rendered h2, #file-rendered h3," +
    " #file-rendered h4, #file-rendered h5, #file-rendered h6");

  for (var i = 0; i < headings.length; i++) {
    headings[i].id = "note-heading-" + i;

    var entry = document.createElement("button");
    entry.type = "button";
    entry.className = "toc-entry";
    entry.textContent = headings[i].textContent;
    entry.dataset.target = headings[i].id;
    entry.addEventListener("click", onTocClick);

    var item = document.createElement("li");
    item.dataset.depth = headings[i].tagName.charAt(1);
    item.appendChild(entry);
    list.appendChild(item);
  }

  syncTocTool(headings.length);
}

// One heading is not a table of contents, it is a repeated title. The tool
// stays inert below two.
function syncTocTool(count) {
  var nav = document.getElementById("toc");
  var tool = document.getElementById("btn-toc");
  var has = count >= 2;
  var shown = has && readerShowToc;

  nav.hidden = !shown;
  tool.disabled = !has;
  tool.setAttribute("aria-pressed", shown ? "true" : "false");
  labelTool(tool, !has ? "This note has no headings to list"
                       : shown ? "Hide the table of contents" : "Show the table of contents");
}

function toggleToc() {
  readerShowToc = !readerShowToc;
  syncTocTool(document.querySelectorAll("#toc-list li").length);
}

function onTocClick(event) {
  var target = document.getElementById(event.currentTarget.dataset.target);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
}

function toggleView() {
  if (readerText === null) return;
  readerView = readerView === "raw" ? "rendered" : "raw";
  paintContent();
  document.getElementById("file-body").scrollTop = 0;
}

// --- the renderer's window on the reader ----------------------------------

// render.js owns no state. Everything it cannot know comes through here.
function readerContext() {
  return {
    hasFile: treeHasFile,
    hasDir: treeHasDir,
    isMd: vaultIsMarkdown,
    isImage: vaultIsImage,
    onNavigate: function (path) {
      openFile(path);
    },
    onBroken: function (href) {
      showStatus("Not in this vault: " + href);
    },
    getImageUrl: readerImageUrl,

    // --- Sprint 5 ---------------------------------------------------------
    //
    // C8: hasIndex is what separates "no index yet" from "broken". Without it
    // an empty answer from the two readers below is indistinguishable from a
    // real miss, and the renderer would report decay that does not exist.
    hasIndex:  function ()     { return vaultIndex !== null; },
    idPath:    function (id)   { return vaultIndex ? vaultIndex.ids.get(id) || null : null; },
    stemPaths: function (stem) { return vaultIndex ? vaultIndex.stems.get(stem) || [] : []; },
    onAmbiguous: function (target, candidates, anchor) {
      showChooser(target, candidates, anchor);
    }
  };
}

// showStatus and showChooser are mutually exclusive. Each one clears the other.
function showStatus(message) {
  var status = document.getElementById("file-status");
  status.textContent = message;
  status.hidden = false;
  clearChooser();
}

function clearStatus() {
  var status = document.getElementById("file-status");
  status.textContent = "";
  status.hidden = true;
}

// --- the ambiguous-wikilink chooser (C3) ----------------------------------

// The link that opened the chooser. Escape gives focus back to it.
var chooserAnchor = null;

function clearChooser() {
  var chooser = document.getElementById("file-chooser");
  chooser.textContent = "";
  // The lead paragraph is gone, so the name would point at nothing.
  chooser.removeAttribute("role");
  chooser.removeAttribute("aria-labelledby");
  chooser.hidden = true;
  chooserAnchor = null;
}

// C3: two stems, one target. The reader shows every candidate and the human
// picks. A silent pick hides decay.
//
// M3: this is NOT inside #file-status. That span carries aria-live="polite",
// which would re-announce the whole chooser on every change and read each
// button twice. A span cannot hold a list either.
function showChooser(target, candidates, anchor) {
  var chooser = document.getElementById("file-chooser");
  clearStatus();
  chooser.textContent = "";
  chooser.setAttribute("role", "group");
  chooser.setAttribute("aria-labelledby", "chooser-lead");
  chooserAnchor = anchor || null;

  // CR5-2: the chooser is removed from the live region on purpose, so nothing
  // announces it. A role plus a name says what the group is, once, without
  // re-announcing it on every change.
  var lead = document.createElement("p");
  lead.className = "chooser-lead";
  lead.id = "chooser-lead";
  lead.textContent = "More than one note matches " + target + ":";
  chooser.appendChild(lead);

  var list = document.createElement("ul");
  list.className = "chooser-list";

  // P2-4: a <button> is not a valid child of a <ul>. One <li> per candidate.
  for (var i = 0; i < candidates.length; i++) {
    var item = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "chooser-choice";
    button.dataset.path = candidates[i];
    button.textContent = candidates[i];
    button.addEventListener("click", function (event) {
      // CR5-3: clearChooser empties the container under the focused button, so
      // focus would fall to <body>. Hand it to the note first.
      openFile(event.currentTarget.dataset.path);
      var title = document.getElementById("file-path");
      if (title) title.focus();
    });
    item.appendChild(button);
    list.appendChild(item);
  }

  chooser.appendChild(list);
  chooser.hidden = false;

  var first = chooser.querySelector(".chooser-choice");
  if (first) first.focus();
}

// P2-6: bound on the chooser, never on document. onSearchKeydown already owns
// Escape for the search field, and a document-level handler would fire twice.
function onChooserKeydown(event) {
  if (event.key !== "Escape") return;
  var anchor = chooserAnchor;
  clearChooser();
  if (anchor && typeof anchor.focus === "function") anchor.focus();
}

// --- images ---------------------------------------------------------------

// Its own guard: an image read touches the file system like any other read.
async function readerImageUrl(path) {
  var epoch = readerEpoch;

  if (!(await readerGuard())) throw new Error("The vault is not readable.");

  var file = await vaultGetFile(vaultHandle, path);
  var url = URL.createObjectURL(file);

  // The reader moved to another note while this file loaded. Drop the URL
  // rather than leak it.
  if (epoch !== readerEpoch) {
    URL.revokeObjectURL(url);
    throw new Error("The note changed.");
  }

  readerImageUrls.push(url);
  return url;
}

function revokeImageUrls() {
  for (var i = 0; i < readerImageUrls.length; i++) URL.revokeObjectURL(readerImageUrls[i]);
  readerImageUrls = [];
}

function clearContentPane() {
  readerEpoch++;
  revokeImageUrls();

  readerPath = null;
  readerText = null;
  readerView = "rendered";

  document.getElementById("file-path").textContent = "";
  document.getElementById("file-rendered").textContent = "";
  document.getElementById("file-raw").textContent = "";
  document.getElementById("file-raw").hidden = true;
  document.getElementById("file-rendered").hidden = false;
  document.getElementById("btn-view").hidden = true;
  document.getElementById("btn-view").textContent = "Raw";
  paintFrontmatter([]);
  paintToc();
  clearStatus();
  paintBacklinks();
}

// Runs its own guard. Permission can drop between the walk and the restore.
async function restoreLastFile() {
  var stored;
  try {
    stored = await chrome.storage.local.get("lastFile");
  } catch (err) {
    return;
  }

  var path = stored ? stored.lastFile : undefined;
  if (path === undefined) return;

  // vaultIsValidStoredPath never throws. An invalid value is discarded, never
  // repaired.
  if (!vaultIsValidStoredPath(path) || !treeHasFile(path)) {
    await forgetLastFile();
    return;
  }

  await openFile(path);
}

async function forgetLastFile() {
  try {
    await chrome.storage.local.remove("lastFile");
  } catch (err) {
    // Nothing to recover. The value is discarded either way.
  }
}

// --- the vault index ------------------------------------------------------

// D-CR-010: the index is built from the vault's own Markdown, at vault-open
// time. No PKMS artifact is read. It lives in page memory and dies with the tab.
//
// This function never throws and is never awaited. A slow index must not hold
// the tree, the open note, or the Raw toggle.
async function buildVaultIndex() {
  var epoch = ++indexEpoch;
  vaultIndex = null;
  indexState = "building";
  paintSearchState();
  paintBacklinks();

  if (!(await readerGuard())) {
    finishIndex(epoch, null, "unavailable");
    return;
  }

  var paths = vaultListMdFiles(vaultTree);
  var entries = [];
  var stored = 0;

  for (var i = 0; i < paths.length; i++) {
    // S3-3: the vault changed under this build. Stop reading rather than finish
    // work that is already discarded.
    if (epoch !== indexEpoch) return;

    var text = null;
    try {
      var file = await vaultGetFile(vaultHandle, paths[i]);
      // Both caps are measured in bytes, so the decision never mixes units with
      // the string length that comes back.
      if (file.size <= INDEX_FILE_TEXT_CAP && stored + file.size <= INDEX_TOTAL_TEXT_CAP) {
        text = await file.text();
        stored += file.size;
      }
    } catch (err) {
      // Permission dropped mid-build. Every later read would fail the same way.
      if (err && err.name === "NotAllowedError") {
        finishIndex(epoch, null, "unavailable");
        return;
      }
      // Any other failure skips this note. It is counted, never silent.
      text = null;
    }

    entries.push({ path: paths[i], text: text });
  }

  finishIndex(epoch, indexBuild(entries), "ready");
}

function finishIndex(epoch, index, state) {
  if (epoch !== indexEpoch) return;
  vaultIndex = index;
  indexState = state;
  paintSearchState();
  paintBacklinks();
  repaintForIndex();
}

// C8: a note opened before the index was ready holds inert literals. Repaint it
// the moment the index lands, so the literals become live wikilinks.
//
// m2: paintContent calls renderMarkdown, which empties the container first.
// #file-body then clamps scrollTop to 0 before the new content arrives, and the
// reader loses their place about two seconds into a session. Save and restore.
function repaintForIndex() {
  if (readerView !== "rendered") return;
  if (typeof readerText !== "string") return;

  // Nothing to repaint when the note holds no wikilink.
  WIKI_RE.lastIndex = 0;
  if (WIKI_RE.exec(readerText) === null) return;
  WIKI_RE.lastIndex = 0;

  // CR5-4: paintContent destroys the link that opened an open chooser, and its
  // candidates came from the index this repaint replaces.
  clearChooser();

  var body = document.getElementById("file-body");
  var top = body.scrollTop;
  paintContent();
  body.scrollTop = top;
}

// --- backlinks ------------------------------------------------------------

// createElement + textContent, like every other vault-fed surface.
function paintBacklinks() {
  var section = document.getElementById("backlinks");
  var note = document.getElementById("backlinks-note");
  var list = document.getElementById("backlinks-list");

  list.textContent = "";

  if (readerPath === null) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  if (indexState === "building") {
    showBacklinksNote(note, "Indexing\u2026");
    return;
  }
  if (!vaultIndex) {
    showBacklinksNote(note, "Backlinks unavailable \u2014 reopen the vault.");
    return;
  }

  var sources = vaultIndex.backlinks.get(readerPath);
  if (!sources || sources.length === 0) {
    showBacklinksNote(note, "No notes link here.");
    return;
  }

  note.hidden = true;
  for (var i = 0; i < sources.length; i++) {
    var item = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "backlink";
    button.textContent = sources[i];
    button.dataset.path = sources[i];
    button.addEventListener("click", onBacklinkClick);
    item.appendChild(button);
    list.appendChild(item);
  }
}

function showBacklinksNote(note, message) {
  note.textContent = message;
  note.hidden = false;
}

function onBacklinkClick(event) {
  openFile(event.currentTarget.dataset.path);
}

// --- search ---------------------------------------------------------------

// The field is usable only when the index is. Its placeholder says which state
// the reader is in, so a disabled box never looks like a broken one.
function paintSearchState() {
  var input = document.getElementById("search-input");

  if (indexState === "building") {
    input.disabled = true;
    input.placeholder = "Indexing\u2026";
    return;
  }
  if (!vaultIndex) {
    input.disabled = true;
    input.placeholder = "Search unavailable";
    return;
  }
  input.disabled = false;
  input.placeholder = "Search";
}

function onSearchInput() {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    searchTimer = null;
    runSearch();
  }, 150);
}

function onSearchKeydown(event) {
  if (event.key !== "Escape") return;
  event.currentTarget.value = "";
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = null;
  runSearch();
}

function clearSearch() {
  document.getElementById("search-input").value = "";
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = null;
  runSearch();
}

function runSearch() {
  var results = indexSearch(vaultIndex, document.getElementById("search-input").value);
  var pane = document.getElementById("search-results");
  var tree = document.getElementById("tree");

  if (results === null) {
    pane.textContent = "";
    pane.hidden = true;
    tree.hidden = false;
    return;
  }

  paintSearchResults(pane, results);
  pane.hidden = false;
  tree.hidden = true;
}

function paintSearchResults(pane, results) {
  pane.textContent = "";

  // S3-5: the count is spoken. A screen-reader user gets the outcome without
  // walking the list first.
  var count = document.createElement("p");
  count.className = "result-count";
  count.setAttribute("aria-live", "polite");
  count.textContent = searchCountLabel(results.length, results.truncated);
  pane.appendChild(count);

  for (var i = 0; i < results.length; i++) {
    pane.appendChild(buildResult(results[i]));
  }
}

// C3-3: the cap is a ceiling, not a count. The flag says whether the list was
// really cut; an exact hundred matches is not.
function searchCountLabel(found, truncated) {
  if (found === 0) return "No matches";
  var label = found === 1 ? "1 note" : found + " notes";
  return truncated ? label + " \u00b7 list cut at " + INDEX_RESULT_CAP : label;
}

function buildResult(result) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = "result";
  button.dataset.path = result.path;
  button.addEventListener("click", onResultClick);

  var path = document.createElement("span");
  path.className = "result-path";
  path.textContent = result.path;
  button.appendChild(path);

  for (var i = 0; i < result.snippets.length; i++) {
    var snippet = result.snippets[i];
    var line = document.createElement("span");
    line.className = "result-snippet";
    line.appendChild(document.createTextNode(snippet.before));

    var hit = document.createElement("span");
    hit.className = "hit";
    hit.textContent = snippet.match;
    line.appendChild(hit);

    line.appendChild(document.createTextNode(snippet.after));
    button.appendChild(line);
  }

  return button;
}

function onResultClick(event) {
  // The query stays, so the list survives for the next pick.
  openFile(event.currentTarget.dataset.path);
}

// --- handlers -------------------------------------------------------------

function wireHandlers() {
  document.getElementById("btn-grant").addEventListener("click", pickVault);
  document.getElementById("btn-change-vault").addEventListener("click", pickVault);
  document.getElementById("btn-reopen-pick").addEventListener("click", pickVault);
  document.getElementById("btn-error-pick").addEventListener("click", pickVault);
  document.getElementById("btn-reopen").addEventListener("click", reopenVault);
  document.getElementById("btn-view").addEventListener("click", toggleView);
  document.getElementById("btn-frontmatter").addEventListener("click", toggleFrontmatter);
  document.getElementById("btn-toc").addEventListener("click", toggleToc);
  document.getElementById("btn-theme").addEventListener("click", cycleTheme);
  document.getElementById("btn-tree-toggle").addEventListener("click", onTreeToggleClick);
  chrome.runtime.onMessage.addListener(onWorkerMessage);
  document.getElementById("search-input").addEventListener("input", onSearchInput);
  document.getElementById("search-input").addEventListener("keydown", onSearchKeydown);
  document.getElementById("file-chooser").addEventListener("keydown", onChooserKeydown);
  initSidebar();
  initTheme();
  restoreUi();
}

// The layout is restored after the read answers, not before. initSidebar() has
// already wired the controls; this only puts the stored values into them.
var readerSidebarRestore = null;

async function restoreUi() {
  await uiReady();
  if (readerSidebarRestore) readerSidebarRestore();
}

// --- remembered layout ----------------------------------------------------

// One key beside `theme` in chrome.storage.local, the store that already holds
// `lastFile`. D-CR-014: a new key is not a new store.
// One read, shared. enterMain() awaits it before rendering the tree, so the
// remembered folders can never lose a race with the vault walk.
var readerUiReady = null;

function uiReady() {
  if (!readerUiReady) readerUiReady = loadUi();
  return readerUiReady;
}

async function loadUi() {
  try {
    var stored = await chrome.storage.local.get("ui");
    var value = stored ? stored.ui : undefined;
    if (value && typeof value === "object") {
      if (typeof value.sidebarWidth === "number") readerUi.sidebarWidth = value.sidebarWidth;
      readerUi.sidebarHidden = value.sidebarHidden === true;
      if (value.openFolders && typeof value.openFolders === "object") {
        // C4-1: the stored object arrives with a normal prototype, so assigning
        // it straight through would reintroduce the defect on every load.
        // Object.keys returns own enumerable keys alone, so a stored __proto__
        // is copied as ordinary data.
        var safe = Object.create(null);
        var keys = Object.keys(value.openFolders);
        for (var i = 0; i < keys.length; i++) {
          var list = value.openFolders[keys[i]];
          if (Array.isArray(list)) safe[keys[i]] = list;
        }
        readerUi.openFolders = safe;
      }
    }
  } catch (err) {
    // The defaults stand. A preference that fails to load is not an error the
    // reader reports; it just behaves as a first run.
  }
  readerUiLoaded = true;
}

// Never write before the load has answered, or a slow read would overwrite the
// stored value with the defaults.
async function storeUi() {
  if (!readerUiLoaded) return;
  try {
    await chrome.storage.local.set({ ui: readerUi });
  } catch (err) {
    // The choice still holds for this session.
  }
}

// A vault is identified by its folder name, which is all a directory handle
// offers. Two vaults with the same folder name share a set; the worst outcome
// is the wrong folders open, so the collision is not worth a migration.
function vaultKey() {
  return vaultHandle && vaultHandle.name ? vaultHandle.name : "";
}

function openFolderSet() {
  var key = vaultKey();
  var list = readerUi.openFolders[key];
  return Array.isArray(list) ? list : null;
}

function rememberFolder(path, open) {
  var key = vaultKey();
  if (!key) return;

  var list = readerUi.openFolders[key];
  if (!Array.isArray(list)) list = [];

  var at = list.indexOf(path);
  if (open && at === -1) list.push(path);
  else if (!open && at !== -1) list.splice(at, 1);
  else return;

  readerUi.openFolders[key] = list;
  storeUi();
}

// Read every open folder out of the DOM and store the set in one write. The
// only writer of openFolders[key] besides rememberFolder().
function rememberOpenFolders() {
  var key = vaultKey();
  if (!key) return;

  var folders = document.querySelectorAll("#tree details");
  var paths = [];
  for (var i = 0; i < folders.length; i++) {
    if (folders[i].open && folders[i].dataset.path) paths.push(folders[i].dataset.path);
  }

  readerUi.openFolders[key] = paths;
  storeUi();
}

// --- the theme ------------------------------------------------------------

// One control, three states, cycled in the order a reader reaches for: follow
// the system, force light, force dark, back to the system.
var READER_THEME_ORDER = ["system", "light", "dark"];

function systemPrefersDark() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (err) {
    return false;
  }
}

// The attribute is always light or dark, never "system". CSS reads a resolved
// answer, so it needs one dark block instead of one per source of the choice.
function applyTheme() {
  var dark = readerTheme === "dark" || (readerTheme === "system" && systemPrefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  syncThemeTool(dark);
}

function syncThemeTool(dark) {
  var tool = document.getElementById("btn-theme");
  if (!tool) return;

  // Pressed means the reader overrode the system, not "dark is on".
  tool.setAttribute("aria-pressed", readerTheme === "system" ? "false" : "true");

  // In system mode the label reports what the browser actually says. That is
  // the difference between "the setting is ignored" and "the browser reads it
  // as light", and only the tooltip can tell them apart.
  labelTool(tool, readerTheme === "system"
    ? "Theme: follow the system (now " + (dark ? "dark" : "light") + ")"
    : "Theme: " + readerTheme);
}

function cycleTheme() {
  var next = READER_THEME_ORDER.indexOf(readerTheme) + 1;
  readerTheme = READER_THEME_ORDER[next % READER_THEME_ORDER.length];
  applyTheme();
  storeTheme();
}

async function storeTheme() {
  try {
    await chrome.storage.local.set({ theme: readerTheme });
  } catch (err) {
    // The choice still holds for this session. It is a preference, not state.
  }
}

async function initTheme() {
  try {
    var stored = await chrome.storage.local.get("theme");
    var value = stored ? stored.theme : undefined;
    if (READER_THEME_ORDER.indexOf(value) !== -1) readerTheme = value;
  } catch (err) {
    // Fall through on "system".
  }

  applyTheme();

  // The system can change while the tab is open. Follow it, but only while the
  // reader has not overridden it.
  try {
    var query = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () {
      if (readerTheme === "system") applyTheme();
    };
    if (query.addEventListener) query.addEventListener("change", onChange);
    else if (query.addListener) query.addListener(onChange);
  } catch (err) {
    // No listener. The stamp from theme.js still stands.
  }
}

// --- the tree pane: hide it, or drag it wider -----------------------------

// Width lives in a CSS variable on #panes, so the pane and the drag handle read
// one value. Both the width and the hidden flag survive a reload.
function initSidebar() {
  var MIN = 180;
  var MAX = 560;
  var panes = document.getElementById("panes");
  var sidebar = document.getElementById("sidebar");
  var resizer = document.getElementById("sidebar-resizer");
  var toggle = document.getElementById("btn-sidebar");

  function currentWidth() {
    return sidebar.getBoundingClientRect().width;
  }

  // Clamping on the way in means a stored width from a wider window, or a
  // hand-edited value, can never leave the pane unusable.
  function setWidth(px) {
    var w = Math.round(Math.min(MAX, Math.max(MIN, px)));
    panes.style.setProperty("--sidebar-width", w + "px");
    return w;
  }

  function applyHidden(hidden) {
    panes.classList.toggle("sidebar-hidden", hidden);
    toggle.setAttribute("aria-expanded", hidden ? "false" : "true");
    labelTool(toggle, hidden ? "Show the file tree" : "Hide the file tree");
  }

  readerSidebarRestore = function () {
    if (typeof readerUi.sidebarWidth === "number") setWidth(readerUi.sidebarWidth);
    applyHidden(readerUi.sidebarHidden);
  };

  toggle.addEventListener("click", function () {
    readerUi.sidebarHidden = !panes.classList.contains("sidebar-hidden");
    applyHidden(readerUi.sidebarHidden);
    storeUi();
  });

  resizer.addEventListener("pointerdown", function (ev) {
    ev.preventDefault();
    var startX = ev.clientX;
    var startW = currentWidth();

    function onMove(e) {
      setWidth(startW + (e.clientX - startX));
    }

    // The width is written once, when the drag ends. A write per pointermove
    // would hit storage sixty times a second for one decision.
    function onUp(e) {
      resizer.releasePointerCapture(e.pointerId);
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      resizer.removeEventListener("pointercancel", onUp);
      readerUi.sidebarWidth = Math.round(currentWidth());
      storeUi();
    }

    resizer.setPointerCapture(ev.pointerId);
    resizer.classList.add("dragging");
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  });

  // The handle is a separator, so the arrow keys move it. A pointer is not the
  // only way to reach it.
  resizer.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowLeft") {
      readerUi.sidebarWidth = setWidth(currentWidth() - 16);
      storeUi();
      ev.preventDefault();
    } else if (ev.key === "ArrowRight") {
      readerUi.sidebarWidth = setWidth(currentWidth() + 16);
      storeUi();
      ev.preventDefault();
    }
  });
}

// One handler behind three controls: Grant vault, Change vault, Pick a different
// folder, Pick vault folder again (D-CR-006).
async function pickVault() {
  var handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "read" });
  } catch (err) {
    // The user cancelled. Stay where we are, show no error.
    if (err && err.name === "AbortError") return;
    showVaultError(err, "Chrome could not open the folder picker");
    return;
  }

  vaultHandle = handle;

  try {
    await idbPutHandle(handle);
  } catch (err) {
    showVaultError(err);
    return;
  }

  // The stored path belongs to the old vault. Drop it rather than test it
  // against a different tree.
  await forgetLastFile();
  clearContentPane();
  clearSearch();

  await enterMain();
}

// Must run inside the click handler: requestPermission needs a user gesture.
async function reopenVault() {
  document.getElementById("reopen-note").hidden = true;

  var state;
  try {
    state = await vaultRequestPermission(vaultHandle);
  } catch (err) {
    document.getElementById("reopen-note").hidden = false;
    return;
  }

  if (state === "granted") {
    await enterMain();
    return;
  }

  document.getElementById("reopen-note").hidden = false;
}
