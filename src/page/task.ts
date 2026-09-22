import { inbox, kv, tweets as tweetsStore } from '../shared/db';
import {
  KIND,
  isRuntimeMsg,
  type BeeCmd,
  type RuntimeMsg,
} from '../shared/protocol';
import {
  ASSETS_DIR,
  BEE_DIR,
  LEDGER_FILE,
  LIKES_PAGE_PATH,
  REPORT_FILE,
  SKIP_FILE,
  UNPARSED_FILE,
  humanBytes,
  mdFileName,
} from '../shared/paths';
import type {
  InboxRecord,
  LedgerRecord,
  LedgerState,
  RunStats,
  SkipEntry,
  TaskState,
  TweetLite,
} from '../shared/types';
import { errorMessage, nowIso, sleep } from '../shared/util';
import { downloadTweetMedia, type MediaOutcome } from './downloader';
import * as fsx from './fs';
import {
  MAX_ATTEMPTS,
  allRecords,
  exportLedgerJson,
  getRecord,
  recordDownload,
  recordUnlike,
  resetForRetry,
  unlikeCandidates,
} from './ledger';
import {
  renderIndexMd,
  renderReport,
  renderSkippedMd,
  renderUnparsedJson,
  summarize,
} from './render-md';
import * as ui from './ui';

/**
 * 任务页：唯一的编排者。
 * 只跑在扩展页面里 —— picker 与 requestPermission 需要 document + 用户手势，
 * service worker 与 offscreen 都做不到。
 */

const UNLIKE_BUDGET = 300;
/** 扫描结束后，队列空转多少轮（1 秒一轮）就认为下载阶段结束。 */
const IDLE_ROUNDS_TO_STOP = 20;
/** 每处理 20 条或每 30 秒做一次目录探针。 */
const PROBE_EVERY_TWEETS = 20;
const PROBE_EVERY_MS = 30_000;

const state: TaskState = { scan: 'idle', download: 'idle', unlike: 'idle' };

let runId = newRunId();
const startedAt = nowIso();

let cursor = 0;
let likesTabId: number | null = null;

let downloadRunning = false;
let downloadPaused = false;
let unlikeRunning = false;

const capturedIds = new Set<string>();
const knownIds = new Set<string>();
let freshCount = 0;
let rawResponses = 0;
let rateLimitHits = 0;

/** 扫描阶段的实时计数，来自内容脚本的 scan_progress 事件。 */
let scanSeen = 0;
let scanFresh = 0;
let lastScanLogAt = 0;
/** 最近一次收到扫描事件的时间，看门狗据此判断扫描是不是已经断了。 */
let lastScanEventAt = 0;

let sinceProbe = 0;
let lastProbeAt = 0;

const skipList: SkipEntry[] = [];
const unparsed: unknown[] = [];

/** 账本状态的本地计数，与 IndexedDB 里的账本保持一致。 */
const dlState: Record<LedgerState, number> = {
  pending: 0,
  done: 0,
  partial: 0,
  failed: 0,
  unavailable: 0,
};
let dlTotal = 0;
let dlBytes = 0;

/** 本次运行已占用的 md 文件名。文件名取自正文第一段话，不同推文可能撞车，靠它消歧。 */
const mdNames = new Set<string>();

/**
 * 统一的附件目录，所有推文共用。
 * 句柄按 root 身份缓存：一次运行里 binding.root 不会变，没必要反复 getDirectoryHandle。
 */
let assetsCache: { root: FileSystemDirectoryHandle; dir: FileSystemDirectoryHandle } | null = null;

async function assetsDir(root: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
  if (assetsCache && assetsCache.root === root) return assetsCache.dir;
  const dir = await fsx.ensureSubdir(root, ASSETS_DIR);
  assetsCache = { root, dir };
  return dir;
}

const unlikeCounters = { eligible: 0, pending: 0, done: 0, unknown: 0 };

/* ---------------- 基础工具 ---------------- */

function newRunId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}-${time}-${Math.random().toString(36).slice(2, 6)}`;
}

function render(): void {
  const hasData = dlTotal > 0 || capturedIds.size > 0 || scanSeen > 0 || state.scan !== 'idle';
  const canUnlike = dlState.done > 0 || unlikeCounters.eligible > 0;
  ui.renderState(state, hasData, canUnlike);
}

function renderDownloadUi(): void {
  ui.renderDownload({
    total: dlTotal,
    done: dlState.done,
    skipped: dlState.partial + dlState.unavailable,
    failed: dlState.failed,
    bytes: dlBytes,
  });
  render();
}

/**
 * 「点了按钮但这一步做不成」的统一出口：既写日志，也在底部浮层提示。
 * 这类错误以前只进日志列表，用户看不到，体感就是「点了没反应」。
 */
function failClick(message: string): void {
  ui.log(message, 'err');
  ui.toast(message, 'err');
}

/**
 * 「已捕获」既可能来自扫描事件，也可能来自下载循环消费的批次。
 * 扫描阶段没开下载时只有前者，所以必须在这里合并，不能只在 consumeBatch 里更新。
 */
function renderScanUi(): void {
  ui.renderScan(Math.max(capturedIds.size, scanSeen), scanFresh);
}

function transition(
  before: LedgerState | null,
  after: LedgerState,
  bytesBefore: number,
  bytesAfter: number,
): void {
  if (before) dlState[before]--;
  else dlTotal++;
  dlState[after]++;
  dlBytes += bytesAfter - bytesBefore;
}

/* ---------------- 存储不可用 ---------------- */

function blockStorage(message: string): void {
  if (state.blockedReason) return;
  state.blockedReason = message;
  ui.showPause(message);
  ui.log(`存储不可用：${message}`, 'err');
  render();
}

function unblockStorage(): void {
  if (!state.blockedReason) return;
  state.blockedReason = undefined;
  ui.hidePause();
  ui.log('存储已恢复，继续运行', 'ok');
  render();
}

/** 外置盘卸载 / 权限收回 / 目录被删，抛出的 DOMException 名字并不统一，一律当「存储不可用」。 */
function handleStorageError(err: unknown): void {
  if (err instanceof fsx.StorageUnavailableError) {
    blockStorage(err.message);
    return;
  }
  blockStorage(errorMessage(err));
}

/* ---------------- 与内容脚本通信 ---------------- */

async function sendCmd(
  tabId: number,
  cmd: BeeCmd,
  payload?: unknown,
): Promise<Record<string, unknown> | null> {
  const msg: RuntimeMsg = {
    v: 1,
    kind: KIND.CMD,
    runId,
    cmd,
    ...(payload !== undefined ? { payload } : {}),
  };
  try {
    const res = (await chrome.tabs.sendMessage(tabId, msg)) as
      | { diag?: Record<string, unknown> }
      | undefined;
    return res?.diag ?? null;
  } catch (err) {
    ui.log(`发送命令 ${cmd} 失败：${errorMessage(err)}`, 'err');
    return null;
  }
}

/** 自检快照格式化。判断不了的时候先把事实打出来，不要猜。 */
function formatDiag(d: Record<string, unknown>): string {
  return (
    `在点赞页=${d.onLikesPage ? '是' : '否'}` +
    `，注入脚本=${d.mainWorldReady ? '已就绪' : '未就绪'}/${d.tapAcked ? '已确认' : '无回执'}` +
    `，缓冲 ${d.buffered ?? 0} 页` +
    `，页面已发 GraphQL ${d.seenGraphql ?? 0} 个（Likes ${d.seenLikes ?? 0} 个）`
  );
}

/**
 * 找到点赞页标签并把它切到前台 —— 虚拟滚动只在可见标签页里渲染新条目，
 * 页面被切到后台就不会继续加载，扫不到东西。
 */
async function ensureLikesTab(): Promise<chrome.tabs.Tab | null> {
  const patterns = [
    `https://x.com${LIKES_PAGE_PATH}*`,
    `https://twitter.com${LIKES_PAGE_PATH}*`,
  ];

  let tab: chrome.tabs.Tab | undefined;
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    tab = tabs.find((t) => typeof t.id === 'number');
  } catch {
    /* 查询失败时走下面的兜底 */
  }

  if (!tab) {
    try {
      const all = await chrome.tabs.query({});
      tab = all.find(
        (t) => typeof t.id === 'number' && (t.url ?? '').includes(LIKES_PAGE_PATH),
      );
    } catch {
      /* ignore */
    }
  }

  if (!tab || typeof tab.id !== 'number') return null;

  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    /* 聚焦失败不影响消息投递 */
  }

  return tab;
}

/* ---------------- 阶段一：扫描 ---------------- */

async function startScan(): Promise<void> {
  if (state.blockedReason) {
    failClick('存储不可用，请先处理目录问题');
    return;
  }

  const tab = await ensureLikesTab();
  if (!tab || typeof tab.id !== 'number') {
    failClick(`请先在浏览器中打开 https://x.com${LIKES_PAGE_PATH} 再开始扫描`);
    return;
  }

  likesTabId = tab.id;
  runId = newRunId();
  await kv.setActiveRunId(runId);
  knownIds.clear();
  for (const rec of await allRecords()) knownIds.add(rec.tweetId);

  state.scan = 'scanning';
  scanSeen = 0;
  scanFresh = 0;
  lastScanLogAt = 0;
  lastScanEventAt = Date.now();
  renderScanUi();
  render();
  ui.log(`开始扫描（run ${runId}）`);

  const d = await sendCmd(tab.id, 'scan_start');

  // 命令没送达：内容脚本没注入、已被回收，或者标签页刚被刷新过。
  if (!d) {
    state.scan = 'idle';
    render();
    failClick(`内容脚本无响应。请在 https://x.com${LIKES_PAGE_PATH} 上刷新页面后重试`);
    return;
  }

  // 把事实直接打出来，别让「点了没反应」变成猜谜。
  if (d.onLikesPage && d.tapAcked) ui.log(`自检：${formatDiag(d)}`);
  else ui.log(`自检：${formatDiag(d)}`, 'warn');

  if (!d.onLikesPage) {
    state.scan = 'idle';
    render();
  }
}

function pauseScan(paused: boolean): void {
  if (likesTabId === null) return;
  state.scan = paused ? 'paused' : 'scanning';
  render();
  void sendCmd(likesTabId, paused ? 'scan_pause' : 'scan_resume');
}

function stopScan(): void {
  state.scan = 'stopped';
  render();
  if (likesTabId !== null) void sendCmd(likesTabId, 'scan_stop');
}

/* ---------------- 阶段二：下载与写盘 ---------------- */

async function maybeProbe(binding: fsx.Binding): Promise<boolean> {
  const now = Date.now();
  if (sinceProbe < PROBE_EVERY_TWEETS && now - lastProbeAt < PROBE_EVERY_MS) return true;

  try {
    await fsx.probe(binding.root);
    sinceProbe = 0;
    lastProbeAt = now;
    return true;
  } catch (err) {
    handleStorageError(err);
    return false;
  }
}

async function processTweet(tweet: TweetLite, batchRunId: string): Promise<void> {
  const binding = fsx.currentBinding();
  if (!binding) {
    blockStorage('尚未授权输出目录');
    return;
  }
  if (!(await maybeProbe(binding))) return;

  const prev = await getRecord(tweet.id);

  // 重做时这两个会被改写成「重置后」的状态，否则账本计数会重复扣减
  let before: LedgerState | null = prev?.state ?? null;
  let bytesBefore = prev?.bytes ?? 0;

  if (prev) {
    // 已删除 / 墓碑推文永远拿不到，记录后不再重试
    if (prev.state === 'unavailable') return;

    if (prev.state === 'done') {
      const mdName = prev.mdName ?? mdFileName(tweet, mdNames);
      if (await fsx.hasFile(binding.root, mdName)) return;
      // 落盘才算数：md 被人手工删掉了就重做
      ui.log(`${mdName} 已不存在，重做 ${tweet.id}`, 'warn');
      mdNames.delete(mdName);
      await resetForRetry(prev);
      transition('done', 'pending', prev.bytes, 0);
      before = 'pending';
      bytesBefore = 0;
      renderDownloadUi();
    } else if (prev.attempts >= MAX_ATTEMPTS) {
      // 把上次的原因一并打出来：跳过不等于没有线索，否则「为什么没下载」就断在这里了。
      ui.log(
        `已尝试 ${prev.attempts} 次仍未成功，跳过 ${tweet.id}（上次原因：${prev.lastError ?? '未记录'}）`,
        'warn',
      );
      return;
    }
  }

  // 文件名要靠账本里已占用的名字去重，所以已完成的记录必须先算进来。
  const mdName = prev?.mdName ?? mdFileName(tweet, mdNames);

  let assets: FileSystemDirectoryHandle;
  let outcome: MediaOutcome;
  try {
    assets = await assetsDir(binding.root);
    ui.log(`↓ ${mdName}（${tweet.media.length} 个媒体）`);
    outcome = await downloadTweetMedia(
      tweet,
      assets,
      (file) => {
        ui.log(`  · assets/${file}`);
      },
      // 命中限流后的退避要看得见，否则整批 await 会让面板像卡死一样安静。
      (text) => ui.log(text, 'warn'),
    );
  } catch (err) {
    // 不写账本：md 没写成功，记录保持原状，重跑会重做这一条
    handleStorageError(err);
    return;
  }

  const nextState: LedgerState =
    outcome.skipped.length === 0 ? 'done' : outcome.entries.length > 0 ? 'partial' : 'failed';

  // 媒体全失败也要把 md 落盘：正文、原始推文链接和失败原因都在这份文件里。
  // 直接 return 会让整条推文凭空消失（视频推文尤其明显），而需求是「每条推文一个 md」。
  const md = renderIndexMd(tweet, outcome.entries, outcome.skipped, nextState, batchRunId);
  try {
    await fsx.writeText(binding.root, mdName, md);
  } catch (err) {
    handleStorageError(err);
    return;
  }
  mdNames.add(mdName);

  const mediaCount = outcome.entries.filter((e) => e.kind !== 'poster').length;
  await recordDownload(tweet.id, batchRunId, {
    state: nextState,
    mdName,
    mediaCount,
    bytes: outcome.bytes,
    lastError:
      outcome.skipped.length > 0
        ? outcome.skipped.map((s) => s.detail).join(' / ')
        : undefined,
  });

  skipList.push(...outcome.skipped);
  transition(before, nextState, bytesBefore, outcome.bytes);
  knownIds.add(tweet.id);

  if (nextState === 'done') {
    ui.log(`✓ ${mdName} 完成（${outcome.entries.length} 个文件，${humanBytes(outcome.bytes)}）`, 'ok');
  } else if (nextState === 'partial') {
    ui.log(`△ ${mdName} 部分完成，${outcome.skipped.length} 项未完成`, 'warn');
  } else {
    ui.log(
      `× ${mdName} 媒体全部失败：${outcome.skipped[0]?.detail ?? ''}（md 已落盘，附件缺失）`,
      'err',
    );
  }
  renderDownloadUi();
}

async function consumeBatch(batch: InboxRecord): Promise<void> {
  rawResponses = Math.max(rawResponses, batch.rawCount);
  await tweetsStore.putMany(batch.tweets);

  for (const tweet of batch.tweets) {
    if (!downloadRunning) return;

    if (capturedIds.has(tweet.id)) continue;
    capturedIds.add(tweet.id);
    if (!knownIds.has(tweet.id)) freshCount++;
    renderScanUi();

    await processTweet(tweet, batch.runId);
    sinceProbe++;
    if (state.blockedReason) return;
  }
}

async function runDownloadLoop(): Promise<void> {
  if (downloadRunning) return;
  if (!fsx.currentBinding()) {
    failClick('请先选择输出目录并完成授权，再开始下载');
    return;
  }

  downloadRunning = true;
  downloadPaused = false;
  state.download = 'running';
  render();
  ui.log('开始下载与写盘');

  // 文件名去重要用账本里已有的名字，把历史记录一并算进来。
  mdNames.clear();
  for (const rec of await allRecords()) {
    if (rec.mdName) mdNames.add(rec.mdName);
  }

  let idle = 0;
  let processedAny = false;

  try {
    while (downloadRunning) {
      if (state.blockedReason) {
        await sleep(1000);
        continue;
      }

      let batches: InboxRecord[];
      try {
        batches = await inbox.since(cursor);
      } catch (err) {
        ui.log(`读取待处理队列失败：${errorMessage(err)}`, 'err');
        await sleep(2000);
        continue;
      }

      if (batches.length === 0) {
        idle++;
        const scanSettled = state.scan === 'caught_up' || state.scan === 'stopped';
        if (scanSettled && idle >= IDLE_ROUNDS_TO_STOP) {
          // 队列从一开始就是空的：说明扫描数据压根没进到面板，而不是「都下完了」。
          if (!processedAny) {
            failClick(
              '待处理队列为空 —— 扫描结果没有送到任务面板，请重新扫描后再下载',
            );
          }
          break;
        }
        await sleep(1000);
        continue;
      }

      idle = 0;
      processedAny = true;

      for (const batch of batches) {
        if (!downloadRunning) break;
        await consumeBatch(batch);
        if (state.blockedReason) break;
        // 整批处理完才推进游标：中途失败时这一批会重放，账本负责去重
        if (batch.seq !== undefined) {
          cursor = batch.seq;
          await kv.setLastConsumedSeq(cursor);
        }
      }
    }
  } catch (err) {
    ui.log(`下载循环异常：${errorMessage(err)}`, 'err');
  } finally {
    downloadRunning = false;
    state.download = downloadPaused ? 'paused' : 'finished';
    render();

    if (downloadPaused) {
      ui.log('下载已暂停', 'warn');
      ui.toast('下载已暂停，点「继续下载」可接着跑', 'warn');
    } else if (state.blockedReason) {
      ui.log('下载中断，等待处理目录问题', 'err');
      ui.toast(`下载中断：${state.blockedReason}`, 'err');
    } else if (!processedAny) {
      // 队列本来就是空的，上面已经用 failClick 报过了，这里不能再补一句「下载完成」打脸。
      ui.log('下载阶段结束：没有可处理的推文', 'warn');
    } else {
      const skipped = dlState.partial + dlState.unavailable;
      ui.log('下载阶段结束');
      ui.toast(
        `下载完成：完成 ${dlState.done}，跳过 ${skipped}，失败 ${dlState.failed}（${humanBytes(dlBytes)}）`,
        dlState.failed > 0 ? 'warn' : 'ok',
      );
    }
  }
}

/* ---------------- 阶段三：取消点赞 ---------------- */

async function startUnlike(dryRun: boolean): Promise<void> {
  if (unlikeRunning) return;
  if (state.blockedReason) {
    failClick('存储不可用，请先处理目录问题');
    return;
  }

  const candidates = unlikeCandidates(await allRecords());
  if (candidates.length === 0) {
    failClick('没有可取消的推文（只取消下载成功的，且最多尝试 2 次）');
    return;
  }

  const tab = await ensureLikesTab();
  if (!tab || typeof tab.id !== 'number') {
    failClick(`请先在浏览器中打开 https://x.com${LIKES_PAGE_PATH} 再取消点赞`);
    return;
  }

  const allowlist = candidates.map((r: LedgerRecord) => r.tweetId);
  const budget = Math.min(UNLIKE_BUDGET, allowlist.length);

  unlikeRunning = true;
  state.unlike = 'running';

  if (!dryRun) {
    unlikeCounters.eligible = allowlist.length;
    unlikeCounters.pending = allowlist.length;
    unlikeCounters.done = 0;
    unlikeCounters.unknown = 0;
    ui.renderUnlike(unlikeCounters);
  }
  render();

  ui.log(
    dryRun
      ? `干跑：将匹配 ${allowlist.length} 条（不点击）`
      : `开始取消点赞：待处理 ${allowlist.length} 条，单次上限 ${budget} 条`,
  );

  await sendCmd(tab.id, dryRun ? 'unlike_dry_run' : 'unlike_start', {
    allowlist,
    budget,
    dryRun,
  });
}

function stopUnlike(): void {
  if (likesTabId !== null) void sendCmd(likesTabId, 'unlike_stop');
  unlikeRunning = false;
  state.unlike = 'finished';
  render();
  ui.log('已请求停止取消点赞', 'warn');
}

async function handleUnlikeResult(msg: {
  tweetId: string;
  ok: boolean;
  reason?: string;
}): Promise<void> {
  await recordUnlike(msg.tweetId, msg.ok, msg.reason);
  ui.log(
    msg.ok ? `已取消 ${msg.tweetId}` : `取消失败 ${msg.tweetId}：${msg.reason ?? '未知原因'}`,
    msg.ok ? 'ok' : 'warn',
  );
}

/* ---------------- 报告 ---------------- */

async function buildStats(): Promise<RunStats> {
  return {
    runId,
    startedAt,
    scanned: await tweetsStore.count(),
    rawResponses,
    download: {
      total: dlTotal,
      done: dlState.done,
      partial: dlState.partial,
      failed: dlState.failed,
      unavailable: dlState.unavailable,
      bytes: dlBytes,
    },
    unlike: {
      eligible: unlikeCounters.eligible,
      done: unlikeCounters.done,
      unknown: unlikeCounters.unknown,
      rateLimited: rateLimitHits,
    },
  };
}

async function exportReports(): Promise<void> {
  const binding = fsx.currentBinding();
  if (!binding) {
    failClick('请先选择输出目录，再导出报告');
    return;
  }

  try {
    const beeDir = await fsx.ensureSubdir(binding.root, BEE_DIR);
    const stats = await buildStats();
    await fsx.writeText(beeDir, LEDGER_FILE, await exportLedgerJson());
    await fsx.writeText(
      beeDir,
      REPORT_FILE,
      renderReport(stats, {
        skipped: skipList.length,
        ledgerTotal: dlTotal,
        root: binding.root.name,
      }),
    );
    await fsx.writeText(beeDir, SKIP_FILE, renderSkippedMd(skipList));
    await fsx.writeText(beeDir, UNPARSED_FILE, renderUnparsedJson(unparsed));

    ui.setExportHint(`已写入 ${binding.root.name}/${BEE_DIR}/`);
    ui.log(`报告已导出：${summarize(stats)}`, 'ok');
  } catch (err) {
    handleStorageError(err);
  }
}

/* ---------------- 目录绑定 ---------------- */

/**
 * 目录选择器是全局单例：连点两次，或上一次的窗口还开着，Chrome 会抛
 * NotAllowedError: File picker already active。用标志位挡住重入，按钮同时置灰。
 * 注意顺序：先同步置位，再调 bindFromPicker —— 中间不能有 await，否则用户激活会被消耗掉。
 */
let picking = false;

async function onPick(): Promise<void> {
  if (picking) return;
  picking = true;
  ui.el.btnPick.disabled = true;

  try {
    const binding = await fsx.bindFromPicker();
    ui.setDir(`已授权：${binding.root.name}`, 'ok');
    ui.setDirHint(`输出目录：${binding.root.name}（探针可写）`);
    ui.log(`已绑定输出目录 ${binding.root.name}`, 'ok');
    unblockStorage();
    renderDownloadUi();
  } catch (err) {
    if (err instanceof fsx.StorageUnavailableError && err.detail === 'abort') {
      ui.log('已取消选择目录');
    } else if (err instanceof fsx.StorageUnavailableError && err.detail === 'picker-busy') {
      // 这是一次重复点击，不是故障，安静提示即可。
      ui.log(errorMessage(err), 'warn');
    } else {
      failClick(`选择目录失败：${errorMessage(err)}`);
    }
  } finally {
    picking = false;
    ui.el.btnPick.disabled = false;
  }
}

async function onReauth(): Promise<void> {
  ui.log('正在重新授权目录…');
  try {
    const binding = await fsx.restoreBinding(true);
    if (!binding) {
      failClick('本地没有保存的目录句柄，请点「选择目录」');
      return;
    }
    await fsx.probe(binding.root);
    ui.setDir(`已授权：${binding.root.name}`, 'ok');
    ui.setDirHint(`输出目录：${binding.root.name}（探针可写）`);
    unblockStorage();
    renderDownloadUi();
  } catch (err) {
    failClick(`重新授权失败：${errorMessage(err)}；可改点「选择目录」`);
  }
}

function onAbort(): void {
  downloadRunning = false;
  downloadPaused = false;
  unlikeRunning = false;
  state.download = 'idle';
  state.unlike = 'idle';
  if (state.scan === 'scanning' || state.scan === 'paused') stopScan();
  ui.hidePause();
  state.blockedReason = undefined;
  render();
  ui.log('已中止当前任务', 'warn');
}

/* ---------------- 启动 ---------------- */

async function restoreOnLoad(): Promise<void> {
  try {
    const binding = await fsx.restoreBinding(false);
    if (!binding) {
      ui.setDir('未授权', 'warn');
      ui.log('尚未授权输出目录，请点「选择目录」选中 LaCie 盘或 x-medias 目录');
      return;
    }
    ui.setDir(`已授权：${binding.root.name}`, 'ok');
    ui.setDirHint(`输出目录：${binding.root.name}`);
    ui.log(`恢复输出目录 ${binding.root.name}`, 'ok');
  } catch (err) {
    ui.setDir('需重新授权', 'warn');
    ui.log(`目录权限已失效：${errorMessage(err)}（可点「重新授权」或「选择目录」）`, 'warn');
  }
}

async function loadCounters(): Promise<void> {
  const all = await allRecords();
  dlTotal = 0;
  dlBytes = 0;
  dlState.pending = 0;
  dlState.done = 0;
  dlState.partial = 0;
  dlState.failed = 0;
  dlState.unavailable = 0;

  for (const rec of all) {
    knownIds.add(rec.tweetId);
    dlTotal++;
    dlState[rec.state]++;
    dlBytes += rec.bytes;
  }
  unlikeCounters.eligible = unlikeCandidates(all).length;
  unlikeCounters.pending = unlikeCounters.eligible;
  unlikeCounters.done = all.filter((r) => r.unliked).length;

  ui.renderUnlike(unlikeCounters);
  renderDownloadUi();
}

function handlePageEvent(msg: Extract<RuntimeMsg, { kind: 'BEE_PAGE_EVENT' }>): void {
  const data = (msg.data ?? {}) as Record<string, unknown>;

  switch (msg.event) {
    case 'scan_progress': {
      if (msg.detail && msg.detail !== 'pong') ui.log(msg.detail);

      // 扫描进度（与取消点赞进度共用该事件名，用字段区分）
      if (typeof data.seenTotal === 'number') {
        lastScanEventAt = Date.now();
        scanSeen = data.seenTotal;
        if (typeof data.fresh === 'number') scanFresh = data.fresh;
        renderScanUi();

        const now = Date.now();
        if (now - lastScanLogAt >= 10_000) {
          lastScanLogAt = now;
          const responses = typeof data.responses === 'number' ? data.responses : 0;
          ui.log(`扫描中：已捕获 ${scanSeen} 条 / 响应 ${responses} 个`);
        }
      }

      if (typeof data.done === 'number' && typeof data.unknown === 'number') {
        unlikeCounters.done = data.done;
        unlikeCounters.unknown = data.unknown;
        if (typeof data.remaining === 'number') unlikeCounters.pending = data.remaining;
        ui.renderUnlike(unlikeCounters);
      }
      break;
    }

    case 'caught_up': {
      state.scan = 'caught_up';
      render();
      const total = Math.max(capturedIds.size, scanSeen);
      ui.log(`扫描结束，共捕获 ${total} 条（新增 ${freshCount}）`, 'ok');
      ui.toast(`扫描完成：共捕获 ${total} 条，新增 ${freshCount} 条`, 'ok');
      if (Array.isArray(data.unparsed)) unparsed.push(...data.unparsed);
      break;
    }

    case 'error_banner':
      ui.log(`页面出现错误横幅：${msg.detail ?? ''}，已自动退避 30 秒`, 'warn');
      break;

    case 'rate_limited':
      rateLimitHits++;
      ui.log(`命中限流：${msg.detail ?? ''}`, 'warn');
      break;

    case 'unlike_finished':
      unlikeRunning = false;
      state.unlike = 'finished';
      if (typeof data.done === 'number') unlikeCounters.done = data.done;
      if (typeof data.unknown === 'number') unlikeCounters.unknown = data.unknown;
      if (typeof data.remaining === 'number') unlikeCounters.pending = data.remaining;
      ui.renderUnlike(unlikeCounters);
      render();
      ui.log(
        `取消点赞结束：成功 ${unlikeCounters.done}，未确认 ${unlikeCounters.unknown}`,
        'ok',
      );
      ui.toast(
        `取消点赞完成：成功 ${unlikeCounters.done}，未确认 ${unlikeCounters.unknown}`,
        unlikeCounters.unknown > 0 ? 'warn' : 'ok',
      );
      break;

    case 'unlike_dry_run': {
      const ids = Array.isArray(data.ids) ? (data.ids as unknown[]) : [];
      unlikeRunning = false;
      state.unlike = 'finished';
      render();
      ui.log(`干跑结束：匹配到 ${ids.length} 条待取消`, 'ok');
      for (const id of ids.slice(0, 50)) ui.log(`  将取消 ${String(id)}`);
      if (ids.length > 50) ui.log(`  …其余 ${ids.length - 50} 条已省略`);
      break;
    }

    case 'nav_changed':
      break;

    case 'fatal':
      ui.log(`错误：${msg.detail ?? ''}`, 'err');
      if (Array.isArray(data.unparsed)) unparsed.push(...data.unparsed);

      // 诊断信息直接打到日志里，出问题时用户看一眼就能定位断在哪一环。
      if (data.diagnosis && typeof data.diagnosis === 'object') {
        const d = data.diagnosis as Record<string, unknown>;
        ui.log(
          `诊断：注入脚本=${d.mainWorldReady ? '已就绪' : '未就绪'}/${d.tapAcked ? '已确认' : '无回执'}` +
            `，在点赞页=${d.onLikesPage ? '是' : '否'}` +
            `，页面已发 GraphQL ${d.graphqlSeen ?? '?'} 个（Likes ${d.likesSeen ?? '?'} 个）` +
            `，耗时 ${Math.round(Number(d.scannedMs ?? 0) / 1000)}s`,
          'err',
        );
      }

      if (state.scan === 'scanning') {
        state.scan = 'stopped';
        render();
      }
      break;
  }
}

async function handleRuntimeMessage(message: unknown): Promise<void> {
  if (!isRuntimeMsg(message)) return;

  switch (message.kind) {
    case KIND.BATCH:
      // 批次已经由 service worker 落进 IndexedDB，任务页按游标轮询即可
      break;
    case KIND.PAGE_EVENT:
      handlePageEvent(message);
      break;
    case KIND.UNLIKE_RESULT:
      await handleUnlikeResult(message);
      break;
    case KIND.CMD:
      break;
  }
}

function bindButtons(): void {
  ui.el.btnPick.addEventListener('click', () => void onPick());
  ui.el.btnReauth.addEventListener('click', () => void onReauth());
  ui.el.btnAbort.addEventListener('click', onAbort);

  ui.el.btnScan.addEventListener('click', () => void startScan());
  ui.el.btnScanPause.addEventListener('click', () => {
    pauseScan(state.scan !== 'paused');
  });
  ui.el.btnScanStop.addEventListener('click', stopScan);

  ui.el.btnDownload.addEventListener('click', () => void runDownloadLoop());
  ui.el.btnDownloadPause.addEventListener('click', () => {
    if (downloadRunning) {
      downloadPaused = true;
      downloadRunning = false;
      return;
    }
    void runDownloadLoop();
  });

  ui.el.btnUnlikeDry.addEventListener('click', () => void startUnlike(true));
  ui.el.btnUnlike.addEventListener('click', () => void startUnlike(false));
  ui.el.btnUnlikeStop.addEventListener('click', stopUnlike);

  ui.el.btnExport.addEventListener('click', () => void exportReports());
}

async function init(): Promise<void> {
  render();
  ui.log('任务面板已就绪');

  chrome.runtime.onMessage.addListener((message: unknown) => {
    void handleRuntimeMessage(message);
    return false;
  });

  bindButtons();

  // 看门狗：内容脚本可能因为页面刷新 / 标签关闭而静默消失，
  // 那样 state.scan 会永远停在 scanning，把「开始扫描」按钮永久置灰 ——
  // 用户看到的就是「点了没反应」。超过 45 秒没有进度就判定为中断。
  window.setInterval(() => {
    if (state.scan !== 'scanning') return;
    if (Date.now() - lastScanEventAt < 45_000) return;
    state.scan = 'stopped';
    render();
    ui.log('扫描超过 45 秒没有任何进度，已判定为中断（可重新点「开始扫描」）', 'warn');
  }, 10_000);

  cursor = await kv.getLastConsumedSeq();
  await restoreOnLoad();
  await loadCounters();
  render();

  ui.log(`已消费队列游标 seq=${cursor}，账本 ${dlTotal} 条`);
}

void init();