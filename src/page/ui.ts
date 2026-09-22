import { humanBytes } from '../shared/paths';
import type { ScanPhaseState, TaskState } from '../shared/types';

/**
 * 任务页的 DOM 渲染。只做「读状态 → 写 DOM」，不含任何业务逻辑。
 * 日志用 DocumentFragment 批量 append，避免逐行触发重排。
 */

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`task.html 缺少 #${id}`);
  return el as T;
}

function btn(id: string): HTMLButtonElement {
  return must<HTMLButtonElement>(id);
}

export const el = {
  badge: must('state-badge'),
  pauseBanner: must('pause-banner'),
  pauseText: must('pause-text'),
  btnReauth: btn('btn-reauth'),
  btnAbort: btn('btn-abort'),

  dirBadge: must('dir-badge'),
  dirHint: must('dir-hint'),
  btnPick: btn('btn-pick'),

  btnScan: btn('btn-scan'),
  btnScanPause: btn('btn-scan-pause'),
  btnScanStop: btn('btn-scan-stop'),
  scanCount: must('scan-count'),
  scanFresh: must('scan-fresh'),

  btnDownload: btn('btn-download'),
  btnDownloadPause: btn('btn-download-pause'),
  dlProgress: must('dl-progress'),
  dlDone: must('dl-done'),
  dlSkipped: must('dl-skipped'),
  dlFailed: must('dl-failed'),

  btnUnlikeDry: btn('btn-unlike-dry'),
  btnUnlike: btn('btn-unlike'),
  btnUnlikeStop: btn('btn-unlike-stop'),
  unlikePending: must('unlike-pending'),
  unlikeDone: must('unlike-done'),
  unlikeUnknown: must('unlike-unknown'),

  btnExport: btn('btn-export'),
  exportHint: must('export-hint'),

  log: must('log'),
  toastHost: must('toast-host'),
};

/* ---------------- 日志 ---------------- */

const MAX_LOG_LINES = 400;

let queue: HTMLElement[] = [];
let scheduled = false;

function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export function log(text: string, tone?: 'ok' | 'warn' | 'err'): void {
  const line = document.createElement('div');
  line.className = tone ? `line line--${tone}` : 'line';
  line.textContent = `${stamp()} ${text}`;
  queue.push(line);

  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flushLog);
  }
}

function flushLog(): void {
  scheduled = false;
  const lines = queue;
  queue = [];
  if (lines.length === 0) return;

  const frag = document.createDocumentFragment();
  for (const line of lines) frag.appendChild(line);
  el.log.appendChild(frag);

  const overflow = el.log.childElementCount - MAX_LOG_LINES;
  for (let i = 0; i < overflow; i++) el.log.firstElementChild?.remove();

  el.log.scrollTop = el.log.scrollHeight;
}

/* ---------------- 底部浮层提示 ---------------- */

/** 提示停留时长。错误比普通提示多留一会儿，够看清。 */
const TOAST_MS = 8000;
/** 同时最多叠几条，避免连续报错把窗口底部糊满。 */
const MAX_TOASTS = 3;

/**
 * 固定在窗口最底部的浮层提示。
 * 按钮点了没成功的那些错误只写进日志列表时用户注意不到，体感就是「没反应」。
 */
export function toast(text: string, tone: 'ok' | 'warn' | 'err' = 'err'): void {
  const node = document.createElement('div');
  node.className = `toast toast--${tone}`;
  node.textContent = text;
  // 点一下就关掉，不用等自动消失
  node.addEventListener('click', () => node.remove());
  el.toastHost.appendChild(node);

  while (el.toastHost.childElementCount > MAX_TOASTS) {
    el.toastHost.firstElementChild?.remove();
  }

  window.setTimeout(() => node.remove(), TOAST_MS);
}

/* ---------------- 状态 ---------------- */

const SCAN_LABEL: Record<ScanPhaseState, string> = {
  idle: '空闲',
  scanning: '扫描中',
  paused: '扫描已暂停',
  caught_up: '扫描完成',
  stopped: '扫描已停止',
};

export function setBadge(text: string, tone?: 'ok' | 'warn' | 'err'): void {
  el.badge.textContent = text;
  el.badge.className = tone ? `badge badge--${tone}` : 'badge';
}

export function renderState(state: TaskState, hasData: boolean, canUnlike: boolean): void {
  if (state.blockedReason) {
    setBadge('已暂停', 'err');
  } else if (state.download === 'running') {
    setBadge('下载中', 'warn');
  } else if (state.download === 'paused') {
    setBadge('下载已暂停', 'warn');
  } else if (state.scan === 'scanning') {
    setBadge('扫描中', 'warn');
  } else if (state.unlike === 'running') {
    setBadge('取消点赞中', 'warn');
  } else {
    setBadge(SCAN_LABEL[state.scan]);
  }

  const scanning = state.scan === 'scanning';
  const scanPaused = state.scan === 'paused';

  el.btnScan.disabled = scanning || scanPaused;
  el.btnScanPause.disabled = !scanning && !scanPaused;
  el.btnScanPause.textContent = scanPaused ? '继续' : '暂停';
  el.btnScanStop.disabled = !scanning && !scanPaused;

  const dlActive = state.download === 'running' || state.download === 'paused';
  el.btnDownload.disabled = dlActive || !hasData;
  el.btnDownloadPause.disabled = !dlActive;
  el.btnDownloadPause.textContent = state.download === 'running' ? '暂停' : '继续下载';

  const canUnlikeNow = state.unlike !== 'running' && !dlActive;
  el.btnUnlikeDry.disabled = !canUnlikeNow;
  el.btnUnlike.disabled = !canUnlikeNow || !canUnlike;
  el.btnUnlikeStop.disabled = state.unlike !== 'running';
}

export function showPause(text: string): void {
  el.pauseText.textContent = text;
  el.pauseBanner.hidden = false;
}

export function hidePause(): void {
  el.pauseBanner.hidden = true;
}

/* ---------------- 各阶段计数 ---------------- */

export function renderScan(captured: number, fresh: number): void {
  el.scanCount.textContent = String(captured);
  el.scanFresh.textContent = String(fresh);
}

export function renderDownload(c: {
  total: number;
  done: number;
  skipped: number;
  failed: number;
  bytes: number;
}): void {
  el.dlProgress.textContent = `${c.done + c.skipped + c.failed} / ${c.total}（${humanBytes(c.bytes)}）`;
  el.dlDone.textContent = String(c.done);
  el.dlSkipped.textContent = String(c.skipped);
  el.dlFailed.textContent = String(c.failed);
}

export function renderUnlike(c: { pending: number; done: number; unknown: number }): void {
  el.unlikePending.textContent = String(c.pending);
  el.unlikeDone.textContent = String(c.done);
  el.unlikeUnknown.textContent = String(c.unknown);
}

export function setDir(label: string, tone?: 'ok' | 'warn' | 'err'): void {
  el.dirBadge.textContent = label;
  el.dirBadge.className = tone ? `badge badge--${tone}` : 'badge';
}

export function setDirHint(text: string): void {
  el.dirHint.textContent = text;
}

export function setExportHint(text: string): void {
  el.exportHint.textContent = text;
}