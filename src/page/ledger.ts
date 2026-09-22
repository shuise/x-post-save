import { ledger as store } from '../shared/db';
import type { LedgerRecord, LedgerState } from '../shared/types';
import { nowIso } from '../shared/util';

/**
 * 断点续传账本。语义约定见 README 与方案：
 *   done 的判定是「md 文件写成功」，而不是「媒体下完了」。
 * 这样一来，外置盘掉线导致的写失败天然不会污染账本 —— md 没写成功，
 * 记录就停在 pending/partial，重跑会重做该条；媒体重写是幂等的。
 */

/** 单条推文最多尝试 2 次，避免坏链接被无限重试。 */
export const MAX_ATTEMPTS = 2;
/** 取消点赞最多尝试 2 次；超时未确认的项不立即重试，否则可能点成「重新点赞」。 */
export const MAX_UNLIKE_ATTEMPTS = 2;

export function newRecord(tweetId: string, runId: string): LedgerRecord {
  return {
    tweetId,
    runId,
    state: 'pending',
    mediaCount: 0,
    bytes: 0,
    attempts: 0,
    unliked: false,
    unlikeAttempts: 0,
    updatedAt: nowIso(),
  };
}

export function getRecord(tweetId: string): Promise<LedgerRecord | undefined> {
  return store.get(tweetId);
}

export function allRecords(): Promise<LedgerRecord[]> {
  return store.all();
}

export type DownloadPatch = {
  state: LedgerState;
  mdName?: string;
  mediaCount: number;
  bytes: number;
  lastError?: string;
};

export async function recordDownload(
  tweetId: string,
  runId: string,
  patch: DownloadPatch,
): Promise<LedgerRecord> {
  const prev = (await store.get(tweetId)) ?? newRecord(tweetId, runId);
  const next: LedgerRecord = {
    ...prev,
    runId,
    state: patch.state,
    attempts: prev.attempts + 1,
    mediaCount: patch.mediaCount,
    bytes: patch.bytes,
    lastError: patch.lastError,
    updatedAt: nowIso(),
    ...(patch.mdName !== undefined ? { mdName: patch.mdName } : {}),
  };
  await store.put(next);
  return next;
}

/** 目录被手工删掉了：清掉计数让它重做。 */
export async function resetForRetry(rec: LedgerRecord): Promise<LedgerRecord> {
  const next: LedgerRecord = { ...rec, state: 'pending', attempts: 0, updatedAt: nowIso() };
  await store.put(next);
  return next;
}

export async function recordUnlike(
  tweetId: string,
  ok: boolean,
  reason?: string,
): Promise<LedgerRecord | undefined> {
  const prev = await store.get(tweetId);
  if (!prev) return undefined;

  const next: LedgerRecord = {
    ...prev,
    unliked: ok,
    unlikedAt: ok ? nowIso() : prev.unlikedAt,
    unlikeAttempts: prev.unlikeAttempts + 1,
    unlikeLastError: ok ? undefined : (reason ?? 'unknown'),
    updatedAt: nowIso(),
  };
  await store.put(next);
  return next;
}

/** 只有下载成功且尚未取消的项才允许取消点赞。 */
export function unlikeCandidates(all: LedgerRecord[]): LedgerRecord[] {
  return all.filter(
    (r) => r.state === 'done' && !r.unliked && r.unlikeAttempts < MAX_UNLIKE_ATTEMPTS,
  );
}

export async function exportLedgerJson(): Promise<string> {
  const all = await store.all();
  all.sort((a, b) => a.tweetId.localeCompare(b.tweetId));
  return JSON.stringify(
    { version: 1, exportedAt: nowIso(), count: all.length, records: all },
    null,
    2,
  );
}