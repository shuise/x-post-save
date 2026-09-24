"use strict";
(() => {
  // src/shared/paths.ts
  var TIME_ZONE = "Asia/Shanghai";
  var CARD_APP_URL = "https://note-card-mauve.vercel.app/";
  var PINYIN_APP_URL = "https://pinyin-annotator.tjsky.net/pinyin";
  var CARD_TEXT_KEY = "pendingCardText";
  var PINYIN_TEXT_KEY = "pendingPinyinText";
  var dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  var timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  // src/content/inject-text.ts
  var WAIT_STEPS = 50;
  var WAIT_MS = 100;
  var VERIFY_MS = 300;
  function noteCardInput() {
    const el = document.getElementById("inputText");
    return el instanceof HTMLTextAreaElement ? el : null;
  }
  function pinyinInput() {
    const visible = [...document.querySelectorAll("textarea")].filter(
      (el) => el instanceof HTMLTextAreaElement && el.clientHeight > 0 && el.clientWidth > 0
    );
    return visible.reduce(
      (best, el) => !best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth ? el : best,
      null
    );
  }
  var SITES = [
    { origin: new URL(CARD_APP_URL).origin, key: CARD_TEXT_KEY, find: noteCardInput },
    { origin: new URL(PINYIN_APP_URL).origin, key: PINYIN_TEXT_KEY, find: pinyinInput }
  ];
  async function readPendingText(key) {
    try {
      const bag = await chrome.storage.local.get(key);
      const value = bag[key];
      return typeof value === "string" && value.trim().length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  function fill(ta, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  async function main() {
    const site = SITES.find((s) => s.origin === location.origin);
    if (!site) return;
    const text = await readPendingText(site.key);
    if (text === null) return;
    for (let i = 0; i < WAIT_STEPS; i++) {
      const ta = site.find();
      if (ta && fill(ta, text)) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_MS));
        if (ta.value !== text) fill(ta, text);
        await chrome.storage.local.remove(site.key);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
    console.warn(`[\u5C0F\u871C\u8702] \u6CA1\u627E\u5230 ${location.origin} \u7684\u8F93\u5165\u6846\uFF0C\u9009\u4E2D\u6587\u5B57\u6CA1\u6709\u5199\u5165`);
  }
  void main();
})();
