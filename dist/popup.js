import {
  MSG_OPEN_TASK,
  allRecords,
  humanBytes,
  tweets,
  unlikeCandidates
} from "./chunks/chunk-3NOL42CI.js";

// src/popup/popup.ts
function stats() {
  const el = document.getElementById("popup-stats");
  if (!el) throw new Error("popup.html \u7F3A\u5C11 #popup-stats");
  return el;
}
function hint() {
  const el = document.getElementById("popup-hint");
  if (!el) throw new Error("popup.html \u7F3A\u5C11 #popup-hint");
  return el;
}
function row(dl, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}
async function render() {
  const dl = stats();
  dl.textContent = "";
  try {
    const [records, captured] = await Promise.all([allRecords(), tweets.count()]);
    const done = records.filter((r) => r.state === "done").length;
    const partial = records.filter((r) => r.state === "partial").length;
    const failed = records.filter((r) => r.state === "failed").length;
    const bytes = records.reduce((sum, r) => sum + r.bytes, 0);
    const pendingUnlike = unlikeCandidates(records).length;
    row(dl, "\u5DF2\u6355\u83B7\u63A8\u6587", String(captured));
    row(dl, "\u5DF2\u5B8C\u6210", String(done));
    row(dl, "\u90E8\u5206\u5B8C\u6210", String(partial));
    row(dl, "\u5931\u8D25", String(failed));
    row(dl, "\u5360\u7528\u7A7A\u95F4", humanBytes(bytes));
    row(dl, "\u5F85\u53D6\u6D88\u70B9\u8D5E", String(pendingUnlike));
    hint().textContent = done > 0 ? "\u6253\u5F00\u4EFB\u52A1\u9762\u677F\u53EF\u4EE5\u4E0B\u8F7D\u3001\u5199\u76D8\u4E0E\u53D6\u6D88\u70B9\u8D5E\u3002" : "\u6253\u5F00\u4EFB\u52A1\u9762\u677F\u5F00\u59CB\u626B\u63CF\u4F60\u7684\u70B9\u8D5E\u9875\u3002";
  } catch (err) {
    hint().textContent = `\u8BFB\u53D6\u672C\u5730\u72B6\u6001\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`;
    row(dl, "\u72B6\u6001", "\u4E0D\u53EF\u7528");
  }
}
document.getElementById("btn-open")?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ kind: MSG_OPEN_TASK }).catch(() => void 0).finally(() => window.close());
});
void render();
