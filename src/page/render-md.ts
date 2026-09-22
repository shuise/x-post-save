import { localIsoWithOffset } from '../shared/paths';
import type { LedgerState, RunStats, SkipEntry, TweetLite } from '../shared/types';
import { nowIso } from '../shared/util';
import type { MediaEntry } from './downloader';

/**
 * md 的生成规则。
 * 文件名取自推文正文第一段话，见 paths.ts 的 mdBaseName；
 * 附件名只用推文 ID + 序号 + 扩展名，避免 emoji、'/'、超长路径，
 * 以及 macOS 上 NFD/NFC 与 ':' 在 Finder 里的显示问题。
 */

/** YAML 双引号字符串：转义反斜杠、引号和控制字符。 */
function yq(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, (c) => (c === '\n' ? '\\n' : ' '));
  return `"${escaped}"`;
}

function unsigned(value: string): string {
  return /^[\w.+-]+$/.test(value) ? value : yq(value);
}

/** 封面与视频共享同一个序号（`2.mp4` ↔ `2_poster.jpg`），按前缀精确匹配。 */
function posterFor(entries: MediaEntry[], videoFile: string): MediaEntry | undefined {
  const base = videoFile.replace(/\.[^.]+$/, '');
  return entries.find((e) => e.kind === 'poster' && e.file.startsWith(`${base}_poster.`));
}

export function renderIndexMd(
  tweet: TweetLite,
  entries: MediaEntry[],
  skipped: SkipEntry[],
  state: LedgerState,
  runId: string,
): string {
  const localCreated = localIsoWithOffset(tweet.createdAt);
  const mediaCount = entries.filter((e) => e.kind !== 'poster').length;

  const front = [
    '---',
    `tweet_id: ${yq(tweet.id)}`,
    `url: ${yq(tweet.url)}`,
    `author: ${yq(`@${tweet.author.handle}`)}`,
    `author_name: ${yq(tweet.author.name)}`,
    `author_id: ${yq(tweet.author.id)}`,
    `created_at: ${yq(localCreated)}`,
    `created_at_utc: ${yq(tweet.createdAt)}`,
    `created_at_source: ${yq(tweet.createdAtRaw)}`,
    `kind: ${tweet.kind}`,
    `lang: ${yq(tweet.lang ?? '')}`,
    'metrics:',
    `  likes: ${tweet.metrics.likes}`,
    `  retweets: ${tweet.metrics.retweets}`,
    `  replies: ${tweet.metrics.replies}`,
    `  quotes: ${tweet.metrics.quotes}`,
    `media_count: ${mediaCount}`,
    `state: ${state}`,
    `downloaded_at: ${yq(nowIso())}`,
    `run_id: ${unsigned(runId)}`,
    '---',
    '',
  ];

  const body: string[] = [
    `# @${tweet.author.handle} · ${localCreated.replace('T', ' ').slice(0, 19)}`,
    '',
    tweet.text.trim() || '（无正文）',
    '',
  ];

  if (tweet.maybeTruncated) {
    body.push(
      '> [!warning] 正文可能被截断',
      '> 这条推文的 `full_text` 以省略号结尾且没有 `note_tweet`，完整正文可能更长。',
      '> 为避免额外消耗 X 的阅读额度，本工具不会为此单独拉取 TweetDetail。',
      '',
    );
  }

  if (tweet.retweetedFrom) {
    body.push(
      '## 转推自',
      '',
      `@${tweet.retweetedFrom.handle} · https://x.com/${tweet.retweetedFrom.handle}/status/${tweet.retweetedFrom.tweetId}`,
      '',
    );
  }

  if (entries.length > 0) {
    body.push('## 媒体', '');
    for (const entry of entries) {
      // 封面不单独成段，只作为 video 的 poster 属性出现（下载封面时视频一定已经成功）
      if (entry.kind === 'poster') continue;

      const path = `assets/${entry.file}`;
      if (entry.kind === 'photo') {
        body.push(`![图片](${path})`, '');
        continue;
      }

      const poster = posterFor(entries, entry.file);
      const posterAttr = poster ? ` poster="assets/${poster.file}"` : '';
      body.push(
        `<video src="${path}" controls preload="metadata"${posterAttr}></video>`,
        '',
      );
      if (entry.note) body.push(`> ${entry.note}`, '');
    }
  }

  if (tweet.quoted) {
    body.push(
      '## 引用',
      '',
      `> @${tweet.quoted.handle} · https://x.com/${tweet.quoted.handle}/status/${tweet.quoted.tweetId}`,
      '>',
      ...tweet.quoted.text
        .split('\n')
        .map((line) => `> ${line}`)
        .slice(0, 20),
      '',
    );
  }

  if (skipped.length > 0) {
    body.push('## 未完成', '');
    for (const s of skipped) {
      body.push(`- \`${s.reason}\` ${s.detail}`);
      if (s.mediaUrl) body.push(`  - 原始地址：${s.mediaUrl}`);
    }
    body.push('');
  }

  return [...front, ...body].join('\n');
}

const REASON_LABEL: Record<SkipEntry['reason'], string> = {
  unavailable: '推文已删除或不可见',
  no_legacy: '响应结构缺少 legacy',
  hls_failed: 'HLS 合并失败',
  hls_drm: 'HLS 加密不支持',
  media_failed: '媒体下载失败',
  unparsed: '响应结构无法解析',
};

export function renderSkippedMd(entries: SkipEntry[]): string {
  const lines = [
    '# 跳过清单',
    '',
    `共 ${entries.length} 条。原因分类见下表；条目会随每次运行累积。`,
    '',
    '| # | 推文 | 原因 | 详情 |',
    '|---|---|---|---|',
  ];

  entries.forEach((e, i) => {
    const link = e.url ? `[${e.tweetId}](${e.url})` : e.tweetId;
    const detail = e.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${i + 1} | ${link} | ${REASON_LABEL[e.reason]} | ${detail} |`);
  });

  lines.push('');
  return lines.join('\n');
}

export function renderUnparsedJson(entries: unknown[]): string {
  return JSON.stringify({ version: 1, generatedAt: nowIso(), count: entries.length, entries }, null, 2);
}

export function renderReport(
  stats: RunStats,
  extra: { skipped: number; ledgerTotal: number; root?: string },
): string {
  const { download, unlike } = stats;
  const sum = download.total;
  const parts = download.done + download.partial + download.failed + download.unavailable;

  const report = {
    version: 1,
    runId: stats.runId,
    startedAt: stats.startedAt,
    generatedAt: nowIso(),
    scanned: stats.scanned,
    rawResponses: stats.rawResponses,
    download: {
      total: sum,
      done: download.done,
      partial: download.partial,
      failed: download.failed,
      unavailable: download.unavailable,
      bytes: download.bytes,
      /** 自洽校验：total 必须等于 done + partial + failed + unavailable */
      balanced: sum === parts,
    },
    unlike,
    skippedEntries: extra.skipped,
    ledgerTotal: extra.ledgerTotal,
    root: extra.root,
  };

  return JSON.stringify(report, null, 2);
}

/** 报告用的人类可读摘要，写进日志。 */
export function summarize(stats: RunStats): string {
  const d = stats.download;
  return [
    `扫描 ${stats.scanned} 条 / ${stats.rawResponses} 个响应`,
    `下载：完成 ${d.done}，部分 ${d.partial}，失败 ${d.failed}，不可用 ${d.unavailable}，合计 ${d.total}`,
    `取消点赞：待处理 ${stats.unlike.eligible}，成功 ${stats.unlike.done}，未确认 ${stats.unlike.unknown}`,
  ].join('；');
}