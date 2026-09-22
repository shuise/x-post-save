import { inbox } from '../shared/db';
import { KIND, MSG_OPEN_TASK, isRuntimeMsg, type RuntimeMsg } from '../shared/protocol';
import { nowIso } from '../shared/util';

/**
 * 薄中继。约 30 秒空闲后会被回收，所以这里不做任何长任务。
 * 唯一的关键职责：内容脚本送来的批次立刻落 IndexedDB，避免任务窗意外关闭时丢数据。
 */

const TASK_PAGE = 'task.html';

async function notifyBadge(text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* 徽标失败不影响主流程 */
  }
}

async function openTaskWindow(): Promise<{ ok: true }> {
  const url = chrome.runtime.getURL(TASK_PAGE);

  // @types/chrome 把 ContextType 声明成了 enum，但 Chrome 运行时并不暴露该值，
  // 所以这里用字符串字面量 + 断言，实际传给浏览器的是 'TAB'。
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['TAB'] as chrome.runtime.ContextType[],
  });
  const existing = contexts.find((c) => c.documentUrl?.startsWith(url));

  if (existing && typeof existing.tabId === 'number' && existing.tabId >= 0) {
    try {
      await chrome.tabs.update(existing.tabId, { active: true });
      const tab = await chrome.tabs.get(existing.tabId);
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { ok: true };
    } catch {
      /* 窗口可能已被关闭，继续走新建流程 */
    }
  }

  await chrome.windows.create({
    url,
    type: 'popup',
    width: 580,
    height: 780,
    focused: true,
  });

  return { ok: true };
}

async function relayToTaskPages(msg: RuntimeMsg): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    // 任务页没开着时无人接收，属正常情况；关键状态已落在 IndexedDB
  }
}

async function handleContentMessage(msg: RuntimeMsg): Promise<{ ok: true }> {
  switch (msg.kind) {
    case KIND.BATCH:
      await inbox.add({
        runId: msg.runId,
        pageKey: msg.pageKey,
        tweets: msg.tweets,
        rawCount: msg.rawCount,
        receivedAt: nowIso(),
      });
      await notifyBadge('●', '#f2a413');
      break;

    case KIND.PAGE_EVENT:
      if (msg.event === 'caught_up' || msg.event === 'unlike_finished') {
        await notifyBadge('', '#f2a413');
      } else if (msg.event === 'fatal') {
        await notifyBadge('!', '#d64545');
      } else if (msg.event === 'rate_limited') {
        await notifyBadge('!', '#d64545');
      }
      await relayToTaskPages(msg);
      break;

    case KIND.UNLIKE_RESULT:
      await relayToTaskPages(msg);
      break;

    case KIND.CMD:
      // 任务页直接发给内容脚本的命令，service worker 不参与
      break;
  }

  return { ok: true };
}

async function handleMessage(message: unknown): Promise<unknown> {
  if (typeof message !== 'object' || message === null) return { ok: false };

  const kind = (message as { kind?: unknown }).kind;
  if (kind === MSG_OPEN_TASK) return openTaskWindow();

  if (isRuntimeMsg(message)) return handleContentMessage(message);

  return { ok: false };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err: unknown) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  // 异步响应
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void notifyBadge('', '#f2a413');
});