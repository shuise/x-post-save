import { tweets as tweetsStore } from '../shared/db';
import { humanBytes } from '../shared/paths';
import { MSG_OPEN_TASK } from '../shared/protocol';
import { allRecords, unlikeCandidates } from '../page/ledger';

/**
 * popup 只做「看一眼状态 + 打开任务窗」，所有长任务都在独立窗口里跑。
 * 隐藏页面会被 Chrome 节流，popup 一关就没，绝不能承载下载循环。
 */

function stats(): HTMLElement {
  const el = document.getElementById('popup-stats');
  if (!el) throw new Error('popup.html 缺少 #popup-stats');
  return el;
}

function hint(): HTMLElement {
  const el = document.getElementById('popup-hint');
  if (!el) throw new Error('popup.html 缺少 #popup-hint');
  return el;
}

function row(dl: HTMLElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.append(dt, dd);
}

async function render(): Promise<void> {
  const dl = stats();
  dl.textContent = '';

  try {
    const [records, captured] = await Promise.all([allRecords(), tweetsStore.count()]);

    const done = records.filter((r) => r.state === 'done').length;
    const partial = records.filter((r) => r.state === 'partial').length;
    const failed = records.filter((r) => r.state === 'failed').length;
    const bytes = records.reduce((sum, r) => sum + r.bytes, 0);
    const pendingUnlike = unlikeCandidates(records).length;

    row(dl, '已捕获推文', String(captured));
    row(dl, '已完成', String(done));
    row(dl, '部分完成', String(partial));
    row(dl, '失败', String(failed));
    row(dl, '占用空间', humanBytes(bytes));
    row(dl, '待取消点赞', String(pendingUnlike));

    hint().textContent =
      done > 0
        ? '打开任务面板可以下载、写盘与取消点赞。'
        : '打开任务面板开始扫描你的点赞页。';
  } catch (err) {
    hint().textContent = `读取本地状态失败：${err instanceof Error ? err.message : String(err)}`;
    row(dl, '状态', '不可用');
  }
}

document.getElementById('btn-open')?.addEventListener('click', () => {
  void chrome.runtime
    .sendMessage({ kind: MSG_OPEN_TASK })
    .catch(() => undefined)
    .finally(() => window.close());
});

void render();