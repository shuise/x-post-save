import type { MediaItem, TweetAuthor, TweetKind, TweetLite, VideoVariant } from './types';
import { extFromUrl } from './paths';

/**
 * GraphQL 响应是深度嵌套且多态的。这里刻意用宽松类型做形状探测，
 * 产出严格类型的 TweetLite。所有字段访问都走 ?? 兜底，不硬编码 queryId。
 * 无法识别的结构被收集进 unparsed，dump 到 _bee/unparsed.json，X 改版时能立刻定位。
 */
type Json = any;

export type ParseOutcome = {
  tweets: TweetLite[];
  /** 已删除 / 墓碑 / 不可见，记 unavailable 不重试 */
  unavailable: number;
  /** 无法识别的结构骨架 */
  unparsed: Array<{ reason: string; entryId?: string; typename?: string; keys?: string[] }>;
};

/**
 * 从 Likes 响应的 instructions 数组解析出推文列表。
 * 时间线路径双版本兼容：timeline_v2（旧）与 timeline（新）。
 */
export function parseLikesInstructions(
  instructions: unknown,
  pageKey: string,
  capturedAt: string,
): ParseOutcome {
  const out: ParseOutcome = { tweets: [], unavailable: 0, unparsed: [] };

  if (!Array.isArray(instructions)) {
    out.unparsed.push({ reason: 'instructions_not_array', keys: shapeKeys(instructions) });
    return out;
  }

  for (const instr of instructions as Json[]) {
    if (!instr || instr.type !== 'TimelineAddEntries') continue;
    const entries = instr.entries;
    if (!Array.isArray(entries)) continue;

    for (const entry of entries as Json[]) {
      const entryId = typeof entry?.entryId === 'string' ? entry.entryId : undefined;
      for (const itemContent of itemContentsOf(entry)) {
        handleItemContent(itemContent, entryId, pageKey, capturedAt, out);
      }
    }
  }

  return out;
}

/** 从完整响应体里取出 instructions，兼容 timeline_v2 与 timeline 两条路径。 */
export function extractInstructions(data: unknown): unknown[] | null {
  const d = data as Json;
  // GraphQL 响应永远是 { data: {...} } 包一层。早期版本漏了这一层，
  // 结果 instructions 恒为 null、整条取数链路静默返回空 —— 「扫描不到数据」就是这个。
  const roots: Json[] = [d?.data, d];
  for (const root of roots) {
    const result = root?.user?.result;
    const timeline = result?.timeline_v2 ?? result?.timeline;
    const instructions = timeline?.timeline?.instructions;
    if (Array.isArray(instructions)) return instructions as unknown[];
  }
  return null;
}

/** 判断响应是否已到底（TimelineTerminateTimeline）。 */
export function isTerminated(instructions: unknown): boolean {
  if (!Array.isArray(instructions)) return false;
  return (instructions as Json[]).some(
    (i) => i?.type === 'TimelineTerminateTimeline' && i?.direction === 'Bottom',
  );
}

function shapeKeys(v: unknown): string[] | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  return Object.keys(v as object).slice(0, 24);
}

function itemContentsOf(entry: Json): Json[] {
  const content = entry?.content;
  if (!content || typeof content !== 'object') return [];

  // 模块（会话卡片等）：items[].item.itemContent
  if (Array.isArray(content.items)) {
    return content.items
      .map((it: Json) => it?.item?.itemContent)
      .filter((x: Json) => x && typeof x === 'object');
  }

  if (content.itemContent && typeof content.itemContent === 'object') {
    return [content.itemContent];
  }

  return [];
}

function handleItemContent(
  ic: Json,
  entryId: string | undefined,
  pageKey: string,
  capturedAt: string,
  out: ParseOutcome,
): void {
  // 推广内容：点赞页理论上没有，防御性过滤
  if (ic?.promotedMetadata) return;

  const result = ic?.tweet_results?.result;
  const norm = normalizeResult(result);

  if (norm.kind === 'empty') return;
  if (norm.kind === 'unavailable') {
    out.unavailable++;
    return;
  }
  if (norm.kind === 'unknown') {
    out.unparsed.push({
      reason: 'unknown_result',
      entryId,
      typename: result?.__typename,
      keys: shapeKeys(result),
    });
    return;
  }

  const tweet = norm.value;
  const legacy = tweet?.legacy;
  if (!legacy || typeof legacy !== 'object') {
    out.unparsed.push({
      reason: 'no_legacy',
      entryId,
      typename: tweet?.__typename,
      keys: shapeKeys(tweet),
    });
    return;
  }

  const id = String(tweet?.rest_id ?? legacy?.id_str ?? '');
  if (!id) {
    out.unparsed.push({ reason: 'no_id', entryId, keys: shapeKeys(tweet) });
    return;
  }

  out.tweets.push(buildTweet(tweet, legacy, id, pageKey, capturedAt));
}

type Norm =
  | { kind: 'tweet'; value: Json }
  | { kind: 'unavailable' }
  | { kind: 'empty' }
  | { kind: 'unknown' };

function normalizeResult(result: Json): Norm {
  if (!result || typeof result !== 'object') return { kind: 'empty' };

  switch (result.__typename) {
    case 'TweetUnavailable':
    case 'TweetTombstone':
      return { kind: 'unavailable' };
    case 'TweetWithVisibilityResults':
      // 敏感 / 年龄限制内容多包一层
      return result.tweet && typeof result.tweet === 'object'
        ? { kind: 'tweet', value: result.tweet }
        : { kind: 'unavailable' };
    case 'Tweet':
      return { kind: 'tweet', value: result };
    default:
      break;
  }

  if (result.legacy) return { kind: 'tweet', value: result };
  if (result.tweet?.legacy) return { kind: 'tweet', value: result.tweet };
  if (result.rest_id === undefined) return { kind: 'empty' };
  return { kind: 'unknown' };
}

/** 取出包装层里的真实推文对象（转推 / 引用推文用）。 */
function unwrapInner(result: Json): Json {
  if (!result || typeof result !== 'object') return undefined;
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet;
  if (result.legacy) return result;
  if (result.tweet?.legacy) return result.tweet;
  return undefined;
}

function buildTweet(
  tweet: Json,
  legacy: Json,
  id: string,
  pageKey: string,
  capturedAt: string,
): TweetLite {
  const createdAtRaw = typeof legacy.created_at === 'string' ? legacy.created_at : '';
  const parsedDate = parseTwitterDate(createdAtRaw);
  const createdAt = (parsedDate ?? new Date(0)).toISOString();

  const noteText = tweet?.note_tweet?.result?.text;
  const isLongForm = typeof noteText === 'string' && noteText.length > 0;
  const fullText = typeof legacy.full_text === 'string' ? legacy.full_text : '';
  const text = isLongForm ? (noteText as string) : fullText;
  const maybeTruncated = !isLongForm && /…$/.test(fullText.trimEnd());

  const rtResult = unwrapInner(legacy.retweeted_status_result?.result);
  const isRetweet = Boolean(rtResult) || /^RT @/.test(fullText);

  const quotedResult = unwrapInner(legacy.quoted_status_result?.result);
  const isQuote = legacy.is_quote_status === true || Boolean(quotedResult);

  const kind: TweetKind = isRetweet ? 'retweet' : isQuote ? 'quote' : 'original';

  const author = extractAuthor(tweet);
  const url = `https://x.com/${author.handle || 'i'}/status/${id}`;

  const retweetedFrom = isRetweet && rtResult
    ? {
        handle: extractAuthor(rtResult).handle,
        tweetId: String(rtResult?.rest_id ?? rtResult?.legacy?.id_str ?? ''),
      }
    : undefined;

  const quoted = isQuote && !isRetweet ? extractQuoted(quotedResult) : undefined;

  return {
    id,
    createdAt,
    createdAtRaw,
    text,
    isLongForm,
    maybeTruncated,
    ...(typeof legacy.lang === 'string' ? { lang: legacy.lang } : {}),
    url,
    author,
    metrics: {
      likes: num(legacy.favorite_count),
      retweets: num(legacy.retweet_count),
      replies: num(legacy.reply_count),
      quotes: num(legacy.quote_count),
    },
    kind,
    ...(retweetedFrom ? { retweetedFrom } : {}),
    ...(quoted ? { quoted } : {}),
    media: extractMedia(legacy, rtResult),
    source: { pageKey, capturedAt },
  };
}

function extractAuthor(tweet: Json): TweetAuthor {
  const r = tweet?.core?.user_results?.result ?? {};
  const core = r.core ?? {};
  const legacy = r.legacy ?? {};

  const handle = String(core.screen_name ?? legacy.screen_name ?? '');
  const name = String(core.name ?? legacy.name ?? handle);
  const id = String(r.rest_id ?? legacy.id_str ?? '');
  const avatar =
    typeof legacy.profile_image_url_https === 'string'
      ? legacy.profile_image_url_https
      : undefined;

  let verified: boolean | undefined;
  if (typeof r.is_blue_verified === 'boolean') verified = r.is_blue_verified;
  else if (legacy.verified === true) verified = true;

  return {
    id,
    name,
    handle,
    ...(avatar ? { avatar } : {}),
    ...(verified !== undefined ? { verified } : {}),
  };
}

function extractQuoted(quotedResult: Json): TweetLite['quoted'] | undefined {
  if (!quotedResult) return undefined;
  const qLegacy = quotedResult.legacy;
  const tweetId = String(quotedResult.rest_id ?? qLegacy?.id_str ?? '');
  if (!tweetId) return undefined;
  const author = extractAuthor(quotedResult);
  const text = typeof qLegacy?.full_text === 'string' ? qLegacy.full_text : '';
  return { tweetId, handle: author.handle, text };
}

/**
 * 转推的媒体在 retweeted_status_result 里，外层是空的，必须下钻。
 * 引用推文的媒体属于外层（转发者自己附的图），所以只在转推时下钻。
 */
function extractMedia(legacy: Json, rtResult: Json): MediaItem[] {
  const host = rtResult?.legacy ?? legacy;
  const raw = host?.extended_entities?.media ?? host?.entities?.media;
  if (!Array.isArray(raw)) return [];

  const items: MediaItem[] = [];

  for (const m of raw as Json[]) {
    const type = m?.type;

    if (type === 'photo') {
      const base = m?.media_url_https;
      if (typeof base !== 'string') continue;
      items.push({ kind: 'photo', url: originalPhotoUrl(base), ext: extFromUrl(base) });
      continue;
    }

    if (type === 'video' || type === 'animated_gif') {
      const variants = Array.isArray(m?.video_info?.variants) ? m.video_info.variants : [];
      const mp4 = pickBestMp4(variants);
      const hls = pickHls(variants);
      const poster =
        typeof m?.media_url_https === 'string' ? originalPhotoUrl(m.media_url_https) : undefined;
      const durationMs =
        typeof m?.video_info?.duration_millis === 'number' ? m.video_info.duration_millis : undefined;

      const extra = {
        ...(mp4 ? { mp4 } : {}),
        ...(hls ? { hls } : {}),
        ...(poster ? { poster } : {}),
      };

      items.push(
        type === 'animated_gif'
          ? { kind: 'gif', ...extra }
          : { kind: 'video', ...extra, ...(durationMs !== undefined ? { durationMs } : {}) },
      );
    }
  }

  return items;
}

function originalPhotoUrl(base: string): string {
  try {
    const u = new URL(base);
    u.searchParams.set('name', 'orig');
    return u.toString();
  } catch {
    return base;
  }
}

function pickBestMp4(variants: Json[]): VideoVariant | undefined {
  const mp4s = variants.filter(
    (v) => v?.content_type === 'video/mp4' && typeof v?.url === 'string',
  ) as Json[];
  if (mp4s.length === 0) return undefined;
  mp4s.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  const best = mp4s[0] as Json;
  return { url: String(best.url), bitrate: Number(best.bitrate) || 0 };
}

/** HLS 变体没有 bitrate 字段，content_type 是 application/x-mpegURL。 */
function pickHls(variants: Json[]): string | undefined {
  const hls = variants.find(
    (v) =>
      typeof v?.content_type === 'string' &&
      v.content_type.toLowerCase().includes('mpegurl') &&
      typeof v?.url === 'string',
  );
  return hls ? String(hls.url) : undefined;
}

function num(v: Json): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** 解析 "Wed Oct 10 20:19:24 +0000 2018"（V8 虽能直接 Date.parse，但显式解析更稳）。 */
export function parseTwitterDate(raw: string): Date | null {
  const m =
    /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(
      raw.trim(),
    );
  if (!m) return null;

  const mon = MONTH_INDEX[(m[1] ?? '').toLowerCase()];
  if (mon === undefined) return null;

  const day = Number(m[2]);
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  const ss = Number(m[5]);
  const sign = m[6] === '-' ? -1 : 1;
  const offsetMin = sign * (Number(m[7]) * 60 + Number(m[8]));

  const utc = Date.UTC(Number(m[9]), mon, day, hh, mm, ss);
  const d = new Date(utc - offsetMin * 60_000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 响应级幂等去重的 key：queryId + 该请求的 cursor。
 * 同一次响应被重复搬运（页面重试、我们重复 patch）时用它去重。
 */
export function pageKeyFrom(url: string, body: unknown): string {
  const queryId = /\/graphql\/([^/]+)\//.exec(url)?.[1] ?? 'unknown';
  let cursor = '';

  const fromVars = (vars: unknown): void => {
    if (typeof vars === 'string') {
      try {
        cursor = String((JSON.parse(decodeURIComponent(vars)) as Json)?.cursor ?? '');
      } catch {
        /* ignore */
      }
    } else if (vars && typeof vars === 'object') {
      cursor = String((vars as Json).cursor ?? '');
    }
  };

  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    fromVars((parsed as Json)?.variables);
  } catch {
    /* body 不是 JSON，继续尝试从 URL 取 */
  }

  if (!cursor) {
    try {
      fromVars(new URL(url).searchParams.get('variables'));
    } catch {
      /* ignore */
    }
  }

  return `${queryId}:${cursor || 'top'}`;
}