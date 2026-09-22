import type { TweetLite } from './types';

/** 日期一律用本地时区，因为用户在 X 界面上看到的就是本地时间。 */
export const TIME_ZONE = 'Asia/Shanghai';
/** Asia/Shanghai 无夏令时，偏移固定。 */
export const TZ_OFFSET = '+08:00';

export const CHECK_FILE = '.bee-check';
/** X 点赞页路径。任务页要用它定位标签页，内容脚本要用它判断当前页，放这里避免两处硬编码。 */
export const LIKES_PAGE_PATH = '/i/history/likes';
export const BEE_DIR = '_bee';
/** 所有推文的附件统一放在这一个目录下，文件名带推文 ID 前缀避免互相覆盖。 */
export const ASSETS_DIR = 'assets';
export const LEDGER_FILE = 'ledger.json';
export const REPORT_FILE = 'report.json';
export const SKIP_FILE = 'skipped.md';
export const UNPARSED_FILE = 'unparsed.json';
/** md 文件名（去掉扩展名后）的最大长度，按码点算，避免截断代理对。 */
const MD_BASE_MAX = 60;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** 'YYYY-MM-DD'（Asia/Shanghai） */
export function localDateStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '0000-00-00';
  const p = dateFmt.formatToParts(d);
  return `${part(p, 'year')}-${part(p, 'month')}-${part(p, 'day')}`;
}

/** '2024-03-11T18:03:12+08:00' */
export function localIsoWithOffset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = timeFmt.formatToParts(d);
  const date = localDateStamp(iso);
  return `${date}T${part(p, 'hour')}:${part(p, 'minute')}:${part(p, 'second')}${TZ_OFFSET}`;
}

/**
 * md 文件名的主体：推文正文的第一段非空文本。
 *
 * 用白名单过滤 —— 只保留字母、数字、空白、下划线和连字符，
 * 其余（emoji、`/ \ : * ? " < > |`、各种标点）一律换成空格。
 * 这样既不会出现路径分隔符，也不会有 macOS 上 HFS/NFC 与 Finder 显示成 `:` 的问题。
 */
export function mdBaseName(tweet: Pick<TweetLite, 'id' | 'createdAt' | 'text'>): string {
  const first = tweet.text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const cleaned = first
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .replace(/[\s_]+/g, ' ')
    .trim();
  const capped = [...cleaned].slice(0, MD_BASE_MAX).join('').trim();
  // 正文为空、或整段被过滤空，就退回「日期_推文ID」，绝不产生无名文件。
  return capped.length > 0 ? capped : `${localDateStamp(tweet.createdAt)}_${tweet.id}`;
}

/**
 * md 文件名。第一段话撞车时补推文 ID —— 推文 ID 全局唯一，所以补完一定不冲突。
 * `taken` 是本次运行已占用的文件名集合，调用方负责维护。
 */
export function mdFileName(
  tweet: Pick<TweetLite, 'id' | 'createdAt' | 'text'>,
  taken: ReadonlySet<string>,
): string {
  const base = mdBaseName(tweet);
  const first = `${base}.md`;
  return taken.has(first) ? `${base}_${tweet.id}.md` : first;
}

/** assets/ 下的文件名：推文 ID + 序号 + 扩展名。共用目录，必须带 ID 前缀。 */
export function mediaFileName(tweetId: string, index: number, ext: string): string {
  return `${tweetId}_${index + 1}.${ext}`;
}

export function posterFileName(tweetId: string, index: number, ext: string): string {
  return `${tweetId}_${index + 1}_poster.${ext}`;
}

export function extFromUrl(url: string, fallback = 'jpg'): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(last);
    if (m?.[1]) return m[1].toLowerCase();
    const fmt = u.searchParams.get('format');
    if (fmt && /^[A-Za-z0-9]{2,5}$/.test(fmt)) return fmt.toLowerCase();
  } catch {
    /* URL 不合法时走 fallback */
  }
  return fallback;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}