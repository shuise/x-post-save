// src/shared/db.ts
var DB_NAME = "bee-db";
var DB_VERSION = 1;
var STORE = {
  INBOX: "inbox",
  TWEETS: "tweets",
  LEDGER: "ledger",
  KV: "kv"
};
var dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.INBOX)) {
        const s = db.createObjectStore(STORE.INBOX, { keyPath: "seq", autoIncrement: true });
        s.createIndex("runId", "runId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.TWEETS)) {
        db.createObjectStore(STORE.TWEETS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE.LEDGER)) {
        db.createObjectStore(STORE.LEDGER, { keyPath: "tweetId" });
      }
      if (!db.objectStoreNames.contains(STORE.KV)) {
        db.createObjectStore(STORE.KV, { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB \u6253\u5F00\u5931\u8D25"));
  });
  return dbPromise;
}
function request(store, mode, fn) {
  return openDb().then(
    (db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error(`IndexedDB ${store} \u64CD\u4F5C\u5931\u8D25`));
    })
  );
}
function dbGetAllFrom(store, lowerBound) {
  return request(
    store,
    "readonly",
    (s) => s.getAll(IDBKeyRange.lowerBound(lowerBound, true))
  );
}
function dbCount(store) {
  return request(store, "readonly", (s) => s.count());
}
function dbPut(store, value) {
  return request(store, "readwrite", (s) => s.put(value));
}
var inbox = {
  add(rec) {
    return dbPut(STORE.INBOX, rec);
  },
  since(seq) {
    return dbGetAllFrom(STORE.INBOX, seq);
  },
  count() {
    return dbCount(STORE.INBOX);
  }
};

// src/shared/protocol.ts
var KIND = {
  BATCH: "BEE_BATCH",
  PAGE_EVENT: "BEE_PAGE_EVENT",
  UNLIKE_RESULT: "BEE_UNLIKE_RESULT",
  CMD: "BEE_CMD"
};
var MSG_OPEN_TASK = "BEE_OPEN_TASK";
function isRuntimeMsg(data) {
  if (typeof data !== "object" || data === null) return false;
  const m = data;
  if (m.v !== 1) return false;
  return m.kind === KIND.BATCH || m.kind === KIND.PAGE_EVENT || m.kind === KIND.UNLIKE_RESULT || m.kind === KIND.CMD;
}

// src/shared/util.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// src/background/service-worker.ts
var TASK_PAGE = "task.html";
async function notifyBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
  }
}
async function openTaskWindow() {
  const url = chrome.runtime.getURL(TASK_PAGE);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["TAB"]
  });
  const existing = contexts.find((c) => c.documentUrl?.startsWith(url));
  if (existing && typeof existing.tabId === "number" && existing.tabId >= 0) {
    try {
      await chrome.tabs.update(existing.tabId, { active: true });
      const tab = await chrome.tabs.get(existing.tabId);
      if (typeof tab.windowId === "number") {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { ok: true };
    } catch {
    }
  }
  await chrome.windows.create({
    url,
    type: "popup",
    width: 580,
    height: 780,
    focused: true
  });
  return { ok: true };
}
async function relayToTaskPages(msg) {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
  }
}
async function handleContentMessage(msg) {
  switch (msg.kind) {
    case KIND.BATCH:
      await inbox.add({
        runId: msg.runId,
        pageKey: msg.pageKey,
        tweets: msg.tweets,
        rawCount: msg.rawCount,
        receivedAt: nowIso()
      });
      await notifyBadge("\u25CF", "#f2a413");
      break;
    case KIND.PAGE_EVENT:
      if (msg.event === "caught_up" || msg.event === "unlike_finished") {
        await notifyBadge("", "#f2a413");
      } else if (msg.event === "fatal") {
        await notifyBadge("!", "#d64545");
      } else if (msg.event === "rate_limited") {
        await notifyBadge("!", "#d64545");
      }
      await relayToTaskPages(msg);
      break;
    case KIND.UNLIKE_RESULT:
      await relayToTaskPages(msg);
      break;
    case KIND.CMD:
      break;
  }
  return { ok: true };
}
async function handleMessage(message) {
  if (typeof message !== "object" || message === null) return { ok: false };
  const kind = message.kind;
  if (kind === MSG_OPEN_TASK) return openTaskWindow();
  if (isRuntimeMsg(message)) return handleContentMessage(message);
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  void notifyBadge("", "#f2a413");
});
