// AtomicVaultReader — the directory handle store.
//
// Classic script, not an ES module. Productized from the spike fixture.
// A FileSystemDirectoryHandle is not serialisable to chrome.storage, so it lives
// in IndexedDB. One database, one store, one key.

var IDB_NAME = "vault-handle";
var IDB_STORE = "handles";
var IDB_KEY = "vault";

function idbOpen() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error);
    };
  });
}

function idbTx(db, mode, fn) {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(IDB_STORE, mode);
    var req = fn(tx.objectStore(IDB_STORE));
    if (req) req.onerror = function () { reject(req.error); };
    tx.oncomplete = function () { resolve(req ? req.result : undefined); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error); };
  });
}

async function idbPutHandle(handle) {
  var db = await idbOpen();
  return idbTx(db, "readwrite", function (store) {
    return store.put(handle, IDB_KEY);
  });
}

async function idbGetHandle() {
  var db = await idbOpen();
  var value = await idbTx(db, "readonly", function (store) {
    return store.get(IDB_KEY);
  });
  return value === undefined ? null : value;
}

async function idbClearHandle() {
  var db = await idbOpen();
  return idbTx(db, "readwrite", function (store) {
    return store.delete(IDB_KEY);
  });
}
