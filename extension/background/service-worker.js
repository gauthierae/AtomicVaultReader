// AtomicVaultReader — service worker.
//
// One job: open one reader tab, or focus the open one.
//
// D-CR-006: the worker never filters tabs by URL. chrome.tabs.query({ url })
// needs the "tabs" permission or a matching host permission, and nobody measured
// whether an extension's implicit access to its own origin satisfies it. The
// reader page reports its tab id instead, which needs no permission beyond
// "storage" and fails safely: a stale id makes tabs.update reject, and the catch
// opens a new tab.

var READER_PATH = "reader/reader.html";

chrome.action.onClicked.addListener(function () {
  openOrFocusReader();
});

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (!message || message.type !== "reader-ready") return;
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") return;
  chrome.storage.session.set({ readerTabId: sender.tab.id });
});

async function openOrFocusReader() {
  var tabId = await readStoredTabId();

  if (typeof tabId === "number") {
    try {
      var tab = await chrome.tabs.update(tabId, { active: true });
      if (tab && typeof tab.windowId === "number") {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      notifyCollapse();
      return;
    } catch (err) {
      // The tab is closed. Drop the id and fall through to create one.
      await chrome.storage.session.remove("readerTabId");
    }
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL(READER_PATH) });
}

// D-CR-017: a broadcast, never chrome.tabs.sendMessage. That call rests on the
// same unmeasured question D-CR-006 refused — whether an extension reaches its
// own pages without the "tabs" permission. A broadcast needs no permission
// beyond "storage", and Sprint 7 submits this to the store with one permission.
//
// C3: this runs on the focus path alone. A tab this worker just created builds
// its own tree and restores the last note; a collapse would race that sequence.
//
// The worker sends no reply and expects none. With no reader page open there is
// no receiver and the promise rejects, exactly as announceReaderTab() rejects in
// the other direction. That rejection is expected and carries no meaning.
function notifyCollapse() {
  try {
    var sending = chrome.runtime.sendMessage({ type: "collapse-tree" });
    if (sending && typeof sending.catch === "function") sending.catch(function () {});
  } catch (err) {
    // Nothing listens. The icon still focused the tab, which is its first job.
  }
}

async function readStoredTabId() {
  try {
    var stored = await chrome.storage.session.get("readerTabId");
    return stored ? stored.readerTabId : undefined;
  } catch (err) {
    return undefined;
  }
}
