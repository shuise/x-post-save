import type {
  LikesPayload,
  RateLimitObservation,
  TweetLite,
  UnfavoriteResult,
} from './types';

export const PROTOCOL_VERSION = 1;

/** window.postMessage 的命名空间字段。X 页面自己也在用 postMessage，必须隔离。 */
export const BEE_NS = '__bee';

/* ------------------------------------------------------------------ *
 * MAIN world ↔ ISOLATED world（window.postMessage）
 * ------------------------------------------------------------------ */

export type WindowMsg =
  | {
      __bee: 1;
      from: 'main';
      type: 'hello';
      version: number;
      hasFetchPatch: boolean;
      hasXhrPatch: boolean;
    }
  | { __bee: 1; from: 'main'; type: 'likes_payload'; payload: LikesPayload }
  | { __bee: 1; from: 'main'; type: 'unfavorite_result'; payload: UnfavoriteResult }
  | { __bee: 1; from: 'main'; type: 'rate_limit_observed'; payload: RateLimitObservation }
  /** MAIN world 应用 set_tap 后的回执。没有回执就说明 patch 没装上，取数一定为空。 */
  | {
      __bee: 1;
      from: 'main';
      type: 'tap_ack';
      enabled: boolean;
      wantEndpoints: string[];
      hasFetchPatch: boolean;
    }
  /** 周期性的 GraphQL 观测计数，用来区分「页面没发 Likes 请求」与「发了但没解析出来」。 */
  | {
      __bee: 1;
      from: 'main';
      type: 'graphql_seen';
      payload: { total: number; likes: number; tapped: boolean };
    }
  /** 命中了 Likes 但取不到 instructions：X 改版的第一现场证据。 */
  | {
      __bee: 1;
      from: 'main';
      type: 'likes_unparsed';
      payload: { url: string; httpStatus: number; keys: string[] };
    }
  | { __bee: 1; from: 'iso'; type: 'hello_ack'; version: number }
  | { __bee: 1; from: 'iso'; type: 'set_tap'; enabled: boolean; wantEndpoints: string[] };

export function isBeeWindowMsg(data: unknown): data is WindowMsg {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m[BEE_NS] !== 1) return false;
  if (m.from !== 'main' && m.from !== 'iso') return false;
  return typeof m.type === 'string';
}

/* ------------------------------------------------------------------ *
 * 内容脚本 ↔ service worker ↔ 任务页（chrome.runtime）
 * ------------------------------------------------------------------ */

export const KIND = {
  BATCH: 'BEE_BATCH',
  PAGE_EVENT: 'BEE_PAGE_EVENT',
  UNLIKE_RESULT: 'BEE_UNLIKE_RESULT',
  CMD: 'BEE_CMD',
} as const;

/** popup 请求 service worker 打开（或聚焦）任务窗。 */
export const MSG_OPEN_TASK = 'BEE_OPEN_TASK';

export type PageEvent =
  | 'caught_up'
  | 'error_banner'
  | 'rate_limited'
  | 'nav_changed'
  | 'scan_progress'
  | 'unlike_dry_run'
  | 'unlike_finished'
  | 'fatal';

export type BeeCmd =
  | 'ping'
  | 'scan_start'
  | 'scan_pause'
  | 'scan_resume'
  | 'scan_stop'
  | 'unlike_start'
  | 'unlike_stop'
  | 'unlike_dry_run';

export type RuntimeMsg =
  | {
      v: 1;
      kind: 'BEE_BATCH';
      runId: string;
      pageKey: string;
      tweets: TweetLite[];
      rawCount: number;
    }
  | {
      v: 1;
      kind: 'BEE_PAGE_EVENT';
      runId: string;
      event: PageEvent;
      detail?: string;
      data?: Record<string, unknown>;
    }
  | {
      v: 1;
      kind: 'BEE_UNLIKE_RESULT';
      runId: string;
      tweetId: string;
      ok: boolean;
      reason?: string;
    }
  | {
      v: 1;
      kind: 'BEE_CMD';
      runId: string;
      cmd: BeeCmd;
      payload?: unknown;
    };

export function isRuntimeMsg(data: unknown): data is RuntimeMsg {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.v !== 1) return false;
  return (
    m.kind === KIND.BATCH ||
    m.kind === KIND.PAGE_EVENT ||
    m.kind === KIND.UNLIKE_RESULT ||
    m.kind === KIND.CMD
  );
}

/** unlike_start / unlike_dry_run 的 payload 形状 */
export type UnlikePayload = {
  /** 允许取消点赞的 tweetId 集合（只含下载成功的） */
  allowlist: string[];
  /** 单次运行上限 */
  budget: number;
  dryRun: boolean;
};

export function readUnlikePayload(payload: unknown): UnlikePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.allowlist)) return null;
  return {
    allowlist: p.allowlist.filter((x): x is string => typeof x === 'string'),
    budget: typeof p.budget === 'number' ? p.budget : 300,
    dryRun: p.dryRun === true,
  };
}

/* ------------------------------------------------------------------ *
 * X 接口匹配规则
 * 规则集中放在这里，X 改版时只需要改这一处。
 * ------------------------------------------------------------------ */

export type EndpointKind = 'likes' | 'unfavorite';

const GRAPHQL_MARK = '/i/api/graphql/';

export function isGraphqlRequest(url: string): boolean {
  return url.includes(GRAPHQL_MARK);
}

export function matchEndpoint(url: string): EndpointKind | null {
  if (!isGraphqlRequest(url)) return null;
  const path = url.split('?')[0] ?? '';
  if (/\/Likes$/i.test(path)) return 'likes';
  if (/\/UnfavoriteTweet$/i.test(path)) return 'unfavorite';
  return null;
}