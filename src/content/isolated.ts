import {
  BEE_NS,
  KIND,
  PROTOCOL_VERSION,
  isBeeWindowMsg,
  readUnlikePayload,
  type PageEvent,
  type RuntimeMsg,
  type UnlikePayload,
} from '../shared/protocol';
import { isTerminated, parseLikesInstructions } from '../shared/tweet-parse';
import type { LikesPayload, TweetLite } from '../shared/types';
import { errorMessage, nowIso, randomBetween, randomDelay, sleep } from '../shared/util';
import { ERROR_BANNER_TEXTS, LIKES_PATH, SEL } from './selectors';

/**
 * ISOLATED world 内容脚本。受信任的一侧：解析 GraphQL、驱动滚动、DOM 点击取消赞、
 * 上报错误横幅与限流信号。跨域媒体下载不在这里做 —— 内容脚本的跨域请求受页面 CORS 约束。
 */

const BATCH_SIZE = 20;
const BATCH_INTERVAL_MS = 5000;

const SCROLL_MIN_MS = 800;
const SCROLL_MAX_MS = 1600;
/**
 * 停止条件用「时间」而不是「轮数」：X 一页 Likes 经常要 3~8 秒才回来，
 * 按轮数算会在页面还在加载时就提前收工，表现就是「扫不到数据」。
 */
const SCAN_IDLE_TIMEOUT_MS = 15_000;
/** 一次响应都没抓到时的兜底上限；到点就报错，不静默结束。 */
const SCAN_NO_DATA_TIMEOUT_MS = 30_000;
/** 最近几次 Likes 原始载荷的环形缓冲，用来补回「开始扫描之前」那一页。 */
const LIKES_BUFFER_MAX = 4;

const UNLIKE_DELAY_MIN_MS = 1500;
const UNLIKE_DELAY_MAX_MS = 4000;
const UNLIKE_CONFIRM_TIMEOUT_MS = 8000;
const UNLIKE_DOM_TIMEOUT_MS = 3000;
const MAX_PASSES = 3;

/* ---------------- 状态 ---------------- */

type ScanState = {
  runId: string;
  active: boolean;
  paused: boolean;
  seen: Set<string>;
  pageKeys: Set<string>;
  pending: TweetLite[];
  lastFlushAt: number;
  rawResponses: number;
  terminated: boolean;
  generation: number;
};

type UnlikeState = {
  runId: string;
  active: boolean;
  budget: number;
  allowlist: Set<string>;
  done: number;
  unknown: number;
  rateLimitedUntil: number;
  consecutiveLimits: number;
  generation: number;
  dryRunIds: Set<string>;
};

const scan: ScanState = {
  runId: '',
  active: false,
  paused: false,
  seen: new Set(),
  pageKeys: new Set(),
  pending: [],
  lastFlushAt: 0,
  rawResponses: 0,
  terminated: false,
  generation: 0,
};

const unlike: UnlikeState = {
  runId: '',
  active: false,
  budget: 300,
  allowlist: new Set(),
  done: 0,
  unknown: 0,
  rateLimitedUntil: 0,
  consecutiveLimits: 0,
  generation: 0,
  dryRunIds: new Set(),
};

/** 等待 UnfavoriteTweet 响应确认的回调，按 tweetId 索引。 */
const pendingConfirm = new Map<string, (r: { ok: boolean; reason?: string }) => void>();

let mainWorldReady = false;
let firstUnparsedLogged = false;

/** MAIN world 的 set_tap 回执。收不到回执 = patch 没装上 = 一定扫不到数据。 */
let tapAcked = false;
let tapArmedAt = 0;
let tapWarned = false;
let tapTimer: number | null = null;

/** 最近几次 Likes 原始载荷，含「开始扫描之前」页面自己发的那一次。 */
type LikesBufferItem = { pageKey: string; payload: LikesPayload };
const likesBuffer: LikesBufferItem[] = [];
let likesBufferPath = '';

/** 观测计数：页面发了多少 GraphQL / 多少 Likes。 */
let seenGraphql = 0;
let seenLikes = 0;
let noLikesWarned = false;

/** MAIN world 报来的、解析不出 instructions 的响应，最终写进 unparsed.json。 */
const unparsedLikes: unknown[] = [];

/* ---------------- 与 service worker 的通信 ---------------- */

const outbox: RuntimeMsg[] = [];
let draining = false;

function emit(msg: RuntimeMsg): void {
  outbox.push(msg);
  void drain();
}

function emitPageEvent(
  runId: string,
  event: PageEvent,
  detail?: string,
  data?: Record<string, unknown>,
): void {
  emit({
    v: 1,
    kind: KIND.PAGE_EVENT,
    runId,
    event,
    ...(detail !== undefined ? { detail } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (outbox.length > 0) {
      const msg = outbox[0];
      if (!msg) break;
      let attempts = 0;
      // service worker 可能在空闲时被回收，发送失败就退避重试
      for (;;) {
        try {
          await chrome.runtime.sendMessage(msg);
          outbox.shift();
          break;
        } catch {
          attempts++;
          if (attempts >= 20) {
            console.warn('[小蜜蜂] 消息发送失败，已丢弃一条', msg.kind);
            outbox.shift();
            break;
          }
          await sleep(Math.min(1000 * attempts, 5000));
        }
      }
    }
  } finally {
    draining = false;
  }
}

/* ---------------- 与 MAIN world 的通信 ---------------- */

/** 只在需要时才让 MAIN world 去读响应体，平时不打扰页面。 */
function setTap(enabled: boolean, wantEndpoints: Array<'likes' | 'unfavorite'>): void {
  tapArmedAt = Date.now();
  try {
    window.postMessage(
      { [BEE_NS]: 1, from: 'iso', type: 'set_tap', enabled, wantEndpoints },
      location.origin,
    );
  } catch {
    /* ignore */
  }
}

/**
 * 反复重发 set_tap 直到收到回执。
 * postMessage 是「发了就没了」的，MAIN world 脚本若因任何原因没装上监听，
 * 这一侧的取数会永久为空而毫无提示 —— 所以必须确认。
 */
function armTap(enabled: boolean, wantEndpoints: Array<'likes' | 'unfavorite'>): void {
  setTap(enabled, wantEndpoints);
  if (tapTimer !== null) return;

  tapTimer = window.setInterval(() => {
    if (tapAcked) return;
    if (Date.now() - tapArmedAt > 20_000) {
      if (!tapWarned) {
        tapWarned = true;
        console.warn('[小蜜蜂] MAIN world 未回应 set_tap，取数不可用（可尝试刷新页面）');
        emitPageEvent(scan.runId, 'fatal', '注入脚本未就绪，请刷新 X 页面后重试');
      }
      return;
    }
    setTap(enabled, wantEndpoints);
  }, 2000);
}

/* ---------------- Likes 原始载荷缓冲 ---------------- */

/**
 * 点赞页打开时页面向 X 要的第一页是最新的那一页，而它发生在用户点「开始扫描」之前。
 * X 只在滚动时才继续带 cursor 发请求，所以那一页不缓冲就永远拿不到了。
 */
function bufferLikes(payload: LikesPayload): void {
  const path = location.pathname.replace(/\/$/, '');
  if (path !== likesBufferPath) {
    likesBuffer.length = 0;
    likesBufferPath = path;
  }
  if (path !== LIKES_PATH) return;
  if (likesBuffer.some((b) => b.pageKey === payload.pageKey)) return;

  likesBuffer.push({ pageKey: payload.pageKey, payload });
  if (likesBuffer.length > LIKES_BUFFER_MAX) likesBuffer.shift();
}

/** 开始扫描时把缓冲里的载荷按原顺序补进来。 */
function drainLikesBuffer(): void {
  if (likesBuffer.length === 0) return;
  const items = likesBuffer.splice(0, likesBuffer.length);
  for (const item of items) handleLikesPayload(item.payload);
}

function flushBatch(force = false): void {
  if (!scan.active && !force) return;
  if (scan.pending.length === 0) return;
  const due = force || scan.pending.length >= BATCH_SIZE || Date.now() - scan.lastFlushAt >= BATCH_INTERVAL_MS;
  if (!due) return;

  const tweets = scan.pending.splice(0, scan.pending.length);
  scan.lastFlushAt = Date.now();
  emit({
    v: 1,
    kind: KIND.BATCH,
    runId: scan.runId,
    pageKey: tweets[0]?.source.pageKey ?? 'unknown',
    tweets,
    rawCount: scan.rawResponses,
  });
}

function handleLikesPayload(payload: {
  url: string;
  pageKey: string;
  instructions: unknown[];
  httpStatus: number;
}): void {
  if (!scan.active) return;

  // 响应级幂等：同一次响应被重复搬运时跳过
  if (scan.pageKeys.has(payload.pageKey)) return;
  scan.pageKeys.add(payload.pageKey);
  scan.rawResponses++;

  if (isTerminated(payload.instructions)) scan.terminated = true;

  const outcome = parseLikesInstructions(payload.instructions, payload.pageKey, nowIso());

  if (outcome.unparsed.length > 0 && !firstUnparsedLogged) {
    firstUnparsedLogged = true;
    console.warn('[小蜜蜂] 出现无法识别的响应结构，已记录：', outcome.unparsed.slice(0, 3));
    emitPageEvent(scan.runId, 'fatal', '解析结构异常', {
      unparsed: outcome.unparsed.slice(0, 10),
    });
  }

  for (const tweet of outcome.tweets) {
    if (scan.seen.has(tweet.id)) continue;
    scan.seen.add(tweet.id);
    scan.pending.push(tweet);
  }

  flushBatch();
}

function handleUnfavoriteResult(payload: {
  tweetId: string;
  ok: boolean;
  httpStatus: number;
  bodyCode?: number;
  retryAfterMs?: number;
  bodyPreview?: string;
}): void {
  const isRateLimited = payload.httpStatus === 429 || payload.bodyCode === 88;
  if (isRateLimited) {
    // 限流判定优先于重试：社区大量案例是请求被静默丢弃，继续点只会更糟
    unlike.consecutiveLimits++;
    const backoff = payload.retryAfterMs
      ? Math.max(0, payload.retryAfterMs - Date.now()) + randomBetween(2000, 5000)
      : Math.min(30_000 * 2 ** (unlike.consecutiveLimits - 1), 300_000);
    unlike.rateLimitedUntil = Date.now() + backoff;
    emitPageEvent(unlike.runId, 'rate_limited', `命中限流，退避 ${Math.round(backoff / 1000)}s`, {
      httpStatus: payload.httpStatus,
      bodyCode: payload.bodyCode,
      consecutive: unlike.consecutiveLimits,
    });
  } else {
    unlike.consecutiveLimits = 0;
  }

  const resolve = pendingConfirm.get(payload.tweetId);
  if (!resolve) return;

  if (isRateLimited) {
    resolve({ ok: false, reason: 'rate_limited' });
    return;
  }
  resolve(payload.ok ? { ok: true } : { ok: false, reason: `http_${payload.httpStatus}` });
}

function handleWindowMessage(ev: MessageEvent): void {
  if (ev.source !== window) return;
  const d: unknown = ev.data;
  if (!isBeeWindowMsg(d) || d.from !== 'main') return;

  switch (d.type) {
    case 'hello':
      mainWorldReady = d.hasFetchPatch;
      if (!d.hasFetchPatch) {
        console.warn('[小蜜蜂] MAIN world 未能 patch fetch，取数将不可用');
      }
      break;
    case 'tap_ack':
      mainWorldReady = d.hasFetchPatch;
      tapAcked = true;
      console.info(
        `[小蜜蜂] 注入脚本已就绪：fetch=${d.hasFetchPatch}，监听=${d.wantEndpoints.join(',') || '无'}`,
      );
      break;
    case 'graphql_seen':
      seenGraphql = d.payload.total;
      seenLikes = d.payload.likes;
      if (scan.active && seenLikes === 0 && !noLikesWarned) {
        noLikesWarned = true;
        emitPageEvent(
          scan.runId,
          'scan_progress',
          `提醒：页面已发出 ${seenGraphql} 个 GraphQL 请求，其中 0 个是 Likes —— 请确认停留在点赞页并保持向下滚动`,
        );
      }
      break;
    case 'likes_unparsed':
      unparsedLikes.push({
        reason: 'extract_instructions_null',
        url: d.payload.url.split('?')[0] ?? d.payload.url,
        httpStatus: d.payload.httpStatus,
        keys: d.payload.keys,
      });
      if (!firstUnparsedLogged) {
        firstUnparsedLogged = true;
        emitPageEvent(scan.runId, 'fatal', 'Likes 响应结构无法识别（已记录到 unparsed.json）', {
          unparsed: unparsedLikes.slice(0, 10),
        });
      }
      break;
    case 'likes_payload':
      bufferLikes(d.payload);
      handleLikesPayload(d.payload);
      break;
    case 'unfavorite_result':
      handleUnfavoriteResult(d.payload);
      break;
    case 'rate_limit_observed':
      if (unlike.active) {
        unlike.rateLimitedUntil = Math.max(
          unlike.rateLimitedUntil,
          d.payload.resetAtMs ? d.payload.resetAtMs + randomBetween(2000, 5000) : Date.now() + 30_000,
        );
        emitPageEvent(unlike.runId, 'rate_limited', `接口返回 ${d.payload.httpStatus}`, {
          endpoint: d.payload.endpoint,
        });
      }
      break;
  }
}

/* ---------------- 滚动与 DOM 工具 ---------------- */

function docHeight(): number {
  return document.documentElement.scrollHeight;
}

function isOnLikesPage(): boolean {
  return location.pathname.replace(/\/$/, '') === LIKES_PATH;
}

function scrollToTop(): void {
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function scrollDownOneViewport(): void {
  window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: 'auto' });
}

function scrollToBottom(): void {
  window.scrollTo({ top: docHeight(), behavior: 'auto' });
}

/**
 * 错误横幅探测。用精确匹配 + 长度上限，避免误伤正文里恰好写着「重试」的推文。
 * 确切的选择器待阶段 0 实测确认，此前这里作为兜底。
 */
function findErrorBanner(): HTMLElement | null {
  const root = document.querySelector(SEL.primaryColumn) ?? document.body;
  if (!root) return null;
  const nodes = root.querySelectorAll('span, div[role="button"], a[role="button"]');
  for (const node of nodes) {
    const text = (node.textContent ?? '').trim();
    if (!text || text.length > 40) continue;
    if (ERROR_BANNER_TEXTS.includes(text)) return node as HTMLElement;
  }
  return null;
}

/** 在该推文内找出它自己的 status 链接：含 <time> 的那个 a，可区分外层推文与引用卡片。 */
function tweetIdOf(article: Element): string | null {
  const anchors = article.querySelectorAll('a[href*="/status/"]');
  for (const a of anchors) {
    if (!a.querySelector(SEL.time)) continue;
    const m = /\/status\/(\d+)/.exec(a.getAttribute('href') ?? '');
    if (m?.[1]) return m[1];
  }
  return null;
}

function mountedTweets(): Array<{ id: string; article: HTMLElement }> {
  const out: Array<{ id: string; article: HTMLElement }> = [];
  for (const article of document.querySelectorAll(SEL.tweet)) {
    const id = tweetIdOf(article);
    if (id) out.push({ id, article: article as HTMLElement });
  }
  return out;
}

/* ---------------- 阶段一：扫描 ---------------- */

async function runScan(runId: string): Promise<void> {
  if (!isOnLikesPage()) {
    emitPageEvent(runId, 'fatal', '请先打开 https://x.com/i/history/likes 再开始扫描');
    return;
  }

  const generation = ++scan.generation;
  scan.runId = runId;
  scan.active = true;
  scan.paused = false;
  scan.seen.clear();
  scan.pageKeys.clear();
  scan.pending = [];
  scan.rawResponses = 0;
  scan.terminated = false;
  scan.lastFlushAt = Date.now();
  noLikesWarned = false;

  const startedAt = Date.now();
  let lastGrowthAt = startedAt;
  let lastSeen = scan.seen.size;
  let lastHeight = -1;
  let lastResponses = scan.pageKeys.size;

  try {
    armTap(true, ['likes']);

    // 先把「开始扫描之前」页面自己加载的第一页补进来，再开始滚动。
    drainLikesBuffer();

    emitPageEvent(runId, 'scan_progress', '开始扫描', { seenTotal: scan.seen.size, fresh: 0 });
    lastSeen = scan.seen.size;
    lastResponses = scan.pageKeys.size;
    lastGrowthAt = Date.now();

    while (scan.active && scan.generation === generation) {
      if (scan.paused) {
        await sleep(500);
        continue;
      }

      if (scan.terminated && scan.pageKeys.size > 0) break;

      const banner = findErrorBanner();
      if (banner) {
        emitPageEvent(runId, 'error_banner', banner.textContent?.trim() ?? '', {
          seenTotal: scan.seen.size,
        });
        await sleep(30_000);
        if (scan.generation !== generation) break;
        continue;
      }

      scrollToBottom();
      await sleep(randomBetween(SCROLL_MIN_MS, SCROLL_MAX_MS));
      if (scan.generation !== generation) break;

      flushBatch();

      const now = Date.now();
      const height = docHeight();
      const seenNow = scan.seen.size;
      const responses = scan.pageKeys.size;
      const fresh = seenNow - lastSeen;
      const grew = height !== lastHeight;
      const newResponse = responses !== lastResponses;

      lastSeen = seenNow;
      lastHeight = height;
      lastResponses = responses;
      if (fresh > 0 || grew || newResponse) lastGrowthAt = now;

      emitPageEvent(runId, 'scan_progress', undefined, {
        seenTotal: seenNow,
        fresh,
        responses,
        scrollTop: Math.round(window.scrollY),
        height,
      });

      // 一次 Likes 响应都没拿到之前不允许「空闲结束」——
      // 否则页面加载稍慢就会以 0 条收工，看起来就是「扫不到数据」。
      if (responses === 0) {
        if (now - startedAt > SCAN_NO_DATA_TIMEOUT_MS) {
          emitPageEvent(runId, 'fatal', '扫描期间未捕获到任何 Likes 响应', {
            diagnosis: {
              onLikesPage: isOnLikesPage(),
              graphqlSeen: seenGraphql,
              likesSeen: seenLikes,
              tapAcked,
              mainWorldReady,
              scannedMs: now - startedAt,
            },
          });
          break;
        }
        continue;
      }

      if (now - lastGrowthAt > SCAN_IDLE_TIMEOUT_MS) break;
    }
  } catch (err) {
    emitPageEvent(runId, 'fatal', `扫描异常：${errorMessage(err)}`);
  } finally {
    // 只有「还是我这一代」才允许收尾：被新一次 scan_start 顶掉时不能动全局状态，
    // 否则新扫描会被旧扫描的 finally 直接关掉。
    if (scan.generation !== generation) return;

    flushBatch(true);
    scan.active = false;
    setTap(true, ['likes']);
    emitPageEvent(runId, 'caught_up', '扫描结束', {
      seenTotal: scan.seen.size,
      responses: scan.pageKeys.size,
      ...(unparsedLikes.length > 0 ? { unparsed: unparsedLikes.slice(0, 20) } : {}),
    });
  }
}

/* ---------------- 阶段三：取消点赞 ---------------- */

function waitForConfirm(tweetId: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingConfirm.delete(tweetId);
      resolve({ ok: false, reason: 'unconfirmed' });
    }, UNLIKE_CONFIRM_TIMEOUT_MS);

    pendingConfirm.set(tweetId, (r) => {
      window.clearTimeout(timer);
      pendingConfirm.delete(tweetId);
      resolve(r);
    });
  });
}

/** 点击后 3 秒内 testid 从 unlike 变成 like，说明点击被页面接受了。 */
async function waitForDomToggle(article: HTMLElement): Promise<boolean> {
  const deadline = Date.now() + UNLIKE_DOM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!article.querySelector(SEL.unlike)) return true;
    await sleep(200);
  }
  return false;
}

async function runUnlike(runId: string, payload: UnlikePayload): Promise<void> {
  if (!isOnLikesPage()) {
    emitPageEvent(runId, 'fatal', '请先打开 https://x.com/i/history/likes 再取消点赞');
    return;
  }

  const generation = ++unlike.generation;
  unlike.runId = runId;
  unlike.active = true;
  unlike.budget = Math.max(1, payload.budget);
  unlike.allowlist = new Set(payload.allowlist);
  unlike.done = 0;
  unlike.unknown = 0;
  unlike.rateLimitedUntil = 0;
  unlike.consecutiveLimits = 0;
  unlike.dryRunIds = new Set();

  setTap(true, ['unfavorite']);
  emitPageEvent(runId, 'scan_progress', payload.dryRun ? '干跑开始' : '取消点赞开始', {
    eligible: unlike.allowlist.size,
  });

  try {
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      if (!unlike.active || unlike.generation !== generation) break;

      let handledThisPass = 0;
      scrollToTop();
      await sleep(800);

      for (;;) {
        if (!unlike.active || unlike.generation !== generation) break;

        // 限流退避：优先于一切重试
        const waitMs = unlike.rateLimitedUntil - Date.now();
        if (waitMs > 0) {
          if (unlike.consecutiveLimits >= 5) {
            emitPageEvent(runId, 'rate_limited', '连续限流，已暂停取消点赞阶段', {
              consecutive: unlike.consecutiveLimits,
            });
            return;
          }
          await sleep(Math.min(waitMs, 60_000));
          continue;
        }

        const candidates = mountedTweets().filter(
          (t) => unlike.allowlist.has(t.id) && !unlike.dryRunIds.has(t.id),
        );

        if (candidates.length === 0 && handledThisPass > 0) break;

        for (const candidate of candidates) {
          if (!unlike.active || unlike.generation !== generation) break;

          if (payload.dryRun) {
            unlike.dryRunIds.add(candidate.id);
            handledThisPass++;
            continue;
          }

          if (unlike.done + unlike.unknown >= unlike.budget) {
            emitPageEvent(runId, 'unlike_finished', '已达到单次运行上限', {
              done: unlike.done,
              unknown: unlike.unknown,
              reason: 'budget',
            });
            return;
          }

          const button = candidate.article.querySelector(SEL.unlike);
          if (!(button instanceof HTMLElement)) {
            unlike.unknown++;
            emit({
              v: 1,
              kind: KIND.UNLIKE_RESULT,
              runId,
              tweetId: candidate.id,
              ok: false,
              reason: 'no_button',
            });
            continue;
          }

          button.scrollIntoView({ block: 'center', behavior: 'auto' });
          await randomDelay(150, 400);
          if (!unlike.active || unlike.generation !== generation) break;

          unlike.allowlist.delete(candidate.id);
          button.click();
          handledThisPass++;

          const toggled = await waitForDomToggle(candidate.article);
          const confirmed = await waitForConfirm(candidate.id);

          if (confirmed.ok) {
            unlike.done++;
            emit({ v: 1, kind: KIND.UNLIKE_RESULT, runId, tweetId: candidate.id, ok: true });
          } else {
            unlike.unknown++;
            emit({
              v: 1,
              kind: KIND.UNLIKE_RESULT,
              runId,
              tweetId: candidate.id,
              ok: false,
              reason: toggled ? (confirmed.reason ?? 'unconfirmed') : 'dom_not_toggled',
            });
          }

          emitPageEvent(runId, 'scan_progress', undefined, {
            done: unlike.done,
            unknown: unlike.unknown,
            remaining: unlike.allowlist.size,
          });

          await randomDelay(UNLIKE_DELAY_MIN_MS, UNLIKE_DELAY_MAX_MS);

          // 限流已经触发时立刻停下做退避，不要再往下点
          if (unlike.rateLimitedUntil > Date.now()) break;
        }

        scrollDownOneViewport();
        await sleep(randomBetween(700, 1400));
      }

      if (payload.dryRun) break;
      if (handledThisPass === 0) break;
    }
  } catch (err) {
    emitPageEvent(runId, 'fatal', `取消点赞异常：${errorMessage(err)}`);
  } finally {
    unlike.active = false;
    // 恢复 likes 监听：取消点赞结束后用户可能还要再扫一轮
    setTap(true, ['likes']);

    if (payload.dryRun) {
      emitPageEvent(runId, 'unlike_dry_run', '干跑结束', {
        ids: [...unlike.dryRunIds],
        count: unlike.dryRunIds.size,
      });
    } else {
      emitPageEvent(runId, 'unlike_finished', '取消点赞结束', {
        done: unlike.done,
        unknown: unlike.unknown,
        remaining: unlike.allowlist.size,
      });
    }
  }
}

/* ---------------- 自检 ---------------- */

/**
 * 同步自检快照。任务页每次发命令都会拿到它，直接打进日志，
 * 「点了没反应」时靠这一行就能判断断在哪一环。
 */
function diag(): Record<string, unknown> {
  return {
    href: location.href,
    onLikesPage: isOnLikesPage(),
    scanActive: scan.active,
    unlikeActive: unlike.active,
    tapAcked,
    mainWorldReady,
    seenGraphql,
    seenLikes,
    buffered: likesBuffer.length,
  };
}

/* ---------------- 命令分发 ---------------- */

function handleCommand(msg: RuntimeMsg): void {
  if (msg.kind !== KIND.CMD) return;

  switch (msg.cmd) {
    case 'scan_start':
      // 不静默忽略：上一次若因异常卡在 active，这里直接提升 generation 顶掉它。
      void runScan(msg.runId);
      break;
    case 'scan_pause':
      scan.paused = true;
      break;
    case 'scan_resume':
      scan.paused = false;
      break;
    case 'scan_stop':
      scan.active = false;
      scan.paused = false;
      break;
    case 'unlike_start': {
      if (unlike.active) return;
      const payload = readUnlikePayload(msg.payload);
      if (!payload) {
        emitPageEvent(msg.runId, 'fatal', '取消点赞参数无效');
        return;
      }
      void runUnlike(msg.runId, { ...payload, dryRun: false });
      break;
    }
    case 'unlike_dry_run': {
      if (unlike.active) return;
      const payload = readUnlikePayload(msg.payload);
      if (!payload) {
        emitPageEvent(msg.runId, 'fatal', '干跑参数无效');
        return;
      }
      void runUnlike(msg.runId, { ...payload, dryRun: true });
      break;
    }
    case 'unlike_stop':
      unlike.active = false;
      break;
    case 'ping':
      emitPageEvent(msg.runId, 'scan_progress', 'pong', {
        onLikesPage: isOnLikesPage(),
        mainWorldReady,
      });
      break;
  }
}

function init(): void {
  window.addEventListener('message', handleWindowMessage, false);

  // 同步返回 ack：命令的实际执行是异步的，但发送方必须收到响应，
  // 否则 chrome.tabs.sendMessage 会以「消息端口提前关闭」为由 reject。
  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
      if (typeof message === 'object' && message !== null) {
        const m = message as { kind?: unknown };
        if (m.kind === KIND.CMD) {
          handleCommand(message as RuntimeMsg);
          // 同步带上自检快照，任务页据此判断「命令到底有没有生效」。
          sendResponse({ ok: true, diag: diag() });
        }
      }
      return false;
    },
  );

  // 一装上就打开 likes 监听：点赞页首次加载时页面自己会发一次 Likes 请求，
  // 那一页是列表最顶部，发生在用户点「开始扫描」之前，只能靠缓冲捡回来。
  armTap(true, ['likes']);

  // MAIN world 的 hello 在 document_start 就发了，那时我们还没注册监听，所以补一次握手。
  window.postMessage(
    { [BEE_NS]: 1, from: 'iso', type: 'hello_ack', version: PROTOCOL_VERSION },
    location.origin,
  );

  console.info(`[小蜜蜂] 内容脚本已就绪（协议 v${PROTOCOL_VERSION}）`);
}

init();