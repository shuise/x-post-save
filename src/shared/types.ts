/**
 * 全局数据模型。内容脚本产出的 TweetLite 是后续所有环节（下载、写盘、取消点赞）的唯一输入。
 */

export type VideoVariant = { url: string; bitrate: number };

/**
 * 归一化后的媒体项。
 * hls 只在没有任何 mp4 变体时才被填充 —— X 绝大多数视频都提供 progressive mp4。
 */
export type MediaItem =
  | { kind: 'photo'; url: string; ext: string }
  | {
      kind: 'video';
      mp4?: VideoVariant;
      hls?: string;
      poster?: string;
      durationMs?: number;
    }
  | { kind: 'gif'; mp4?: VideoVariant; hls?: string; poster?: string };

export type TweetAuthor = {
  id: string;
  name: string;
  handle: string;
  avatar?: string;
  verified?: boolean;
};

export type TweetMetrics = {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
};

export type TweetKind = 'original' | 'retweet' | 'quote';

export type TweetLite = {
  id: string;
  /** ISO 字符串（UTC） */
  createdAt: string;
  /** legacy.created_at 原文，形如 "Wed Oct 10 20:19:24 +0000 2018" */
  createdAtRaw: string;
  /** note_tweet 长文优先，否则 legacy.full_text */
  text: string;
  isLongForm: boolean;
  /** full_text 以省略号结尾且没有 note_tweet，正文可能被截断 */
  maybeTruncated: boolean;
  lang?: string;
  /** https://x.com/{handle}/status/{id} */
  url: string;
  author: TweetAuthor;
  metrics: TweetMetrics;
  kind: TweetKind;
  retweetedFrom?: { handle: string; tweetId: string };
  quoted?: { tweetId: string; handle: string; text: string };
  media: MediaItem[];
  source: { pageKey: string; capturedAt: string };
};

/** done 的判定是「md 写成功」，而非「媒体下完了」。 */
export type LedgerState = 'pending' | 'done' | 'partial' | 'failed' | 'unavailable';

export type LedgerRecord = {
  tweetId: string;
  runId: string;
  state: LedgerState;
  /** 根目录下的 md 文件名，含 `.md`。断点续传靠它判断落盘了没有。 */
  mdName?: string;
  mediaCount: number;
  bytes: number;
  attempts: number;
  lastError?: string;
  unliked: boolean;
  unlikedAt?: string;
  unlikeAttempts: number;
  unlikeLastError?: string;
  updatedAt: string;
};

/** 扫描阶段由 service worker 落盘的持久化批次，任务页按 seq 游标消费。 */
export type InboxRecord = {
  seq?: number;
  runId: string;
  pageKey: string;
  tweets: TweetLite[];
  rawCount: number;
  receivedAt: string;
};

export type ScanPhaseState = 'idle' | 'scanning' | 'paused' | 'caught_up' | 'stopped';
export type DownloadPhaseState = 'idle' | 'running' | 'paused' | 'finished';
export type UnlikePhaseState = 'idle' | 'running' | 'paused' | 'finished';

export type TaskState = {
  scan: ScanPhaseState;
  download: DownloadPhaseState;
  unlike: UnlikePhaseState;
  /** 目录不可用导致全局暂停时，这里写明原因 */
  blockedReason?: string;
};

export type RunStats = {
  runId: string;
  startedAt: string;
  scanned: number;
  rawResponses: number;
  download: {
    total: number;
    done: number;
    partial: number;
    failed: number;
    unavailable: number;
    bytes: number;
  };
  unlike: {
    eligible: number;
    done: number;
    unknown: number;
    rateLimited: number;
  };
};

/* ---------- MAIN world → isolated world 的搬运载荷 ---------- */

export type LikesPayload = {
  url: string;
  httpStatus: number;
  pageKey: string;
  instructions: unknown[];
};

export type UnfavoriteResult = {
  tweetId: string;
  ok: boolean;
  httpStatus: number;
  /** GraphQL 业务错误码，88 表示限流 */
  bodyCode?: number;
  retryAfterMs?: number;
  bodyPreview?: string;
};

export type RateLimitObservation = {
  httpStatus: number;
  resetAtMs?: number;
  endpoint: string;
};

/* ---------- 跳过清单 ---------- */

export type SkipReason =
  | 'unavailable'
  | 'no_legacy'
  | 'hls_failed'
  | 'hls_drm'
  | 'media_failed'
  | 'unparsed';

export type SkipEntry = {
  tweetId: string;
  url?: string;
  reason: SkipReason;
  detail: string;
  mediaUrl?: string;
};