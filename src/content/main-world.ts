import {
  BEE_NS,
  PROTOCOL_VERSION,
  isBeeWindowMsg,
  isGraphqlRequest,
  matchEndpoint,
  type EndpointKind,
} from '../shared/protocol';
import { extractInstructions, pageKeyFrom } from '../shared/tweet-parse';

/**
 * MAIN world 脚本。
 *
 * 职责被刻意压到最小：只 patch fetch/XHR、把命中的响应原样搬运给 isolated world、
 * 并上报 UnfavoriteTweet 的结果。这里不做任何解析、不发 chrome.* 消息
 * （Chrome 111 起 chrome.runtime 在 MAIN world 已彻底 undefined）。
 *
 * 三个必须守住的坑：
 *   1. 必须 res.clone() 后在分离的 async 任务里读，绝不能读完再还给页面，
 *      否则页面自己的 .json() 会抛 "body already read"。
 *   2. 所有 patch 全包 try/catch，任何异常都不能影响页面。
 *   3. 只对命中规则的 URL 读 body，否则会去读图片/视频响应，直接炸内存。
 */

type Json = any;

declare global {
  interface XMLHttpRequest {
    /** patch 后的 XHR 上挂载的请求 URL，供 send 阶段判断是否需要读响应 */
    __beeUrl?: string;
  }
}

/**
 * 默认就打开 likes 的监听。
 *
 * 这是必须的：点赞页首次打开时页面自己会发一次 Likes 请求，那一页正好是列表最顶部，
 * 如果等用户点「开始扫描」才打开监听，这一页永远抓不到（X 只在滚动时才带 cursor 再发请求）。
 * 监听开关只决定要不要去读响应体，是否入库由 isolated world 的 scan.active 决定。
 */
const patchedKinds = new Set<EndpointKind>(['likes']);

/** 观测计数：用来区分「页面压根没发 Likes」和「发了但解析不出来」。 */
let gqlTotal = 0;
let gqlLikes = 0;
let reportedTotal = -1;
let reportedLikes = -1;

function post(msg: Record<string, unknown>): void {
  try {
    window.postMessage({ [BEE_NS]: 1, ...msg }, location.origin);
  } catch {
    /* postMessage 失败不影响页面 */
  }
}

function postLikes(url: string, httpStatus: number, pageKey: string, instructions: unknown[]): void {
  post({ from: 'main', type: 'likes_payload', payload: { url, httpStatus, pageKey, instructions } });
}

function postUnfavorite(
  tweetId: string,
  ok: boolean,
  httpStatus: number,
  bodyCode?: number,
  retryAfterMs?: number,
  bodyPreview?: string,
): void {
  post({
    from: 'main',
    type: 'unfavorite_result',
    payload: {
      tweetId,
      ok,
      httpStatus,
      ...(bodyCode !== undefined ? { bodyCode } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(bodyPreview ? { bodyPreview } : {}),
    },
  });
}

function postRateLimit(url: string, httpStatus: number, resetAtMs?: number): void {
  post({
    from: 'main',
    type: 'rate_limit_observed',
    payload: {
      httpStatus,
      ...(resetAtMs !== undefined ? { resetAtMs } : {}),
      endpoint: url.split('?')[0] ?? url,
    },
  });
}

function postLikesUnparsed(url: string, httpStatus: number, data: unknown): void {
  const d = data as Json;
  const inner = d?.data;
  const keys = [
    ...Object.keys(typeof d === 'object' && d !== null ? d : {}).map((k) => `root.${k}`),
    ...Object.keys(typeof inner === 'object' && inner !== null ? inner : {}).map((k) => `data.${k}`),
  ].slice(0, 20);
  post({ from: 'main', type: 'likes_unparsed', payload: { url, httpStatus, keys } });
}

/**
 * 记一次 GraphQL 观测。
 * 返回命中的端点和是否已打开监听 —— 没打开监听时只计数、不读响应体。
 */
function trackRequest(url: string | null): { kind: EndpointKind | null; tapped: boolean } {
  if (!url || !isGraphqlRequest(url)) return { kind: null, tapped: false };
  gqlTotal++;
  const kind = matchEndpoint(url);
  if (kind === 'likes') gqlLikes++;
  return { kind, tapped: kind !== null && patchedKinds.has(kind) };
}

/** 每 5 秒把「看到了多少 GraphQL / 多少 Likes」上报一次，只在数字变化时发。 */
function startSightingsReporter(): void {
  window.setInterval(() => {
    try {
      if (gqlTotal === reportedTotal && gqlLikes === reportedLikes) return;
      reportedTotal = gqlTotal;
      reportedLikes = gqlLikes;
      post({
        from: 'main',
        type: 'graphql_seen',
        payload: { total: gqlTotal, likes: gqlLikes, tapped: patchedKinds.has('likes') },
      });
    } catch {
      /* ignore */
    }
  }, 5000);
}

/* ---------- 请求 / 响应工具 ---------- */

function urlOf(input: unknown): string | null {
  try {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  } catch {
    /* ignore */
  }
  return null;
}

/** 在调用真正的 fetch 之前同步启动，Request 的 clone() 必须抢在 body 被消费前。 */
async function readRequestBody(input: unknown, init: RequestInit | undefined): Promise<unknown> {
  try {
    const body = init?.body;
    if (typeof body === 'string') return JSON.parse(body);
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return Object.fromEntries(body);
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      const text = await input.clone().text();
      return text ? JSON.parse(text) : undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function tweetIdFromBody(body: unknown): string | null {
  const b = body as Json;
  const v = b?.variables;
  const id = v?.tweet_id ?? v?.tweetId ?? b?.tweet_id;
  return id === undefined || id === null ? null : String(id);
}

function graphqlErrorMessage(data: unknown): number | undefined {
  const errors = (data as Json)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const code = (errors[0] as Json)?.code;
  return typeof code === 'number' ? code : undefined;
}

function resetAtFrom(res: Response): number | undefined {
  try {
    const reset = res.headers.get('x-rate-limit-reset');
    if (!reset) return undefined;
    const sec = Number(reset);
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/* ---------- Likes 响应处理 ---------- */

async function handleLikes(res: Response, url: string, bodyPromise: Promise<unknown>): Promise<void> {
  const copy = res.clone();
  const text = await copy.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }

  const instructions = extractInstructions(data);
  if (!instructions) {
    // 静默丢弃会让「扫不到数据」无从定位，所以把顶层键带出去。
    postLikesUnparsed(url, res.status, data);
    return;
  }

  const body = await bodyPromise;
  postLikes(url, res.status, pageKeyFrom(url, body), instructions);
}

/* ---------- UnfavoriteTweet 响应处理 ---------- */

async function handleUnfavorite(res: Response, bodyPromise: Promise<unknown>): Promise<void> {
  const body = await bodyPromise;
  const tweetId = tweetIdFromBody(body);
  if (!tweetId) return;

  const resetAtMs = resetAtFrom(res);
  if (res.status === 429) {
    postUnfavorite(tweetId, false, res.status, 88, resetAtMs);
    return;
  }

  const copy = res.clone();
  const text = await copy.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    postUnfavorite(tweetId, res.ok, res.status, undefined, undefined, text.slice(0, 200));
    return;
  }

  const code = graphqlErrorMessage(data);
  if (code === 88) {
    postUnfavorite(tweetId, false, res.status, 88, resetAtMs, text.slice(0, 200));
    return;
  }

  if (!res.ok || code !== undefined) {
    postUnfavorite(tweetId, false, res.status, code, resetAtMs, text.slice(0, 200));
    return;
  }

  // 成功响应的确切字段名在阶段 0 用真实抓包确认；这里同时兼容两种可能。
  const d = (data as Json)?.data;
  const done = d?.unfavorite_tweet === 'Done' || d?.unfavorite_tweet === 'done' || Boolean(d);
  postUnfavorite(tweetId, done, res.status);
}

/* ---------- patch ---------- */

function patchFetch(): boolean {
  const original = window.fetch;
  if (typeof original !== 'function') return false;

  window.fetch = function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url: string | null = null;
    let kind: EndpointKind | null = null;
    let bodyPromise: Promise<unknown> | null = null;

    try {
      url = urlOf(input);
      const seen = trackRequest(url);
      kind = seen.tapped ? seen.kind : null;
      if (kind) {
        // clone() 必须在原始 fetch 真正消费 body 之前同步发起
        bodyPromise = readRequestBody(input, init);
      }
    } catch {
      kind = null;
    }

    const promise = original.call(window, input, init);

    try {
      if (kind && bodyPromise) {
        const activeKind = kind;
        const activeBody = bodyPromise;
        const activeUrl = url ?? '';
        promise
          .then((res) => {
            if (res.status === 429) postRateLimit(activeUrl, res.status, resetAtFrom(res));
            return activeKind === 'likes'
              ? handleLikes(res, activeUrl, activeBody)
              : handleUnfavorite(res, activeBody);
          })
          .catch(() => {
            /* 任何异常都不能冒泡到页面 */
          });
      } else if (url && isGraphqlRequest(url)) {
        const activeUrl = url;
        promise
          .then((res) => {
            if (res.status === 429) postRateLimit(activeUrl, res.status, resetAtFrom(res));
          })
          .catch(() => {
            /* ignore */
          });
      }
    } catch {
      /* ignore */
    }

    return promise;
  };

  return true;
}

function patchXhr(): boolean {
  const proto = XMLHttpRequest.prototype as Json;
  const origOpen = proto.open as (...args: Json[]) => void;
  const origSend = proto.send as (...args: Json[]) => void;
  if (typeof origOpen !== 'function' || typeof origSend !== 'function') return false;

  proto.open = function patchedOpen(this: XMLHttpRequest, ...args: Json[]): void {
    try {
      const target = args[1];
      this.__beeUrl = typeof target === 'string' ? target : String(target);
    } catch {
      /* ignore */
    }
    return origOpen.apply(this, args);
  };

  proto.send = function patchedSend(this: XMLHttpRequest, ...args: Json[]): void {
    try {
      const url = this.__beeUrl as string | undefined;
      const seen = trackRequest(url ?? null);
      if (seen.tapped && seen.kind) {
        const kind = seen.kind;
        const bodyPromise = Promise.resolve(parseMaybeJson(args[0]));
        this.addEventListener('loadend', () => {
          void handleXhr(this, url ?? '', kind, bodyPromise);
        });
      }
    } catch {
      /* ignore */
    }
    return origSend.apply(this, args);
  };

  return true;
}

function parseMaybeJson(body: unknown): unknown {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function handleXhr(
  xhr: XMLHttpRequest,
  url: string,
  kind: EndpointKind,
  bodyPromise: Promise<unknown>,
): Promise<void> {
  try {
    if (xhr.responseType !== '' && xhr.responseType !== 'text') return;
    const text = xhr.responseText;
    if (xhr.status === 429) postRateLimit(url, xhr.status);

    if (kind === 'likes') {
      const data = JSON.parse(text) as unknown;
      const instructions = extractInstructions(data);
      if (!instructions) {
        postLikesUnparsed(url, xhr.status, data);
        return;
      }
      postLikes(url, xhr.status, pageKeyFrom(url, await bodyPromise), instructions);
      return;
    }

    const body = await bodyPromise;
    const tweetId = tweetIdFromBody(body);
    if (!tweetId) return;
    if (xhr.status === 429) {
      postUnfavorite(tweetId, false, xhr.status, 88);
      return;
    }
    const data = JSON.parse(text) as Json;
    const code = graphqlErrorMessage(data);
    postUnfavorite(tweetId, xhr.status === 200 && code === undefined, xhr.status, code);
  } catch {
    /* ignore */
  }
}

/* ---------- 与 isolated world 的握手 ---------- */

let hasFetch = false;
let hasXhr = false;

function listenForTapConfig(): void {
  window.addEventListener(
    'message',
    (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const d: unknown = ev.data;
      if (!isBeeWindowMsg(d) || d.from !== 'iso') return;

      // isolated world 的 hello_ack 是它在等我们的 hello；hello 在 document_start 就发了，
      // 那时它还没注册监听器，所以这里补发一次 + 回执，握手上不依赖时序。
      if (d.type === 'hello_ack') {
        post({
          from: 'main',
          type: 'tap_ack',
          enabled: patchedKinds.size > 0,
          wantEndpoints: [...patchedKinds],
          hasFetchPatch: hasFetch,
        });
        return;
      }

      if (d.type !== 'set_tap') return;

      patchedKinds.clear();
      if (d.enabled) {
        for (const e of d.wantEndpoints) {
          if (e === 'likes' || e === 'unfavorite') patchedKinds.add(e);
        }
      }

      post({
        from: 'main',
        type: 'tap_ack',
        enabled: patchedKinds.size > 0,
        wantEndpoints: [...patchedKinds],
        hasFetchPatch: hasFetch,
      });
    },
    false,
  );
}

function main(): void {
  try {
    hasFetch = patchFetch();
    hasXhr = patchXhr();
    listenForTapConfig();
    startSightingsReporter();
    post({
      from: 'main',
      type: 'hello',
      version: PROTOCOL_VERSION,
      hasFetchPatch: hasFetch,
      hasXhrPatch: hasXhr,
    });
  } catch {
    /* MAIN world 脚本失败也不能影响页面 */
  }
}

main();