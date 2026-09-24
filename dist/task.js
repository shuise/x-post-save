import {
  ASSETS_DIR,
  BEE_DIR,
  CHECK_FILE,
  KIND,
  LEDGER_FILE,
  LIKES_PAGE_PATH,
  MAX_ATTEMPTS,
  REPORT_FILE,
  SKIP_FILE,
  UNPARSED_FILE,
  allRecords,
  errorMessage,
  exportLedgerJson,
  extFromUrl,
  getRecord,
  humanBytes,
  inbox,
  isRuntimeMsg,
  kv,
  localIsoWithOffset,
  mdFileName,
  mediaFileName,
  nowIso,
  posterFileName,
  recordDownload,
  recordUnlike,
  resetForRetry,
  sleep,
  tweets,
  unlikeCandidates
} from "./chunks/chunk-GKJZADDG.js";

// src/page/fs.ts
var PICKER_ID = "x-medias-root";
var TARGET_DIR_NAME = "x-medias";
var WRITE = { mode: "readwrite" };
var StorageUnavailableError = class extends Error {
  detail;
  constructor(message, detail = "") {
    super(message);
    this.name = "StorageUnavailableError";
    this.detail = detail;
  }
};
function wrapFsError(err, action) {
  if (err instanceof StorageUnavailableError) return err;
  const detail = err instanceof DOMException ? `${err.name}: ${err.message}` : errorMessage(err);
  return new StorageUnavailableError(`${action}\u5931\u8D25\uFF08${detail}\uFF09`, detail);
}
var binding = null;
function currentBinding() {
  return binding;
}
async function ensurePermission(handle, request) {
  let state2;
  try {
    state2 = await handle.queryPermission(WRITE);
  } catch (err) {
    throw wrapFsError(err, "\u67E5\u8BE2\u76EE\u5F55\u6743\u9650");
  }
  if (state2 === "granted") return;
  if (!request) {
    throw new StorageUnavailableError("\u76EE\u5F55\u6743\u9650\u5DF2\u5931\u6548\uFF0C\u9700\u8981\u91CD\u65B0\u6388\u6743", "prompt");
  }
  try {
    state2 = await handle.requestPermission(WRITE);
  } catch (err) {
    if (err instanceof DOMException && err.name === "SecurityError") {
      throw new StorageUnavailableError("\u6388\u6743\u5FC5\u987B\u7531\u4F60\u70B9\u51FB\u6309\u94AE\u89E6\u53D1\uFF0C\u8BF7\u518D\u70B9\u4E00\u6B21\u300C\u9009\u62E9\u76EE\u5F55\u300D", "gesture");
    }
    throw wrapFsError(err, "\u7533\u8BF7\u76EE\u5F55\u6743\u9650");
  }
  if (state2 !== "granted") {
    throw new StorageUnavailableError("\u4F60\u62D2\u7EDD\u4E86\u76EE\u5F55\u6388\u6743", "denied");
  }
}
async function resolveRoot(picked) {
  if (picked.name === TARGET_DIR_NAME) return picked;
  try {
    return await picked.getDirectoryHandle(TARGET_DIR_NAME, { create: true });
  } catch (err) {
    throw wrapFsError(err, `\u521B\u5EFA ${TARGET_DIR_NAME} \u76EE\u5F55`);
  }
}
async function probe(root) {
  try {
    const fh = await root.getFileHandle(CHECK_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(`${(/* @__PURE__ */ new Date()).toISOString()}
`);
    await w.close();
  } catch (err) {
    throw wrapFsError(err, "\u5199\u5165\u63A2\u9488\u6587\u4EF6");
  }
  try {
    await root.removeEntry(CHECK_FILE);
  } catch {
  }
}
async function bindFromPicker() {
  let picked;
  try {
    picked = await window.showDirectoryPicker({ id: PICKER_ID, mode: "readwrite" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new StorageUnavailableError("\u5DF2\u53D6\u6D88\u9009\u62E9\u76EE\u5F55", "abort");
    }
    if (err instanceof DOMException && err.name === "SecurityError") {
      throw new StorageUnavailableError("\u6253\u5F00\u76EE\u5F55\u9009\u62E9\u5668\u5FC5\u987B\u7531\u4F60\u70B9\u51FB\u6309\u94AE\u89E6\u53D1", "gesture");
    }
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new StorageUnavailableError(
        "\u76EE\u5F55\u9009\u62E9\u5668\u5DF2\u7ECF\u6253\u5F00\u4E86\uFF0C\u8BF7\u5148\u5728\u5F39\u51FA\u7A97\u53E3\u91CC\u5B8C\u6210\u6216\u53D6\u6D88\u8FD9\u6B21\u9009\u62E9",
        "picker-busy"
      );
    }
    throw wrapFsError(err, "\u6253\u5F00\u76EE\u5F55\u9009\u62E9\u5668");
  }
  await ensurePermission(picked, true);
  const root = await resolveRoot(picked);
  await probe(root);
  binding = { picked, root };
  await kv.setRootHandle(picked);
  return binding;
}
async function restoreBinding(request) {
  const picked = await kv.getRootHandle();
  if (!picked) return null;
  await ensurePermission(picked, request);
  const root = await resolveRoot(picked);
  binding = { picked, root };
  return binding;
}
async function ensureSubdir(parent, name) {
  try {
    return await parent.getDirectoryHandle(name, { create: true });
  } catch (err) {
    throw wrapFsError(err, `\u521B\u5EFA\u76EE\u5F55 ${name}`);
  }
}
async function openWritable(dir, name) {
  try {
    const fh = await dir.getFileHandle(name, { create: true });
    return await fh.createWritable();
  } catch (err) {
    throw wrapFsError(err, `\u521B\u5EFA\u6587\u4EF6 ${name}`);
  }
}
async function writeText(dir, name, text) {
  const data = new TextEncoder().encode(text);
  const w = await openWritable(dir, name);
  try {
    await w.write(data);
    await w.close();
  } catch (err) {
    try {
      await w.abort();
    } catch {
    }
    throw wrapFsError(err, `\u5199\u5165\u6587\u4EF6 ${name}`);
  }
  return data.byteLength;
}
async function writeResponse(dir, name, res, onBytes) {
  const w = await openWritable(dir, name);
  let bytes = 0;
  try {
    const body = res.body;
    if (!body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      bytes = buf.byteLength;
      await w.write(buf);
    } else {
      const reader = body.getReader();
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        await w.write(value);
        if (onBytes) onBytes(bytes);
      }
    }
    await w.close();
  } catch (err) {
    try {
      await w.abort();
    } catch {
    }
    throw wrapFsError(err, `\u5199\u5165\u6587\u4EF6 ${name}`);
  }
  return bytes;
}
async function hasFile(root, fileName) {
  try {
    await root.getFileHandle(fileName);
    return true;
  } catch {
    return false;
  }
}

// src/page/hls.ts
var SEGMENT_FAIL_LIMIT = 3;
var FETCH_TIMEOUT_MS = 3e4;
function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}
function parseAttrs(line) {
  const out = /* @__PURE__ */ new Map();
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m = re.exec(line);
  while (m !== null) {
    const key = m[1];
    let value = m[2] ?? "";
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key) out.set(key.toUpperCase(), value.trim());
    m = re.exec(line);
  }
  return out;
}
async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctl.signal, credentials: "omit" });
  } finally {
    clearTimeout(timer);
  }
}
function pickVariant(master, base) {
  let best = null;
  const lines = master.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bandwidth = Number(parseAttrs(line).get("BANDWIDTH") ?? 0) || 0;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next || next.startsWith("#")) continue;
      const url = resolveUrl(base, next.trim());
      if (!best || bandwidth > best.bandwidth) best = { url, bandwidth };
      break;
    }
  }
  return best?.url ?? null;
}
function parseMediaPlaylist(text, base) {
  const out = { segments: [], keyUris: /* @__PURE__ */ new Set(), byterange: false, sequence: 0 };
  let pendingKey;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      out.sequence = Number(line.split(":")[1] ?? 0) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY")) {
      const attrs = parseAttrs(line);
      const method = (attrs.get("METHOD") ?? "NONE").toUpperCase();
      if (method === "NONE") {
        pendingKey = void 0;
      } else {
        const uri = attrs.get("URI");
        const ivHex = attrs.get("IV");
        pendingKey = {
          method,
          uri: uri ? resolveUrl(base, uri) : "",
          ...ivHex ? { iv: hexToBytes(ivHex) } : {}
        };
        out.keyUris.add(pendingKey.uri);
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const uri = parseAttrs(line).get("URI");
      if (uri) out.init = resolveUrl(base, uri);
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE")) {
      out.byterange = true;
      continue;
    }
    if (line.startsWith("#")) continue;
    out.segments.push(resolveUrl(base, line));
    if (pendingKey) out.key = pendingKey;
  }
  return out;
}
function hexToBytes(hex) {
  const clean = hex.replace(/^0[xX]/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}
function ivFromSequence(seq) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(seq));
  return iv;
}
function guessExt(playlist) {
  const probe2 = playlist.init ?? playlist.segments[0] ?? "";
  const path = probe2.split("?")[0] ?? "";
  return /\.ts$/i.test(path) ? "ts" : "mp4";
}
async function downloadHls(masterUrl, dir, nameFor = (ext) => `1.${ext}`) {
  let text;
  let mediaUrl = masterUrl;
  try {
    const res = await fetchText(masterUrl);
    if (!res.ok) return { ok: false, reason: "fetch", detail: `m3u8 HTTP ${res.status}` };
    text = await res.text();
  } catch (err) {
    return { ok: false, reason: "fetch", detail: `\u62C9\u53D6 m3u8 \u5931\u8D25\uFF1A${errorMessage(err)}` };
  }
  if (text.includes("#EXT-X-STREAM-INF")) {
    const variant = pickVariant(text, mediaUrl);
    if (!variant) return { ok: false, reason: "parse", detail: "master \u91CC\u6CA1\u6709\u53EF\u7528 variant" };
    mediaUrl = variant;
    try {
      const res = await fetchText(mediaUrl);
      if (!res.ok) return { ok: false, reason: "fetch", detail: `variant HTTP ${res.status}` };
      text = await res.text();
    } catch (err) {
      return { ok: false, reason: "fetch", detail: `\u62C9\u53D6 variant \u5931\u8D25\uFF1A${errorMessage(err)}` };
    }
  }
  const playlist = parseMediaPlaylist(text, mediaUrl);
  if (playlist.byterange) {
    return { ok: false, reason: "parse", detail: "\u5206\u7247\u4F7F\u7528 BYTERANGE\uFF0C\u672A\u652F\u6301" };
  }
  if (playlist.segments.length === 0) {
    return { ok: false, reason: "parse", detail: "media playlist \u91CC\u6CA1\u6709\u5206\u7247" };
  }
  if (playlist.key && playlist.key.method !== "AES-128") {
    return { ok: false, reason: "drm", detail: `\u4E0D\u652F\u6301\u7684\u52A0\u5BC6\u65B9\u5F0F ${playlist.key.method}` };
  }
  if (playlist.key && !playlist.key.uri) {
    return { ok: false, reason: "drm", detail: "#EXT-X-KEY \u7F3A\u5C11 URI" };
  }
  if (playlist.keyUris.size > 1) {
    return { ok: false, reason: "drm", detail: "\u5BC6\u94A5\u4E2D\u9014\u8F6E\u6362\uFF0C\u672A\u652F\u6301" };
  }
  let cryptoKey = null;
  if (playlist.key) {
    try {
      const res = await fetchText(playlist.key.uri);
      if (!res.ok) return { ok: false, reason: "drm", detail: `\u53D6\u5BC6\u94A5 HTTP ${res.status}` };
      const raw = await res.arrayBuffer();
      cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, [
        "decrypt"
      ]);
    } catch (err) {
      return { ok: false, reason: "drm", detail: `\u5BFC\u5165\u5BC6\u94A5\u5931\u8D25\uFF1A${errorMessage(err)}` };
    }
  }
  const ext = guessExt(playlist);
  const file = nameFor(ext);
  let writable;
  try {
    writable = await openWritable(dir, file);
  } catch (err) {
    return { ok: false, reason: "write", detail: errorMessage(err) };
  }
  let bytes = 0;
  let consecutiveFailures = 0;
  let written = 0;
  const writeChunk = async (chunk) => {
    bytes += chunk.byteLength;
    await writable.write(chunk);
  };
  try {
    const parts = [playlist.init, ...playlist.segments];
    for (let i = 0; i < parts.length; i++) {
      const partUrl = parts[i];
      if (!partUrl) continue;
      const isInit = i === 0 && Boolean(playlist.init);
      const seq = playlist.sequence + i - (playlist.init ? 1 : 0);
      let buf = null;
      try {
        const res = await fetchText(partUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        consecutiveFailures++;
        if (consecutiveFailures >= SEGMENT_FAIL_LIMIT) {
          await abortQuietly(writable);
          return {
            ok: false,
            reason: "fetch",
            detail: `\u8FDE\u7EED ${consecutiveFailures} \u4E2A\u5206\u7247\u5931\u8D25\uFF1A${errorMessage(err)}`
          };
        }
        await sleep(1500);
        continue;
      }
      if (cryptoKey && !isInit && playlist.key) {
        const iv = playlist.key.iv ?? ivFromSequence(Math.max(0, seq));
        try {
          const plain = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv },
            cryptoKey,
            buf
          );
          buf = new Uint8Array(plain);
        } catch (err) {
          await abortQuietly(writable);
          return { ok: false, reason: "drm", detail: `\u89E3\u5BC6\u5931\u8D25\uFF1A${errorMessage(err)}` };
        }
      }
      await writeChunk(buf);
      consecutiveFailures = 0;
      if (isInit) continue;
      written++;
      if (written % 20 === 0) await sleep(50);
    }
    await writable.close();
  } catch (err) {
    await abortQuietly(writable);
    return { ok: false, reason: "write", detail: errorMessage(err) };
  }
  return { ok: true, file, bytes, ext, segments: written };
}
async function abortQuietly(writable) {
  try {
    await writable.abort();
  } catch {
  }
}

// src/page/downloader.ts
var PHOTO_CONCURRENCY = 3;
var VIDEO_CONCURRENCY = 1;
var RETRY_DELAY_MS = 5e3;
var DEFAULT_429_BACKOFF_MS = 3e4;
var MEDIA_ATTEMPTS = 3;
var MAX_BACKOFF_MS = 12e4;
var cooldownUntil = 0;
async function waitForCooldown() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}
function retryAfterMs(res) {
  const raw = res.headers.get("Retry-After");
  if (raw) {
    const secs = Number(raw.trim());
    if (Number.isFinite(secs) && secs >= 0) return secs * 1e3;
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return DEFAULT_429_BACKOFF_MS;
}
function cooldown(ms) {
  const capped = Math.min(ms, MAX_BACKOFF_MS);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + capped);
  return capped;
}
async function fetchMedia(url, attempt = 1, onNotice) {
  await waitForCooldown();
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (res.ok) return { res };
    if (res.status === 429) {
      const asked = retryAfterMs(res);
      const waited = cooldown(asked);
      if (asked > MAX_BACKOFF_MS) {
        onNotice?.(
          `\u9650\u6D41\u8981\u6C42\u7B49 ${Math.round(asked / 1e3)}s\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${MAX_BACKOFF_MS / 1e3}s\uFF1A\u672C\u6761\u653E\u5F03\uFF0C\u5168\u6279\u9000\u907F ${Math.round(waited / 1e3)}s`
        );
        return {
          reason: `HTTP 429\uFF08\u9650\u6D41\u8981\u6C42\u7B49 ${Math.round(asked / 1e3)}s\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${MAX_BACKOFF_MS / 1e3}s\uFF09`
        };
      }
      if (attempt < MEDIA_ATTEMPTS) {
        onNotice?.(`\u547D\u4E2D\u9650\u6D41 429\uFF0C\u7B49 ${Math.round(waited / 1e3)}s \u540E\u91CD\u8BD5\uFF08\u7B2C ${attempt} \u6B21\uFF09`);
        await sleep(waited);
        return fetchMedia(url, attempt + 1, onNotice);
      }
      return { reason: `HTTP 429\uFF08\u9650\u6D41\uFF0C\u9000\u907F ${Math.round(waited / 1e3)}s \u540E\u4ECD\u5931\u8D25\uFF09` };
    }
    if (res.status >= 500 && attempt < MEDIA_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
      return fetchMedia(url, attempt + 1, onNotice);
    }
    return { reason: `HTTP ${res.status}` };
  } catch (err) {
    if (attempt < MEDIA_ATTEMPTS) {
      await sleep(1500);
      return fetchMedia(url, attempt + 1, onNotice);
    }
    return { reason: errorMessage(err) };
  }
}
async function downloadOne(assetsDir2, name, url, kind, onNotice) {
  const got = await fetchMedia(url, 1, onNotice);
  if ("reason" in got) return { reason: got.reason };
  const bytes = await writeResponse(assetsDir2, name, got.res);
  return { entry: { file: name, kind, bytes, source: url } };
}
async function downloadItem(tweet, item, index, assetsDir2, onNotice) {
  if (item.kind === "photo") {
    const name = mediaFileName(tweet.id, index, item.ext);
    const got = await downloadOne(assetsDir2, name, item.url, "photo", onNotice);
    return "entry" in got ? { entries: [got.entry] } : {
      entries: [],
      skip: skip(tweet, item.url, "media_failed", `\u56FE\u7247\u4E0B\u8F7D\u5931\u8D25\uFF08${got.reason}\uFF09\uFF1A${name}`)
    };
  }
  const kind = item.kind;
  if (item.mp4) {
    const name = mediaFileName(tweet.id, index, "mp4");
    const got = await downloadOne(assetsDir2, name, item.mp4.url, kind, onNotice);
    if (!("entry" in got)) {
      return {
        entries: [],
        skip: skip(
          tweet,
          item.mp4.url,
          "media_failed",
          `\u89C6\u9891\u4E0B\u8F7D\u5931\u8D25\uFF08${got.reason}\uFF09\uFF1A${name}`
        )
      };
    }
    const entries = [got.entry];
    const poster = await downloadPoster(item.poster, index, assetsDir2, tweet.id, onNotice);
    if (poster) entries.push(poster);
    return { entries };
  }
  if (item.hls) {
    const res = await downloadHls(
      item.hls,
      assetsDir2,
      (ext) => mediaFileName(tweet.id, index, ext)
    );
    if (!res.ok) {
      const reason = res.reason === "drm" ? "hls_drm" : "hls_failed";
      return { entries: [], skip: skip(tweet, item.hls, reason, `HLS \u5931\u8D25\uFF1A${res.detail}`) };
    }
    const entries = [
      {
        file: res.file,
        kind,
        bytes: res.bytes,
        source: item.hls,
        note: res.ext === "ts" ? "MPEG-TS \u5BB9\u5668\uFF0C\u6269\u5C55\u540D\u6309\u5BB9\u5668\u4FDD\u7559" : void 0
      }
    ];
    const poster = await downloadPoster(item.poster, index, assetsDir2, tweet.id);
    if (poster) entries.push(poster);
    return { entries };
  }
  return {
    entries: [],
    skip: skip(tweet, tweet.url, "media_failed", "\u6CA1\u6709\u53EF\u7528\u7684\u89C6\u9891\u53D8\u4F53\uFF08\u65E2\u65E0 mp4 \u4E5F\u65E0 HLS\uFF09")
  };
}
async function downloadPoster(poster, index, assetsDir2, tweetId, onNotice) {
  if (!poster) return null;
  const name = posterFileName(tweetId, index, extFromUrl(poster));
  const got = await downloadOne(assetsDir2, name, poster, "poster", onNotice);
  return "entry" in got ? got.entry : null;
}
function skip(tweet, mediaUrl, reason, detail) {
  return { tweetId: tweet.id, url: tweet.url, reason, detail, mediaUrl };
}
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (; ; ) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === void 0) continue;
      out[i] = await fn(item, i);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}
async function downloadTweetMedia(tweet, assetsDir2, onProgress, onNotice) {
  const outcome = { entries: [], skipped: [], bytes: 0 };
  if (tweet.media.length === 0) return outcome;
  const hasVideo = tweet.media.some((m) => m.kind !== "photo");
  const limit = hasVideo ? VIDEO_CONCURRENCY : PHOTO_CONCURRENCY;
  const results = await pooled(
    tweet.media,
    limit,
    (item, index) => downloadItem(tweet, item, index, assetsDir2, onNotice)
  );
  for (const r of results) {
    outcome.entries.push(...r.entries);
    if (r.skip) outcome.skipped.push(r.skip);
  }
  outcome.bytes = outcome.entries.reduce((sum, e) => sum + e.bytes, 0);
  for (const e of outcome.entries) onProgress?.(e.file, e.bytes);
  return outcome;
}

// src/page/render-md.ts
function yq(value) {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => c === "\n" ? "\\n" : " ");
  return `"${escaped}"`;
}
function unsigned(value) {
  return /^[\w.+-]+$/.test(value) ? value : yq(value);
}
function posterFor(entries, videoFile) {
  const base = videoFile.replace(/\.[^.]+$/, "");
  return entries.find((e) => e.kind === "poster" && e.file.startsWith(`${base}_poster.`));
}
function renderIndexMd(tweet, entries, skipped, state2, runId2) {
  const localCreated = localIsoWithOffset(tweet.createdAt);
  const mediaCount = entries.filter((e) => e.kind !== "poster").length;
  const front = [
    "---",
    `tweet_id: ${yq(tweet.id)}`,
    `url: ${yq(tweet.url)}`,
    `author: ${yq(`@${tweet.author.handle}`)}`,
    `author_name: ${yq(tweet.author.name)}`,
    `author_id: ${yq(tweet.author.id)}`,
    `created_at: ${yq(localCreated)}`,
    `created_at_utc: ${yq(tweet.createdAt)}`,
    `created_at_source: ${yq(tweet.createdAtRaw)}`,
    `kind: ${tweet.kind}`,
    `lang: ${yq(tweet.lang ?? "")}`,
    "metrics:",
    `  likes: ${tweet.metrics.likes}`,
    `  retweets: ${tweet.metrics.retweets}`,
    `  replies: ${tweet.metrics.replies}`,
    `  quotes: ${tweet.metrics.quotes}`,
    `media_count: ${mediaCount}`,
    `state: ${state2}`,
    `downloaded_at: ${yq(nowIso())}`,
    `run_id: ${unsigned(runId2)}`,
    "---",
    ""
  ];
  const body = [
    `# @${tweet.author.handle} \xB7 ${localCreated.replace("T", " ").slice(0, 19)}`,
    "",
    tweet.text.trim() || "\uFF08\u65E0\u6B63\u6587\uFF09",
    ""
  ];
  if (tweet.maybeTruncated) {
    body.push(
      "> [!warning] \u6B63\u6587\u53EF\u80FD\u88AB\u622A\u65AD",
      "> \u8FD9\u6761\u63A8\u6587\u7684 `full_text` \u4EE5\u7701\u7565\u53F7\u7ED3\u5C3E\u4E14\u6CA1\u6709 `note_tweet`\uFF0C\u5B8C\u6574\u6B63\u6587\u53EF\u80FD\u66F4\u957F\u3002",
      "> \u4E3A\u907F\u514D\u989D\u5916\u6D88\u8017 X \u7684\u9605\u8BFB\u989D\u5EA6\uFF0C\u672C\u5DE5\u5177\u4E0D\u4F1A\u4E3A\u6B64\u5355\u72EC\u62C9\u53D6 TweetDetail\u3002",
      ""
    );
  }
  if (tweet.retweetedFrom) {
    body.push(
      "## \u8F6C\u63A8\u81EA",
      "",
      `@${tweet.retweetedFrom.handle} \xB7 https://x.com/${tweet.retweetedFrom.handle}/status/${tweet.retweetedFrom.tweetId}`,
      ""
    );
  }
  if (entries.length > 0) {
    body.push("## \u5A92\u4F53", "");
    for (const entry of entries) {
      if (entry.kind === "poster") continue;
      const path = `assets/${entry.file}`;
      if (entry.kind === "photo") {
        body.push(`![\u56FE\u7247](${path})`, "");
        continue;
      }
      const poster = posterFor(entries, entry.file);
      const posterAttr = poster ? ` poster="assets/${poster.file}"` : "";
      body.push(
        `<video src="${path}" controls preload="metadata"${posterAttr}></video>`,
        ""
      );
      if (entry.note) body.push(`> ${entry.note}`, "");
    }
  }
  if (tweet.quoted) {
    body.push(
      "## \u5F15\u7528",
      "",
      `> @${tweet.quoted.handle} \xB7 https://x.com/${tweet.quoted.handle}/status/${tweet.quoted.tweetId}`,
      ">",
      ...tweet.quoted.text.split("\n").map((line) => `> ${line}`).slice(0, 20),
      ""
    );
  }
  if (skipped.length > 0) {
    body.push("## \u672A\u5B8C\u6210", "");
    for (const s of skipped) {
      body.push(`- \`${s.reason}\` ${s.detail}`);
      if (s.mediaUrl) body.push(`  - \u539F\u59CB\u5730\u5740\uFF1A${s.mediaUrl}`);
    }
    body.push("");
  }
  return [...front, ...body].join("\n");
}
var REASON_LABEL = {
  unavailable: "\u63A8\u6587\u5DF2\u5220\u9664\u6216\u4E0D\u53EF\u89C1",
  no_legacy: "\u54CD\u5E94\u7ED3\u6784\u7F3A\u5C11 legacy",
  hls_failed: "HLS \u5408\u5E76\u5931\u8D25",
  hls_drm: "HLS \u52A0\u5BC6\u4E0D\u652F\u6301",
  media_failed: "\u5A92\u4F53\u4E0B\u8F7D\u5931\u8D25",
  unparsed: "\u54CD\u5E94\u7ED3\u6784\u65E0\u6CD5\u89E3\u6790"
};
function renderSkippedMd(entries) {
  const lines = [
    "# \u8DF3\u8FC7\u6E05\u5355",
    "",
    `\u5171 ${entries.length} \u6761\u3002\u539F\u56E0\u5206\u7C7B\u89C1\u4E0B\u8868\uFF1B\u6761\u76EE\u4F1A\u968F\u6BCF\u6B21\u8FD0\u884C\u7D2F\u79EF\u3002`,
    "",
    "| # | \u63A8\u6587 | \u539F\u56E0 | \u8BE6\u60C5 |",
    "|---|---|---|---|"
  ];
  entries.forEach((e, i) => {
    const link = e.url ? `[${e.tweetId}](${e.url})` : e.tweetId;
    const detail = e.detail.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${i + 1} | ${link} | ${REASON_LABEL[e.reason]} | ${detail} |`);
  });
  lines.push("");
  return lines.join("\n");
}
function renderUnparsedJson(entries) {
  return JSON.stringify({ version: 1, generatedAt: nowIso(), count: entries.length, entries }, null, 2);
}
function renderReport(stats, extra) {
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
      balanced: sum === parts
    },
    unlike,
    skippedEntries: extra.skipped,
    ledgerTotal: extra.ledgerTotal,
    root: extra.root
  };
  return JSON.stringify(report, null, 2);
}
function summarize(stats) {
  const d = stats.download;
  return [
    `\u626B\u63CF ${stats.scanned} \u6761 / ${stats.rawResponses} \u4E2A\u54CD\u5E94`,
    `\u4E0B\u8F7D\uFF1A\u5B8C\u6210 ${d.done}\uFF0C\u90E8\u5206 ${d.partial}\uFF0C\u5931\u8D25 ${d.failed}\uFF0C\u4E0D\u53EF\u7528 ${d.unavailable}\uFF0C\u5408\u8BA1 ${d.total}`,
    `\u53D6\u6D88\u70B9\u8D5E\uFF1A\u5F85\u5904\u7406 ${stats.unlike.eligible}\uFF0C\u6210\u529F ${stats.unlike.done}\uFF0C\u672A\u786E\u8BA4 ${stats.unlike.unknown}`
  ].join("\uFF1B");
}

// src/page/ui.ts
function must(id) {
  const el2 = document.getElementById(id);
  if (!el2) throw new Error(`task.html \u7F3A\u5C11 #${id}`);
  return el2;
}
function btn(id) {
  return must(id);
}
var el = {
  badge: must("state-badge"),
  pauseBanner: must("pause-banner"),
  pauseText: must("pause-text"),
  btnReauth: btn("btn-reauth"),
  btnAbort: btn("btn-abort"),
  dirBadge: must("dir-badge"),
  dirHint: must("dir-hint"),
  btnPick: btn("btn-pick"),
  btnScan: btn("btn-scan"),
  btnScanPause: btn("btn-scan-pause"),
  btnScanStop: btn("btn-scan-stop"),
  scanCount: must("scan-count"),
  scanFresh: must("scan-fresh"),
  btnDownload: btn("btn-download"),
  btnDownloadPause: btn("btn-download-pause"),
  dlProgress: must("dl-progress"),
  dlDone: must("dl-done"),
  dlSkipped: must("dl-skipped"),
  dlFailed: must("dl-failed"),
  btnUnlikeDry: btn("btn-unlike-dry"),
  btnUnlike: btn("btn-unlike"),
  btnUnlikeStop: btn("btn-unlike-stop"),
  unlikePending: must("unlike-pending"),
  unlikeDone: must("unlike-done"),
  unlikeUnknown: must("unlike-unknown"),
  btnExport: btn("btn-export"),
  exportHint: must("export-hint"),
  log: must("log"),
  toastHost: must("toast-host")
};
var MAX_LOG_LINES = 400;
var queue = [];
var scheduled = false;
function stamp() {
  return (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
}
function log(text, tone) {
  const line = document.createElement("div");
  line.className = tone ? `line line--${tone}` : "line";
  line.textContent = `${stamp()} ${text}`;
  queue.push(line);
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flushLog);
  }
}
function flushLog() {
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
var TOAST_MS = 8e3;
var MAX_TOASTS = 3;
function toast(text, tone = "err") {
  const node = document.createElement("div");
  node.className = `toast toast--${tone}`;
  node.textContent = text;
  node.addEventListener("click", () => node.remove());
  el.toastHost.appendChild(node);
  while (el.toastHost.childElementCount > MAX_TOASTS) {
    el.toastHost.firstElementChild?.remove();
  }
  window.setTimeout(() => node.remove(), TOAST_MS);
}
var SCAN_LABEL = {
  idle: "\u7A7A\u95F2",
  scanning: "\u626B\u63CF\u4E2D",
  paused: "\u626B\u63CF\u5DF2\u6682\u505C",
  caught_up: "\u626B\u63CF\u5B8C\u6210",
  stopped: "\u626B\u63CF\u5DF2\u505C\u6B62"
};
function setBadge(text, tone) {
  el.badge.textContent = text;
  el.badge.className = tone ? `badge badge--${tone}` : "badge";
}
function renderState(state2, hasData, canUnlike) {
  if (state2.blockedReason) {
    setBadge("\u5DF2\u6682\u505C", "err");
  } else if (state2.download === "running") {
    setBadge("\u4E0B\u8F7D\u4E2D", "warn");
  } else if (state2.download === "paused") {
    setBadge("\u4E0B\u8F7D\u5DF2\u6682\u505C", "warn");
  } else if (state2.scan === "scanning") {
    setBadge("\u626B\u63CF\u4E2D", "warn");
  } else if (state2.unlike === "running") {
    setBadge("\u53D6\u6D88\u70B9\u8D5E\u4E2D", "warn");
  } else {
    setBadge(SCAN_LABEL[state2.scan]);
  }
  const scanning = state2.scan === "scanning";
  const scanPaused = state2.scan === "paused";
  el.btnScan.disabled = scanning || scanPaused;
  el.btnScanPause.disabled = !scanning && !scanPaused;
  el.btnScanPause.textContent = scanPaused ? "\u7EE7\u7EED" : "\u6682\u505C";
  el.btnScanStop.disabled = !scanning && !scanPaused;
  const dlActive = state2.download === "running" || state2.download === "paused";
  el.btnDownload.disabled = dlActive || !hasData;
  el.btnDownloadPause.disabled = !dlActive;
  el.btnDownloadPause.textContent = state2.download === "running" ? "\u6682\u505C" : "\u7EE7\u7EED\u4E0B\u8F7D";
  const canUnlikeNow = state2.unlike !== "running" && !dlActive;
  el.btnUnlikeDry.disabled = !canUnlikeNow;
  el.btnUnlike.disabled = !canUnlikeNow || !canUnlike;
  el.btnUnlikeStop.disabled = state2.unlike !== "running";
}
function showPause(text) {
  el.pauseText.textContent = text;
  el.pauseBanner.hidden = false;
}
function hidePause() {
  el.pauseBanner.hidden = true;
}
function renderScan(captured, fresh) {
  el.scanCount.textContent = String(captured);
  el.scanFresh.textContent = String(fresh);
}
function renderDownload(c) {
  el.dlProgress.textContent = `${c.done + c.skipped + c.failed} / ${c.total}\uFF08${humanBytes(c.bytes)}\uFF09`;
  el.dlDone.textContent = String(c.done);
  el.dlSkipped.textContent = String(c.skipped);
  el.dlFailed.textContent = String(c.failed);
}
function renderUnlike(c) {
  el.unlikePending.textContent = String(c.pending);
  el.unlikeDone.textContent = String(c.done);
  el.unlikeUnknown.textContent = String(c.unknown);
}
function setDir(label, tone) {
  el.dirBadge.textContent = label;
  el.dirBadge.className = tone ? `badge badge--${tone}` : "badge";
}
function setDirHint(text) {
  el.dirHint.textContent = text;
}
function setExportHint(text) {
  el.exportHint.textContent = text;
}

// src/page/task.ts
var UNLIKE_BUDGET = 300;
var IDLE_ROUNDS_TO_STOP = 20;
var PROBE_EVERY_TWEETS = 20;
var PROBE_EVERY_MS = 3e4;
var state = { scan: "idle", download: "idle", unlike: "idle" };
var runId = newRunId();
var startedAt = nowIso();
var cursor = 0;
var likesTabId = null;
var downloadRunning = false;
var downloadPaused = false;
var unlikeRunning = false;
var capturedIds = /* @__PURE__ */ new Set();
var knownIds = /* @__PURE__ */ new Set();
var freshCount = 0;
var rawResponses = 0;
var rateLimitHits = 0;
var scanSeen = 0;
var scanFresh = 0;
var lastScanLogAt = 0;
var lastScanEventAt = 0;
var sinceProbe = 0;
var lastProbeAt = 0;
var skipList = [];
var unparsed = [];
var dlState = {
  pending: 0,
  done: 0,
  partial: 0,
  failed: 0,
  unavailable: 0
};
var dlTotal = 0;
var dlBytes = 0;
var mdNames = /* @__PURE__ */ new Set();
var assetsCache = null;
async function assetsDir(root) {
  if (assetsCache && assetsCache.root === root) return assetsCache.dir;
  const dir = await ensureSubdir(root, ASSETS_DIR);
  assetsCache = { root, dir };
  return dir;
}
var unlikeCounters = { eligible: 0, pending: 0, done: 0, unknown: 0 };
function newRunId() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}-${time}-${Math.random().toString(36).slice(2, 6)}`;
}
function render() {
  const hasData = dlTotal > 0 || capturedIds.size > 0 || scanSeen > 0 || state.scan !== "idle";
  const canUnlike = dlState.done > 0 || unlikeCounters.eligible > 0;
  renderState(state, hasData, canUnlike);
}
function renderDownloadUi() {
  renderDownload({
    total: dlTotal,
    done: dlState.done,
    skipped: dlState.partial + dlState.unavailable,
    failed: dlState.failed,
    bytes: dlBytes
  });
  render();
}
function failClick(message) {
  log(message, "err");
  toast(message, "err");
}
function renderScanUi() {
  renderScan(Math.max(capturedIds.size, scanSeen), scanFresh);
}
function transition(before, after, bytesBefore, bytesAfter) {
  if (before) dlState[before]--;
  else dlTotal++;
  dlState[after]++;
  dlBytes += bytesAfter - bytesBefore;
}
function blockStorage(message) {
  if (state.blockedReason) return;
  state.blockedReason = message;
  showPause(message);
  log(`\u5B58\u50A8\u4E0D\u53EF\u7528\uFF1A${message}`, "err");
  render();
}
function unblockStorage() {
  if (!state.blockedReason) return;
  state.blockedReason = void 0;
  hidePause();
  log("\u5B58\u50A8\u5DF2\u6062\u590D\uFF0C\u7EE7\u7EED\u8FD0\u884C", "ok");
  render();
}
function handleStorageError(err) {
  if (err instanceof StorageUnavailableError) {
    blockStorage(err.message);
    return;
  }
  blockStorage(errorMessage(err));
}
async function sendCmd(tabId, cmd, payload) {
  const msg = {
    v: 1,
    kind: KIND.CMD,
    runId,
    cmd,
    ...payload !== void 0 ? { payload } : {}
  };
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg);
    return res?.diag ?? null;
  } catch (err) {
    log(`\u53D1\u9001\u547D\u4EE4 ${cmd} \u5931\u8D25\uFF1A${errorMessage(err)}`, "err");
    return null;
  }
}
function formatDiag(d) {
  return `\u5728\u70B9\u8D5E\u9875=${d.onLikesPage ? "\u662F" : "\u5426"}\uFF0C\u6CE8\u5165\u811A\u672C=${d.mainWorldReady ? "\u5DF2\u5C31\u7EEA" : "\u672A\u5C31\u7EEA"}/${d.tapAcked ? "\u5DF2\u786E\u8BA4" : "\u65E0\u56DE\u6267"}\uFF0C\u7F13\u51B2 ${d.buffered ?? 0} \u9875\uFF0C\u9875\u9762\u5DF2\u53D1 GraphQL ${d.seenGraphql ?? 0} \u4E2A\uFF08Likes ${d.seenLikes ?? 0} \u4E2A\uFF09`;
}
async function ensureLikesTab() {
  const patterns = [
    `https://x.com${LIKES_PAGE_PATH}*`,
    `https://twitter.com${LIKES_PAGE_PATH}*`
  ];
  let tab;
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    tab = tabs.find((t) => typeof t.id === "number");
  } catch {
  }
  if (!tab) {
    try {
      const all = await chrome.tabs.query({});
      tab = all.find(
        (t) => typeof t.id === "number" && (t.url ?? "").includes(LIKES_PAGE_PATH)
      );
    } catch {
    }
  }
  if (!tab || typeof tab.id !== "number") return null;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
  }
  return tab;
}
async function startScan() {
  if (state.blockedReason) {
    failClick("\u5B58\u50A8\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5148\u5904\u7406\u76EE\u5F55\u95EE\u9898");
    return;
  }
  const tab = await ensureLikesTab();
  if (!tab || typeof tab.id !== "number") {
    failClick(`\u8BF7\u5148\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00 https://x.com${LIKES_PAGE_PATH} \u518D\u5F00\u59CB\u626B\u63CF`);
    return;
  }
  likesTabId = tab.id;
  runId = newRunId();
  await kv.setActiveRunId(runId);
  knownIds.clear();
  for (const rec of await allRecords()) knownIds.add(rec.tweetId);
  state.scan = "scanning";
  scanSeen = 0;
  scanFresh = 0;
  lastScanLogAt = 0;
  lastScanEventAt = Date.now();
  renderScanUi();
  render();
  log(`\u5F00\u59CB\u626B\u63CF\uFF08run ${runId}\uFF09`);
  const d = await sendCmd(tab.id, "scan_start");
  if (!d) {
    state.scan = "idle";
    render();
    failClick(`\u5185\u5BB9\u811A\u672C\u65E0\u54CD\u5E94\u3002\u8BF7\u5728 https://x.com${LIKES_PAGE_PATH} \u4E0A\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5`);
    return;
  }
  if (d.onLikesPage && d.tapAcked) log(`\u81EA\u68C0\uFF1A${formatDiag(d)}`);
  else log(`\u81EA\u68C0\uFF1A${formatDiag(d)}`, "warn");
  if (!d.onLikesPage) {
    state.scan = "idle";
    render();
  }
}
function pauseScan(paused) {
  if (likesTabId === null) return;
  state.scan = paused ? "paused" : "scanning";
  render();
  void sendCmd(likesTabId, paused ? "scan_pause" : "scan_resume");
}
function stopScan() {
  state.scan = "stopped";
  render();
  if (likesTabId !== null) void sendCmd(likesTabId, "scan_stop");
}
async function maybeProbe(binding2) {
  const now = Date.now();
  if (sinceProbe < PROBE_EVERY_TWEETS && now - lastProbeAt < PROBE_EVERY_MS) return true;
  try {
    await probe(binding2.root);
    sinceProbe = 0;
    lastProbeAt = now;
    return true;
  } catch (err) {
    handleStorageError(err);
    return false;
  }
}
async function processTweet(tweet, batchRunId) {
  const binding2 = currentBinding();
  if (!binding2) {
    blockStorage("\u5C1A\u672A\u6388\u6743\u8F93\u51FA\u76EE\u5F55");
    return;
  }
  if (!await maybeProbe(binding2)) return;
  const prev = await getRecord(tweet.id);
  let before = prev?.state ?? null;
  let bytesBefore = prev?.bytes ?? 0;
  if (prev) {
    if (prev.state === "unavailable") return;
    if (prev.state === "done") {
      const mdName2 = prev.mdName ?? mdFileName(tweet, mdNames);
      if (await hasFile(binding2.root, mdName2)) return;
      log(`${mdName2} \u5DF2\u4E0D\u5B58\u5728\uFF0C\u91CD\u505A ${tweet.id}`, "warn");
      mdNames.delete(mdName2);
      await resetForRetry(prev);
      transition("done", "pending", prev.bytes, 0);
      before = "pending";
      bytesBefore = 0;
      renderDownloadUi();
    } else if (prev.attempts >= MAX_ATTEMPTS) {
      log(
        `\u5DF2\u5C1D\u8BD5 ${prev.attempts} \u6B21\u4ECD\u672A\u6210\u529F\uFF0C\u8DF3\u8FC7 ${tweet.id}\uFF08\u4E0A\u6B21\u539F\u56E0\uFF1A${prev.lastError ?? "\u672A\u8BB0\u5F55"}\uFF09`,
        "warn"
      );
      return;
    }
  }
  const mdName = prev?.mdName ?? mdFileName(tweet, mdNames);
  let assets;
  let outcome;
  try {
    assets = await assetsDir(binding2.root);
    log(`\u2193 ${mdName}\uFF08${tweet.media.length} \u4E2A\u5A92\u4F53\uFF09`);
    outcome = await downloadTweetMedia(
      tweet,
      assets,
      (file) => {
        log(`  \xB7 assets/${file}`);
      },
      // 命中限流后的退避要看得见，否则整批 await 会让面板像卡死一样安静。
      (text) => log(text, "warn")
    );
  } catch (err) {
    handleStorageError(err);
    return;
  }
  const nextState = outcome.skipped.length === 0 ? "done" : outcome.entries.length > 0 ? "partial" : "failed";
  const md = renderIndexMd(tweet, outcome.entries, outcome.skipped, nextState, batchRunId);
  try {
    await writeText(binding2.root, mdName, md);
  } catch (err) {
    handleStorageError(err);
    return;
  }
  mdNames.add(mdName);
  const mediaCount = outcome.entries.filter((e) => e.kind !== "poster").length;
  await recordDownload(tweet.id, batchRunId, {
    state: nextState,
    mdName,
    mediaCount,
    bytes: outcome.bytes,
    lastError: outcome.skipped.length > 0 ? outcome.skipped.map((s) => s.detail).join(" / ") : void 0
  });
  skipList.push(...outcome.skipped);
  transition(before, nextState, bytesBefore, outcome.bytes);
  knownIds.add(tweet.id);
  if (nextState === "done") {
    log(`\u2713 ${mdName} \u5B8C\u6210\uFF08${outcome.entries.length} \u4E2A\u6587\u4EF6\uFF0C${humanBytes(outcome.bytes)}\uFF09`, "ok");
  } else if (nextState === "partial") {
    log(`\u25B3 ${mdName} \u90E8\u5206\u5B8C\u6210\uFF0C${outcome.skipped.length} \u9879\u672A\u5B8C\u6210`, "warn");
  } else {
    log(
      `\xD7 ${mdName} \u5A92\u4F53\u5168\u90E8\u5931\u8D25\uFF1A${outcome.skipped[0]?.detail ?? ""}\uFF08md \u5DF2\u843D\u76D8\uFF0C\u9644\u4EF6\u7F3A\u5931\uFF09`,
      "err"
    );
  }
  renderDownloadUi();
}
async function consumeBatch(batch) {
  rawResponses = Math.max(rawResponses, batch.rawCount);
  await tweets.putMany(batch.tweets);
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
async function runDownloadLoop() {
  if (downloadRunning) return;
  if (!currentBinding()) {
    failClick("\u8BF7\u5148\u9009\u62E9\u8F93\u51FA\u76EE\u5F55\u5E76\u5B8C\u6210\u6388\u6743\uFF0C\u518D\u5F00\u59CB\u4E0B\u8F7D");
    return;
  }
  downloadRunning = true;
  downloadPaused = false;
  state.download = "running";
  render();
  log("\u5F00\u59CB\u4E0B\u8F7D\u4E0E\u5199\u76D8");
  mdNames.clear();
  for (const rec of await allRecords()) {
    if (rec.mdName) mdNames.add(rec.mdName);
  }
  let idle = 0;
  let processedAny = false;
  try {
    while (downloadRunning) {
      if (state.blockedReason) {
        await sleep(1e3);
        continue;
      }
      let batches;
      try {
        batches = await inbox.since(cursor);
      } catch (err) {
        log(`\u8BFB\u53D6\u5F85\u5904\u7406\u961F\u5217\u5931\u8D25\uFF1A${errorMessage(err)}`, "err");
        await sleep(2e3);
        continue;
      }
      if (batches.length === 0) {
        idle++;
        const scanSettled = state.scan === "caught_up" || state.scan === "stopped";
        if (scanSettled && idle >= IDLE_ROUNDS_TO_STOP) {
          if (!processedAny) {
            failClick(
              "\u5F85\u5904\u7406\u961F\u5217\u4E3A\u7A7A \u2014\u2014 \u626B\u63CF\u7ED3\u679C\u6CA1\u6709\u9001\u5230\u4EFB\u52A1\u9762\u677F\uFF0C\u8BF7\u91CD\u65B0\u626B\u63CF\u540E\u518D\u4E0B\u8F7D"
            );
          }
          break;
        }
        await sleep(1e3);
        continue;
      }
      idle = 0;
      processedAny = true;
      for (const batch of batches) {
        if (!downloadRunning) break;
        await consumeBatch(batch);
        if (state.blockedReason) break;
        if (batch.seq !== void 0) {
          cursor = batch.seq;
          await kv.setLastConsumedSeq(cursor);
        }
      }
    }
  } catch (err) {
    log(`\u4E0B\u8F7D\u5FAA\u73AF\u5F02\u5E38\uFF1A${errorMessage(err)}`, "err");
  } finally {
    downloadRunning = false;
    state.download = downloadPaused ? "paused" : "finished";
    render();
    if (downloadPaused) {
      log("\u4E0B\u8F7D\u5DF2\u6682\u505C", "warn");
      toast("\u4E0B\u8F7D\u5DF2\u6682\u505C\uFF0C\u70B9\u300C\u7EE7\u7EED\u4E0B\u8F7D\u300D\u53EF\u63A5\u7740\u8DD1", "warn");
    } else if (state.blockedReason) {
      log("\u4E0B\u8F7D\u4E2D\u65AD\uFF0C\u7B49\u5F85\u5904\u7406\u76EE\u5F55\u95EE\u9898", "err");
      toast(`\u4E0B\u8F7D\u4E2D\u65AD\uFF1A${state.blockedReason}`, "err");
    } else if (!processedAny) {
      log("\u4E0B\u8F7D\u9636\u6BB5\u7ED3\u675F\uFF1A\u6CA1\u6709\u53EF\u5904\u7406\u7684\u63A8\u6587", "warn");
    } else {
      const skipped = dlState.partial + dlState.unavailable;
      log("\u4E0B\u8F7D\u9636\u6BB5\u7ED3\u675F");
      toast(
        `\u4E0B\u8F7D\u5B8C\u6210\uFF1A\u5B8C\u6210 ${dlState.done}\uFF0C\u8DF3\u8FC7 ${skipped}\uFF0C\u5931\u8D25 ${dlState.failed}\uFF08${humanBytes(dlBytes)}\uFF09`,
        dlState.failed > 0 ? "warn" : "ok"
      );
    }
  }
}
async function startUnlike(dryRun) {
  if (unlikeRunning) return;
  if (state.blockedReason) {
    failClick("\u5B58\u50A8\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5148\u5904\u7406\u76EE\u5F55\u95EE\u9898");
    return;
  }
  const candidates = unlikeCandidates(await allRecords());
  if (candidates.length === 0) {
    failClick("\u6CA1\u6709\u53EF\u53D6\u6D88\u7684\u63A8\u6587\uFF08\u53EA\u53D6\u6D88\u4E0B\u8F7D\u6210\u529F\u7684\uFF0C\u4E14\u6700\u591A\u5C1D\u8BD5 2 \u6B21\uFF09");
    return;
  }
  const tab = await ensureLikesTab();
  if (!tab || typeof tab.id !== "number") {
    failClick(`\u8BF7\u5148\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00 https://x.com${LIKES_PAGE_PATH} \u518D\u53D6\u6D88\u70B9\u8D5E`);
    return;
  }
  const allowlist = candidates.map((r) => r.tweetId);
  const budget = Math.min(UNLIKE_BUDGET, allowlist.length);
  unlikeRunning = true;
  state.unlike = "running";
  if (!dryRun) {
    unlikeCounters.eligible = allowlist.length;
    unlikeCounters.pending = allowlist.length;
    unlikeCounters.done = 0;
    unlikeCounters.unknown = 0;
    renderUnlike(unlikeCounters);
  }
  render();
  log(
    dryRun ? `\u5E72\u8DD1\uFF1A\u5C06\u5339\u914D ${allowlist.length} \u6761\uFF08\u4E0D\u70B9\u51FB\uFF09` : `\u5F00\u59CB\u53D6\u6D88\u70B9\u8D5E\uFF1A\u5F85\u5904\u7406 ${allowlist.length} \u6761\uFF0C\u5355\u6B21\u4E0A\u9650 ${budget} \u6761`
  );
  await sendCmd(tab.id, dryRun ? "unlike_dry_run" : "unlike_start", {
    allowlist,
    budget,
    dryRun
  });
}
function stopUnlike() {
  if (likesTabId !== null) void sendCmd(likesTabId, "unlike_stop");
  unlikeRunning = false;
  state.unlike = "finished";
  render();
  log("\u5DF2\u8BF7\u6C42\u505C\u6B62\u53D6\u6D88\u70B9\u8D5E", "warn");
}
async function handleUnlikeResult(msg) {
  await recordUnlike(msg.tweetId, msg.ok, msg.reason);
  log(
    msg.ok ? `\u5DF2\u53D6\u6D88 ${msg.tweetId}` : `\u53D6\u6D88\u5931\u8D25 ${msg.tweetId}\uFF1A${msg.reason ?? "\u672A\u77E5\u539F\u56E0"}`,
    msg.ok ? "ok" : "warn"
  );
}
async function buildStats() {
  return {
    runId,
    startedAt,
    scanned: await tweets.count(),
    rawResponses,
    download: {
      total: dlTotal,
      done: dlState.done,
      partial: dlState.partial,
      failed: dlState.failed,
      unavailable: dlState.unavailable,
      bytes: dlBytes
    },
    unlike: {
      eligible: unlikeCounters.eligible,
      done: unlikeCounters.done,
      unknown: unlikeCounters.unknown,
      rateLimited: rateLimitHits
    }
  };
}
async function exportReports() {
  const binding2 = currentBinding();
  if (!binding2) {
    failClick("\u8BF7\u5148\u9009\u62E9\u8F93\u51FA\u76EE\u5F55\uFF0C\u518D\u5BFC\u51FA\u62A5\u544A");
    return;
  }
  try {
    const beeDir = await ensureSubdir(binding2.root, BEE_DIR);
    const stats = await buildStats();
    await writeText(beeDir, LEDGER_FILE, await exportLedgerJson());
    await writeText(
      beeDir,
      REPORT_FILE,
      renderReport(stats, {
        skipped: skipList.length,
        ledgerTotal: dlTotal,
        root: binding2.root.name
      })
    );
    await writeText(beeDir, SKIP_FILE, renderSkippedMd(skipList));
    await writeText(beeDir, UNPARSED_FILE, renderUnparsedJson(unparsed));
    setExportHint(`\u5DF2\u5199\u5165 ${binding2.root.name}/${BEE_DIR}/`);
    log(`\u62A5\u544A\u5DF2\u5BFC\u51FA\uFF1A${summarize(stats)}`, "ok");
  } catch (err) {
    handleStorageError(err);
  }
}
var picking = false;
async function onPick() {
  if (picking) return;
  picking = true;
  el.btnPick.disabled = true;
  try {
    const binding2 = await bindFromPicker();
    setDir(`\u5DF2\u6388\u6743\uFF1A${binding2.root.name}`, "ok");
    setDirHint(`\u8F93\u51FA\u76EE\u5F55\uFF1A${binding2.root.name}\uFF08\u63A2\u9488\u53EF\u5199\uFF09`);
    log(`\u5DF2\u7ED1\u5B9A\u8F93\u51FA\u76EE\u5F55 ${binding2.root.name}`, "ok");
    unblockStorage();
    renderDownloadUi();
  } catch (err) {
    if (err instanceof StorageUnavailableError && err.detail === "abort") {
      log("\u5DF2\u53D6\u6D88\u9009\u62E9\u76EE\u5F55");
    } else if (err instanceof StorageUnavailableError && err.detail === "picker-busy") {
      log(errorMessage(err), "warn");
    } else {
      failClick(`\u9009\u62E9\u76EE\u5F55\u5931\u8D25\uFF1A${errorMessage(err)}`);
    }
  } finally {
    picking = false;
    el.btnPick.disabled = false;
  }
}
async function onReauth() {
  log("\u6B63\u5728\u91CD\u65B0\u6388\u6743\u76EE\u5F55\u2026");
  try {
    const binding2 = await restoreBinding(true);
    if (!binding2) {
      failClick("\u672C\u5730\u6CA1\u6709\u4FDD\u5B58\u7684\u76EE\u5F55\u53E5\u67C4\uFF0C\u8BF7\u70B9\u300C\u9009\u62E9\u76EE\u5F55\u300D");
      return;
    }
    await probe(binding2.root);
    setDir(`\u5DF2\u6388\u6743\uFF1A${binding2.root.name}`, "ok");
    setDirHint(`\u8F93\u51FA\u76EE\u5F55\uFF1A${binding2.root.name}\uFF08\u63A2\u9488\u53EF\u5199\uFF09`);
    unblockStorage();
    renderDownloadUi();
  } catch (err) {
    failClick(`\u91CD\u65B0\u6388\u6743\u5931\u8D25\uFF1A${errorMessage(err)}\uFF1B\u53EF\u6539\u70B9\u300C\u9009\u62E9\u76EE\u5F55\u300D`);
  }
}
function onAbort() {
  downloadRunning = false;
  downloadPaused = false;
  unlikeRunning = false;
  state.download = "idle";
  state.unlike = "idle";
  if (state.scan === "scanning" || state.scan === "paused") stopScan();
  hidePause();
  state.blockedReason = void 0;
  render();
  log("\u5DF2\u4E2D\u6B62\u5F53\u524D\u4EFB\u52A1", "warn");
}
async function restoreOnLoad() {
  try {
    const binding2 = await restoreBinding(false);
    if (!binding2) {
      setDir("\u672A\u6388\u6743", "warn");
      log("\u5C1A\u672A\u6388\u6743\u8F93\u51FA\u76EE\u5F55\uFF0C\u8BF7\u70B9\u300C\u9009\u62E9\u76EE\u5F55\u300D\u9009\u4E2D LaCie \u76D8\u6216 x-medias \u76EE\u5F55");
      return;
    }
    setDir(`\u5DF2\u6388\u6743\uFF1A${binding2.root.name}`, "ok");
    setDirHint(`\u8F93\u51FA\u76EE\u5F55\uFF1A${binding2.root.name}`);
    log(`\u6062\u590D\u8F93\u51FA\u76EE\u5F55 ${binding2.root.name}`, "ok");
  } catch (err) {
    setDir("\u9700\u91CD\u65B0\u6388\u6743", "warn");
    log(`\u76EE\u5F55\u6743\u9650\u5DF2\u5931\u6548\uFF1A${errorMessage(err)}\uFF08\u53EF\u70B9\u300C\u91CD\u65B0\u6388\u6743\u300D\u6216\u300C\u9009\u62E9\u76EE\u5F55\u300D\uFF09`, "warn");
  }
}
async function loadCounters() {
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
  renderUnlike(unlikeCounters);
  renderDownloadUi();
}
function handlePageEvent(msg) {
  const data = msg.data ?? {};
  switch (msg.event) {
    case "scan_progress": {
      if (msg.detail && msg.detail !== "pong") log(msg.detail);
      if (typeof data.seenTotal === "number") {
        lastScanEventAt = Date.now();
        scanSeen = data.seenTotal;
        if (typeof data.fresh === "number") scanFresh = data.fresh;
        renderScanUi();
        const now = Date.now();
        if (now - lastScanLogAt >= 1e4) {
          lastScanLogAt = now;
          const responses = typeof data.responses === "number" ? data.responses : 0;
          log(`\u626B\u63CF\u4E2D\uFF1A\u5DF2\u6355\u83B7 ${scanSeen} \u6761 / \u54CD\u5E94 ${responses} \u4E2A`);
        }
      }
      if (typeof data.done === "number" && typeof data.unknown === "number") {
        unlikeCounters.done = data.done;
        unlikeCounters.unknown = data.unknown;
        if (typeof data.remaining === "number") unlikeCounters.pending = data.remaining;
        renderUnlike(unlikeCounters);
      }
      break;
    }
    case "caught_up": {
      state.scan = "caught_up";
      render();
      const total = Math.max(capturedIds.size, scanSeen);
      log(`\u626B\u63CF\u7ED3\u675F\uFF0C\u5171\u6355\u83B7 ${total} \u6761\uFF08\u65B0\u589E ${freshCount}\uFF09`, "ok");
      toast(`\u626B\u63CF\u5B8C\u6210\uFF1A\u5171\u6355\u83B7 ${total} \u6761\uFF0C\u65B0\u589E ${freshCount} \u6761`, "ok");
      if (Array.isArray(data.unparsed)) unparsed.push(...data.unparsed);
      break;
    }
    case "error_banner":
      log(`\u9875\u9762\u51FA\u73B0\u9519\u8BEF\u6A2A\u5E45\uFF1A${msg.detail ?? ""}\uFF0C\u5DF2\u81EA\u52A8\u9000\u907F 30 \u79D2`, "warn");
      break;
    case "rate_limited":
      rateLimitHits++;
      log(`\u547D\u4E2D\u9650\u6D41\uFF1A${msg.detail ?? ""}`, "warn");
      break;
    case "unlike_finished":
      unlikeRunning = false;
      state.unlike = "finished";
      if (typeof data.done === "number") unlikeCounters.done = data.done;
      if (typeof data.unknown === "number") unlikeCounters.unknown = data.unknown;
      if (typeof data.remaining === "number") unlikeCounters.pending = data.remaining;
      renderUnlike(unlikeCounters);
      render();
      log(
        `\u53D6\u6D88\u70B9\u8D5E\u7ED3\u675F\uFF1A\u6210\u529F ${unlikeCounters.done}\uFF0C\u672A\u786E\u8BA4 ${unlikeCounters.unknown}`,
        "ok"
      );
      toast(
        `\u53D6\u6D88\u70B9\u8D5E\u5B8C\u6210\uFF1A\u6210\u529F ${unlikeCounters.done}\uFF0C\u672A\u786E\u8BA4 ${unlikeCounters.unknown}`,
        unlikeCounters.unknown > 0 ? "warn" : "ok"
      );
      break;
    case "unlike_dry_run": {
      const ids = Array.isArray(data.ids) ? data.ids : [];
      unlikeRunning = false;
      state.unlike = "finished";
      render();
      log(`\u5E72\u8DD1\u7ED3\u675F\uFF1A\u5339\u914D\u5230 ${ids.length} \u6761\u5F85\u53D6\u6D88`, "ok");
      for (const id of ids.slice(0, 50)) log(`  \u5C06\u53D6\u6D88 ${String(id)}`);
      if (ids.length > 50) log(`  \u2026\u5176\u4F59 ${ids.length - 50} \u6761\u5DF2\u7701\u7565`);
      break;
    }
    case "nav_changed":
      break;
    case "fatal":
      log(`\u9519\u8BEF\uFF1A${msg.detail ?? ""}`, "err");
      if (Array.isArray(data.unparsed)) unparsed.push(...data.unparsed);
      if (data.diagnosis && typeof data.diagnosis === "object") {
        const d = data.diagnosis;
        log(
          `\u8BCA\u65AD\uFF1A\u6CE8\u5165\u811A\u672C=${d.mainWorldReady ? "\u5DF2\u5C31\u7EEA" : "\u672A\u5C31\u7EEA"}/${d.tapAcked ? "\u5DF2\u786E\u8BA4" : "\u65E0\u56DE\u6267"}\uFF0C\u5728\u70B9\u8D5E\u9875=${d.onLikesPage ? "\u662F" : "\u5426"}\uFF0C\u9875\u9762\u5DF2\u53D1 GraphQL ${d.graphqlSeen ?? "?"} \u4E2A\uFF08Likes ${d.likesSeen ?? "?"} \u4E2A\uFF09\uFF0C\u8017\u65F6 ${Math.round(Number(d.scannedMs ?? 0) / 1e3)}s`,
          "err"
        );
      }
      if (state.scan === "scanning") {
        state.scan = "stopped";
        render();
      }
      break;
  }
}
async function handleRuntimeMessage(message) {
  if (!isRuntimeMsg(message)) return;
  switch (message.kind) {
    case KIND.BATCH:
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
function bindButtons() {
  el.btnPick.addEventListener("click", () => void onPick());
  el.btnReauth.addEventListener("click", () => void onReauth());
  el.btnAbort.addEventListener("click", onAbort);
  el.btnScan.addEventListener("click", () => void startScan());
  el.btnScanPause.addEventListener("click", () => {
    pauseScan(state.scan !== "paused");
  });
  el.btnScanStop.addEventListener("click", stopScan);
  el.btnDownload.addEventListener("click", () => void runDownloadLoop());
  el.btnDownloadPause.addEventListener("click", () => {
    if (downloadRunning) {
      downloadPaused = true;
      downloadRunning = false;
      return;
    }
    void runDownloadLoop();
  });
  el.btnUnlikeDry.addEventListener("click", () => void startUnlike(true));
  el.btnUnlike.addEventListener("click", () => void startUnlike(false));
  el.btnUnlikeStop.addEventListener("click", stopUnlike);
  el.btnExport.addEventListener("click", () => void exportReports());
}
async function init() {
  render();
  log("\u4EFB\u52A1\u9762\u677F\u5DF2\u5C31\u7EEA");
  chrome.runtime.onMessage.addListener((message) => {
    void handleRuntimeMessage(message);
    return false;
  });
  bindButtons();
  window.setInterval(() => {
    if (state.scan !== "scanning") return;
    if (Date.now() - lastScanEventAt < 45e3) return;
    state.scan = "stopped";
    render();
    log("\u626B\u63CF\u8D85\u8FC7 45 \u79D2\u6CA1\u6709\u4EFB\u4F55\u8FDB\u5EA6\uFF0C\u5DF2\u5224\u5B9A\u4E3A\u4E2D\u65AD\uFF08\u53EF\u91CD\u65B0\u70B9\u300C\u5F00\u59CB\u626B\u63CF\u300D\uFF09", "warn");
  }, 1e4);
  cursor = await kv.getLastConsumedSeq();
  await restoreOnLoad();
  await loadCounters();
  render();
  log(`\u5DF2\u6D88\u8D39\u961F\u5217\u6E38\u6807 seq=${cursor}\uFF0C\u8D26\u672C ${dlTotal} \u6761`);
}
void init();
