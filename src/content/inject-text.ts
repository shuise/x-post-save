import {
  CARD_APP_URL,
  CARD_TEXT_KEY,
  PINYIN_APP_URL,
  PINYIN_TEXT_KEY,
} from '../shared/paths';

/**
 * 把选中文字送进目标网页的输入框。只在下面 SITES 列出的站点上运行。
 *
 * 两个目标站都没有「从 URL 读文本」的入口，所以文字塞不进地址栏，
 * 只能由 service worker 放进 chrome.storage.local，再由这里取出来写进输入框。
 * 不在清单里的站点、或没有待处理文字时，这个脚本什么都不做。
 */

/** React 首屏挂载可能晚于本脚本，轮询等输入框出现。 */
const WAIT_STEPS = 50;
const WAIT_MS = 100;
/** 写完等一拍再确认，用来发现值被页面自己的恢复逻辑冲掉的情况。 */
const VERIFY_MS = 300;

type Site = {
  origin: string;
  /** chrome.storage.local 里交接用的 key */
  key: string;
  find: () => HTMLTextAreaElement | null;
};

/** note-card 的输入框有固定 id，直接用。 */
function noteCardInput(): HTMLTextAreaElement | null {
  const el = document.getElementById('inputText');
  return el instanceof HTMLTextAreaElement ? el : null;
}

/**
 * 注音工具的输入框没有可依赖的 id —— 它是一整个 1.37MB 的单文件页面，引擎和样式都在里面。
 * 所以按「可见 textarea 里最大的那个」来认：主编辑区一定比任何隐藏的辅助输入框大。
 */
function pinyinInput(): HTMLTextAreaElement | null {
  const visible = [...document.querySelectorAll('textarea')].filter(
    (el): el is HTMLTextAreaElement =>
      el instanceof HTMLTextAreaElement && el.clientHeight > 0 && el.clientWidth > 0,
  );
  return visible.reduce<HTMLTextAreaElement | null>(
    (best, el) =>
      !best ||
      el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth
        ? el
        : best,
    null,
  );
}

const SITES: Site[] = [
  { origin: new URL(CARD_APP_URL).origin, key: CARD_TEXT_KEY, find: noteCardInput },
  { origin: new URL(PINYIN_APP_URL).origin, key: PINYIN_TEXT_KEY, find: pinyinInput },
];

async function readPendingText(key: string): Promise<string | null> {
  try {
    const bag = await chrome.storage.local.get(key);
    const value = bag[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * 受控输入框不能直接赋 value：React 之类的框架在自己那边记着上一轮的值，
 * 直接赋值它认为「没变化」，不会重渲染。必须用原型上的原生 setter 绕开这份记录，
 * 再补一个冒泡的 input 事件，框架的 onChange / v-model 才会收到。
 */
function fill(ta: HTMLTextAreaElement, text: string): boolean {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

async function main(): Promise<void> {
  const site = SITES.find((s) => s.origin === location.origin);
  if (!site) return;

  const text = await readPendingText(site.key);
  if (text === null) return;

  for (let i = 0; i < WAIT_STEPS; i++) {
    const ta = site.find();
    if (ta && fill(ta, text)) {
      // 页面挂载时可能从自己的存储恢复文本，正常早于本脚本；
      // 万一它晚跑就会把刚写的值冲掉，所以确认一次，被冲掉再补写。
      await new Promise((resolve) => setTimeout(resolve, VERIFY_MS));
      if (ta.value !== text) fill(ta, text);

      // 写成功才清：失败时文字留着，下次打开这个页面还能补上
      await chrome.storage.local.remove(site.key);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }

  console.warn(`[小蜜蜂] 没找到 ${location.origin} 的输入框，选中文字没有写入`);
}

void main();
