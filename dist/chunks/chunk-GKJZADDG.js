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
function dbGet(store, key) {
  return request(store, "readonly", (s) => s.get(key));
}
function dbGetAll(store) {
  return request(store, "readonly", (s) => s.getAll());
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
function dbPutMany(store, values) {
  if (values.length === 0) return Promise.resolve();
  return openDb().then(
    (db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, "readwrite");
      const os = t.objectStore(store);
      for (const v of values) os.put(v);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error(`IndexedDB ${store} \u6279\u91CF\u5199\u5165\u5931\u8D25`));
      t.onabort = () => reject(t.error ?? new Error(`IndexedDB ${store} \u6279\u91CF\u5199\u5165\u88AB\u4E2D\u6B62`));
    })
  );
}
async function kvGet(key) {
  const rec = await dbGet(STORE.KV, key);
  return rec?.v;
}
async function kvSet(key, value) {
  await dbPut(STORE.KV, { k: key, v: value });
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
var tweets = {
  putMany(list) {
    return dbPutMany(STORE.TWEETS, list);
  },
  all() {
    return dbGetAll(STORE.TWEETS);
  },
  count() {
    return dbCount(STORE.TWEETS);
  }
};
var ledger = {
  get(tweetId) {
    return dbGet(STORE.LEDGER, tweetId);
  },
  put(rec) {
    return dbPut(STORE.LEDGER, rec);
  },
  putMany(recs) {
    return dbPutMany(STORE.LEDGER, recs);
  },
  all() {
    return dbGetAll(STORE.LEDGER);
  }
};
var KV_ROOT_HANDLE = "rootHandle";
var KV_LAST_CONSUMED_SEQ = "lastConsumedSeq";
var KV_ACTIVE_RUN_ID = "activeRunId";
var kv = {
  getRootHandle() {
    return kvGet(KV_ROOT_HANDLE);
  },
  setRootHandle(handle) {
    return kvSet(KV_ROOT_HANDLE, handle);
  },
  clearRootHandle() {
    return kvSet(KV_ROOT_HANDLE, void 0);
  },
  getLastConsumedSeq() {
    return kvGet(KV_LAST_CONSUMED_SEQ).then((v) => v ?? 0);
  },
  setLastConsumedSeq(seq) {
    return kvSet(KV_LAST_CONSUMED_SEQ, seq);
  },
  getActiveRunId() {
    return kvGet(KV_ACTIVE_RUN_ID);
  },
  setActiveRunId(runId) {
    return kvSet(KV_ACTIVE_RUN_ID, runId);
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

// src/shared/paths.ts
var TIME_ZONE = "Asia/Shanghai";
var TZ_OFFSET = "+08:00";
var CHECK_FILE = ".bee-check";
var LIKES_PAGE_PATH = "/i/history/likes";
var BEE_DIR = "_bee";
var ASSETS_DIR = "assets";
var LEDGER_FILE = "ledger.json";
var REPORT_FILE = "report.json";
var SKIP_FILE = "skipped.md";
var UNPARSED_FILE = "unparsed.json";
var MD_BASE_MAX = 60;
var dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
var timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});
function part(parts, type) {
  return parts.find((p) => p.type === type)?.value ?? "";
}
function localDateStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "0000-00-00";
  const p = dateFmt.formatToParts(d);
  return `${part(p, "year")}-${part(p, "month")}-${part(p, "day")}`;
}
function localIsoWithOffset(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = timeFmt.formatToParts(d);
  const date = localDateStamp(iso);
  return `${date}T${part(p, "hour")}:${part(p, "minute")}:${part(p, "second")}${TZ_OFFSET}`;
}
function mdBaseName(tweet) {
  const first = tweet.text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const cleaned = first.replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}\s_-]/gu, " ").replace(/[\s_]+/g, " ").trim();
  const capped = [...cleaned].slice(0, MD_BASE_MAX).join("").trim();
  return capped.length > 0 ? capped : `${localDateStamp(tweet.createdAt)}_${tweet.id}`;
}
function mdFileName(tweet, taken) {
  const base = mdBaseName(tweet);
  const first = `${base}.md`;
  return taken.has(first) ? `${base}_${tweet.id}.md` : first;
}
function mediaFileName(tweetId, index, ext) {
  return `${tweetId}_${index + 1}.${ext}`;
}
function posterFileName(tweetId, index, ext) {
  return `${tweetId}_${index + 1}_poster.${ext}`;
}
function extFromUrl(url, fallback = "jpg") {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop() ?? "";
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(last);
    if (m?.[1]) return m[1].toLowerCase();
    const fmt = u.searchParams.get("format");
    if (fmt && /^[A-Za-z0-9]{2,5}$/.test(fmt)) return fmt.toLowerCase();
  } catch {
  }
  return fallback;
}
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// src/shared/util.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// src/page/ledger.ts
var MAX_ATTEMPTS = 2;
var MAX_UNLIKE_ATTEMPTS = 2;
function newRecord(tweetId, runId) {
  return {
    tweetId,
    runId,
    state: "pending",
    mediaCount: 0,
    bytes: 0,
    attempts: 0,
    unliked: false,
    unlikeAttempts: 0,
    updatedAt: nowIso()
  };
}
function getRecord(tweetId) {
  return ledger.get(tweetId);
}
function allRecords() {
  return ledger.all();
}
async function recordDownload(tweetId, runId, patch) {
  const prev = await ledger.get(tweetId) ?? newRecord(tweetId, runId);
  const next = {
    ...prev,
    runId,
    state: patch.state,
    attempts: prev.attempts + 1,
    mediaCount: patch.mediaCount,
    bytes: patch.bytes,
    lastError: patch.lastError,
    updatedAt: nowIso(),
    ...patch.mdName !== void 0 ? { mdName: patch.mdName } : {}
  };
  await ledger.put(next);
  return next;
}
async function resetForRetry(rec) {
  const next = { ...rec, state: "pending", attempts: 0, updatedAt: nowIso() };
  await ledger.put(next);
  return next;
}
async function recordUnlike(tweetId, ok, reason) {
  const prev = await ledger.get(tweetId);
  if (!prev) return void 0;
  const next = {
    ...prev,
    unliked: ok,
    unlikedAt: ok ? nowIso() : prev.unlikedAt,
    unlikeAttempts: prev.unlikeAttempts + 1,
    unlikeLastError: ok ? void 0 : reason ?? "unknown",
    updatedAt: nowIso()
  };
  await ledger.put(next);
  return next;
}
function unlikeCandidates(all) {
  return all.filter(
    (r) => r.state === "done" && !r.unliked && r.unlikeAttempts < MAX_UNLIKE_ATTEMPTS
  );
}
async function exportLedgerJson() {
  const all = await ledger.all();
  all.sort((a, b) => a.tweetId.localeCompare(b.tweetId));
  return JSON.stringify(
    { version: 1, exportedAt: nowIso(), count: all.length, records: all },
    null,
    2
  );
}

export {
  inbox,
  tweets,
  kv,
  KIND,
  MSG_OPEN_TASK,
  isRuntimeMsg,
  CHECK_FILE,
  LIKES_PAGE_PATH,
  BEE_DIR,
  ASSETS_DIR,
  LEDGER_FILE,
  REPORT_FILE,
  SKIP_FILE,
  UNPARSED_FILE,
  localIsoWithOffset,
  mdFileName,
  mediaFileName,
  posterFileName,
  extFromUrl,
  humanBytes,
  sleep,
  nowIso,
  errorMessage,
  MAX_ATTEMPTS,
  getRecord,
  allRecords,
  recordDownload,
  resetForRetry,
  recordUnlike,
  unlikeCandidates,
  exportLedgerJson
};
