import { extFromUrl, mediaFileName, posterFileName } from '../shared/paths';
import type { SkipEntry, TweetLite } from '../shared/types';
import { errorMessage, sleep } from '../shared/util';
import { writeResponse } from './fs';
import { downloadHls } from './hls';

/**
 * 媒体下载。只在任务页里做 —— 内容脚本的跨域请求受页面 CORS 约束，
 * 只有扩展页能凭 host_permissions 直接 fetch pbs.twimg.com / video.twimg.com。
 */

/**
 * 并发上限。X 的 CDN 按账号/IP 限流，图片小、并发 3 没问题；
 * 视频体积大且是 429 的主要来源，带视频的推文改成串行。
 */
const PHOTO_CONCURRENCY = 3;
const VIDEO_CONCURRENCY = 1;
/** 5xx / 网络错误退避后重试的间隔。 */
const RETRY_DELAY_MS = 5000;
/** 429 拿不到 Retry-After 时的默认退避。 */
const DEFAULT_429_BACKOFF_MS = 30_000;
/** 单条媒体的最多尝试次数。 */
const MEDIA_ATTEMPTS = 3;
/** 退避上限。Retry-After 要得比这还长就直接放弃这条，避免整个任务卡住几小时。 */
const MAX_BACKOFF_MS = 120_000;

export type MediaEntry = {
  file: string;
  kind: 'photo' | 'video' | 'gif' | 'poster';
  bytes: number;
  source: string;
  note?: string;
};

export type MediaOutcome = {
  entries: MediaEntry[];
  skipped: SkipEntry[];
  bytes: number;
};

type ItemResult = { entries: MediaEntry[]; skip?: SkipEntry };

/** 下载结果：拿到响应，或拿到失败原因。失败原因要一路带到跳过清单里。 */
type Fetched = { res: Response } | { reason: string };

/**
 * 全局退避截止时间戳。
 * 429 是按账号/IP 计的，单条重试没意义 —— 命中后所有请求一起等，否则剩下的媒体
 * 会继续撞在限流上，把窗口越撞越死。
 */
let cooldownUntil = 0;

async function waitForCooldown(): Promise<void> {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

/** Retry-After 支持秒数和 HTTP-date 两种写法；缺失时用默认值。 */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get('Retry-After');
  if (raw) {
    const secs = Number(raw.trim());
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return DEFAULT_429_BACKOFF_MS;
}

function cooldown(ms: number): number {
  const capped = Math.min(ms, MAX_BACKOFF_MS);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + capped);
  return capped;
}

/**
 * 注意：浏览器禁止 fetch 设置 Referer（它是 forbidden header），
 * 实测 video.twimg.com / pbs.twimg.com 也不校验它，所以这里只做退避重试，
 * 不浪费一次 declarativeNetRequest 权限去改请求头。
 */
async function fetchMedia(
  url: string,
  attempt = 1,
  onNotice?: (text: string) => void,
): Promise<Fetched> {
  await waitForCooldown();

  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (res.ok) return { res };

    // 429：按 CDN 给的时间整批退避。等待窗口是共享的，并发撞上去只会把窗口越撞越长。
    if (res.status === 429) {
      const asked = retryAfterMs(res);
      const waited = cooldown(asked);
      if (asked > MAX_BACKOFF_MS) {
        // 不为这一条无限等下去，但全批仍然按上限退避；提示必须打出来，
        // 否则面板会静默停住 2 分钟，看起来像卡死。
        onNotice?.(
          `限流要求等 ${Math.round(asked / 1000)}s，超过上限 ${MAX_BACKOFF_MS / 1000}s：本条放弃，全批退避 ${Math.round(waited / 1000)}s`,
        );
        return {
          reason: `HTTP 429（限流要求等 ${Math.round(asked / 1000)}s，超过上限 ${MAX_BACKOFF_MS / 1000}s）`,
        };
      }
      if (attempt < MEDIA_ATTEMPTS) {
        onNotice?.(`命中限流 429，等 ${Math.round(waited / 1000)}s 后重试（第 ${attempt} 次）`);
        await sleep(waited);
        return fetchMedia(url, attempt + 1, onNotice);
      }
      return { reason: `HTTP 429（限流，退避 ${Math.round(waited / 1000)}s 后仍失败）` };
    }

    if (res.status >= 500 && attempt < MEDIA_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
      return fetchMedia(url, attempt + 1, onNotice);
    }

    // 状态码必须带出去：403（链接失效 / 需要登录）和 429（限流）的处置完全不同，
    // 以前这里返回 null，最终只留下一句「视频下载失败」，等于没诊断。
    return { reason: `HTTP ${res.status}` };
  } catch (err) {
    if (attempt < MEDIA_ATTEMPTS) {
      await sleep(1500);
      return fetchMedia(url, attempt + 1, onNotice);
    }
    return { reason: errorMessage(err) };
  }
}

async function downloadOne(
  assetsDir: FileSystemDirectoryHandle,
  name: string,
  url: string,
  kind: MediaEntry['kind'],
  onNotice?: (text: string) => void,
): Promise<{ entry: MediaEntry } | { reason: string }> {
  const got = await fetchMedia(url, 1, onNotice);
  if ('reason' in got) return { reason: got.reason };
  const bytes = await writeResponse(assetsDir, name, got.res);
  return { entry: { file: name, kind, bytes, source: url } };
}

async function downloadItem(
  tweet: TweetLite,
  item: TweetLite['media'][number],
  index: number,
  assetsDir: FileSystemDirectoryHandle,
  onNotice?: (text: string) => void,
): Promise<ItemResult> {
  if (item.kind === 'photo') {
    const name = mediaFileName(tweet.id, index, item.ext);
    const got = await downloadOne(assetsDir, name, item.url, 'photo', onNotice);
    return 'entry' in got
      ? { entries: [got.entry] }
      : {
          entries: [],
          skip: skip(tweet, item.url, 'media_failed', `图片下载失败（${got.reason}）：${name}`),
        };
  }

  const kind: MediaEntry['kind'] = item.kind;

  if (item.mp4) {
    const name = mediaFileName(tweet.id, index, 'mp4');
    const got = await downloadOne(assetsDir, name, item.mp4.url, kind, onNotice);
    if (!('entry' in got)) {
      return {
        entries: [],
        skip: skip(
          tweet,
          item.mp4.url,
          'media_failed',
          `视频下载失败（${got.reason}）：${name}`,
        ),
      };
    }
    const entries = [got.entry];
    const poster = await downloadPoster(item.poster, index, assetsDir, tweet.id, onNotice);
    if (poster) entries.push(poster);
    return { entries };
  }

  if (item.hls) {
    const res = await downloadHls(item.hls, assetsDir, (ext) =>
      mediaFileName(tweet.id, index, ext),
    );
    if (!res.ok) {
      const reason = res.reason === 'drm' ? 'hls_drm' : 'hls_failed';
      return { entries: [], skip: skip(tweet, item.hls, reason, `HLS 失败：${res.detail}`) };
    }
    const entries: MediaEntry[] = [
      {
        file: res.file,
        kind,
        bytes: res.bytes,
        source: item.hls,
        note: res.ext === 'ts' ? 'MPEG-TS 容器，扩展名按容器保留' : undefined,
      },
    ];
    const poster = await downloadPoster(item.poster, index, assetsDir, tweet.id);
    if (poster) entries.push(poster);
    return { entries };
  }

  return {
    entries: [],
    skip: skip(tweet, tweet.url, 'media_failed', '没有可用的视频变体（既无 mp4 也无 HLS）'),
  };
}

/** 封面失败不算这条推文失败：mp4 已经落地，md 里少一个 poster 属性而已。 */
async function downloadPoster(
  poster: string | undefined,
  index: number,
  assetsDir: FileSystemDirectoryHandle,
  tweetId: string,
  onNotice?: (text: string) => void,
): Promise<MediaEntry | null> {
  if (!poster) return null;
  const name = posterFileName(tweetId, index, extFromUrl(poster));
  const got = await downloadOne(assetsDir, name, poster, 'poster', onNotice);
  return 'entry' in got ? got.entry : null;
}

function skip(
  tweet: TweetLite,
  mediaUrl: string,
  reason: SkipEntry['reason'],
  detail: string,
): SkipEntry {
  return { tweetId: tweet.id, url: tweet.url, reason, detail, mediaUrl };
}

/** 小并发池：保持顺序，同时最多跑 limit 个任务。 */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      out[i] = await fn(item, i);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/**
 * 下载一条推文的全部媒体到共用的 assetsDir 下（文件名带推文 ID 前缀）。
 * 单条媒体失败不抛异常，进 skipped，由调用方决定这条推文的最终状态。
 *
 * 并发按最重的媒体项决定：只要这条推文带视频就全程串行，纯图片推文才允许 3 路并发。
 */
export async function downloadTweetMedia(
  tweet: TweetLite,
  assetsDir: FileSystemDirectoryHandle,
  onProgress?: (file: string, bytes: number) => void,
  onNotice?: (text: string) => void,
): Promise<MediaOutcome> {
  const outcome: MediaOutcome = { entries: [], skipped: [], bytes: 0 };
  if (tweet.media.length === 0) return outcome;

  const hasVideo = tweet.media.some((m) => m.kind !== 'photo');
  const limit = hasVideo ? VIDEO_CONCURRENCY : PHOTO_CONCURRENCY;

  const results = await pooled(tweet.media, limit, (item, index) =>
    downloadItem(tweet, item, index, assetsDir, onNotice),
  );

  for (const r of results) {
    outcome.entries.push(...r.entries);
    if (r.skip) outcome.skipped.push(r.skip);
  }
  outcome.bytes = outcome.entries.reduce((sum, e) => sum + e.bytes, 0);

  for (const e of outcome.entries) onProgress?.(e.file, e.bytes);
  return outcome;
}