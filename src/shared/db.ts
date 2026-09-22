import type { InboxRecord, LedgerRecord, TweetLite } from './types';

/**
 * 扩展源的 IndexedDB。service worker 与任务页共享同一个库。
 * 句柄必须存这里 —— chrome.storage.local 只支持 JSON 可序列化值，存不了 FileSystemHandle。
 */

export const DB_NAME = 'bee-db';
export const DB_VERSION = 1;

export const STORE = {
  INBOX: 'inbox',
  TWEETS: 'tweets',
  LEDGER: 'ledger',
  KV: 'kv',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.INBOX)) {
        const s = db.createObjectStore(STORE.INBOX, { keyPath: 'seq', autoIncrement: true });
        s.createIndex('runId', 'runId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.TWEETS)) {
        db.createObjectStore(STORE.TWEETS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.LEDGER)) {
        db.createObjectStore(STORE.LEDGER, { keyPath: 'tweetId' });
      }
      if (!db.objectStoreNames.contains(STORE.KV)) {
        db.createObjectStore(STORE.KV, { keyPath: 'k' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });

  return dbPromise;
}

function request<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error(`IndexedDB ${store} 操作失败`));
      }),
  );
}

export function dbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return request<T | undefined>(store, 'readonly', (s) => s.get(key));
}

export function dbGetAll<T>(store: StoreName): Promise<T[]> {
  return request<T[]>(store, 'readonly', (s) => s.getAll());
}

export function dbGetAllFrom<T>(store: StoreName, lowerBound: number): Promise<T[]> {
  return request<T[]>(store, 'readonly', (s) =>
    s.getAll(IDBKeyRange.lowerBound(lowerBound, true)),
  );
}

export function dbCount(store: StoreName): Promise<number> {
  return request<number>(store, 'readonly', (s) => s.count());
}

export function dbPut(store: StoreName, value: unknown): Promise<IDBValidKey> {
  return request<IDBValidKey>(store, 'readwrite', (s) => s.put(value));
}

export function dbPutMany(store: StoreName, values: unknown[]): Promise<void> {
  if (values.length === 0) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        const os = t.objectStore(store);
        for (const v of values) os.put(v);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error ?? new Error(`IndexedDB ${store} 批量写入失败`));
        t.onabort = () => reject(t.error ?? new Error(`IndexedDB ${store} 批量写入被中止`));
      }),
  );
}

export function dbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  return request<undefined>(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
}

export function dbClear(store: StoreName): Promise<void> {
  return request<undefined>(store, 'readwrite', (s) => s.clear()).then(() => undefined);
}

/* ---------------- kv ---------------- */

type KvRecord<T> = { k: string; v: T };

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const rec = await dbGet<KvRecord<T>>(STORE.KV, key);
  return rec?.v;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await dbPut(STORE.KV, { k: key, v: value } satisfies KvRecord<T>);
}

/* ---------------- 语义化封装 ---------------- */

export const inbox = {
  add(rec: InboxRecord): Promise<IDBValidKey> {
    return dbPut(STORE.INBOX, rec);
  },
  since(seq: number): Promise<InboxRecord[]> {
    return dbGetAllFrom<InboxRecord>(STORE.INBOX, seq);
  },
  count(): Promise<number> {
    return dbCount(STORE.INBOX);
  },
};

export const tweets = {
  putMany(list: TweetLite[]): Promise<void> {
    return dbPutMany(STORE.TWEETS, list);
  },
  all(): Promise<TweetLite[]> {
    return dbGetAll<TweetLite>(STORE.TWEETS);
  },
  count(): Promise<number> {
    return dbCount(STORE.TWEETS);
  },
};

export const ledger = {
  get(tweetId: string): Promise<LedgerRecord | undefined> {
    return dbGet<LedgerRecord>(STORE.LEDGER, tweetId);
  },
  put(rec: LedgerRecord): Promise<IDBValidKey> {
    return dbPut(STORE.LEDGER, rec);
  },
  putMany(recs: LedgerRecord[]): Promise<void> {
    return dbPutMany(STORE.LEDGER, recs);
  },
  all(): Promise<LedgerRecord[]> {
    return dbGetAll<LedgerRecord>(STORE.LEDGER);
  },
};

const KV_ROOT_HANDLE = 'rootHandle';
const KV_LAST_CONSUMED_SEQ = 'lastConsumedSeq';
const KV_ACTIVE_RUN_ID = 'activeRunId';

export const kv = {
  getRootHandle(): Promise<FileSystemDirectoryHandle | undefined> {
    return kvGet<FileSystemDirectoryHandle>(KV_ROOT_HANDLE);
  },
  setRootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    return kvSet(KV_ROOT_HANDLE, handle);
  },
  clearRootHandle(): Promise<void> {
    return kvSet(KV_ROOT_HANDLE, undefined);
  },
  getLastConsumedSeq(): Promise<number> {
    return kvGet<number>(KV_LAST_CONSUMED_SEQ).then((v) => v ?? 0);
  },
  setLastConsumedSeq(seq: number): Promise<void> {
    return kvSet(KV_LAST_CONSUMED_SEQ, seq);
  },
  getActiveRunId(): Promise<string | undefined> {
    return kvGet<string>(KV_ACTIVE_RUN_ID);
  },
  setActiveRunId(runId: string): Promise<void> {
    return kvSet(KV_ACTIVE_RUN_ID, runId);
  },
};