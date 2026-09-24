import { inbox } from '../shared/db';
import {
  CARD_APP_URL,
  CARD_TEXT_KEY,
  PINYIN_APP_URL,
  PINYIN_TEXT_KEY,
} from '../shared/paths';
import { KIND, MSG_OPEN_TASK, isRuntimeMsg, type RuntimeMsg } from '../shared/protocol';
import { nowIso } from '../shared/util';

/**
 * 薄中继。约 30 秒空闲后会被回收，所以这里不做任何长任务。
 * 唯一的关键职责：内容脚本送来的批次立刻落 IndexedDB，避免任务窗意外关闭时丢数据。
 */

const TASK_PAGE = 'task.html';

/* ---------------- 选中文字的右键菜单 ---------------- */

/**
 * 两个目标站都没有「从 URL 读文本」的入口，所以文字塞不进地址栏：
 * 先放进 chrome.storage.local，再由目标页的 inject-text.js 取出来写进输入框。
 */
const TEXT_MENUS = [
  { id: 'bee-note-card', title: '生成卡片', url: CARD_APP_URL, key: CARD_TEXT_KEY },
  { id: 'bee-pinyin', title: '注音', url: PINYIN_APP_URL, key: PINYIN_TEXT_KEY },
];

function setupContextMenus(): void {
  // 先清再建：扩展重载后 id 会重复，直接 create 会报 duplicate id
  chrome.contextMenus.removeAll(() => {
    for (const menu of TEXT_MENUS) {
      chrome.contextMenus.create({
        id: menu.id,
        title: menu.title,
        contexts: ['selection'],
      });
    }
  });
}

/**
 * 文字交接给目标页。
 * 已有该页面就复用并重载 —— 重载才会重跑内容脚本，否则它读不到新文字。
 */
async function sendTextToApp(url: string, key: string, text: string): Promise<void> {
  await chrome.storage.local.set({ [key]: text });

  let existing: chrome.tabs.Tab | undefined;
  try {
    [existing] = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
  } catch {
    /* 查询失败就退化成新建标签 */
  }

  if (existing?.id !== undefined) {
    try {
      await chrome.tabs.update(existing.id, { active: true });
      if (typeof existing.windowId === 'number') {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      await chrome.tabs.reload(existing.id);
      return;
    } catch {
      /* 标签可能已被关掉，继续走新建 */
    }
  }

  await chrome.tabs.create({ url, active: true });
}

chrome.contextMenus.onClicked.addListener((info) => {
  const menu = TEXT_MENUS.find((m) => m.id === info.menuItemId);
  if (!menu) return;
  const text = info.selectionText?.trim();
  if (!text) return;
  void sendTextToApp(menu.url, menu.key, text);
});

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
  setupContextMenus();
  void notifyBadge('', '#f2a413');
});

// 右键菜单不跨 service worker 生命周期保留，每次启动都重建一次
setupContextMenus();