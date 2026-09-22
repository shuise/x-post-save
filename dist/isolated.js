"use strict";
(() => {
  // src/shared/protocol.ts
  var PROTOCOL_VERSION = 1;
  var BEE_NS = "__bee";
  function isBeeWindowMsg(data) {
    if (typeof data !== "object" || data === null) return false;
    const m = data;
    if (m[BEE_NS] !== 1) return false;
    if (m.from !== "main" && m.from !== "iso") return false;
    return typeof m.type === "string";
  }
  var KIND = {
    BATCH: "BEE_BATCH",
    PAGE_EVENT: "BEE_PAGE_EVENT",
    UNLIKE_RESULT: "BEE_UNLIKE_RESULT",
    CMD: "BEE_CMD"
  };
  function readUnlikePayload(payload) {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload;
    if (!Array.isArray(p.allowlist)) return null;
    return {
      allowlist: p.allowlist.filter((x) => typeof x === "string"),
      budget: typeof p.budget === "number" ? p.budget : 300,
      dryRun: p.dryRun === true
    };
  }

  // src/shared/paths.ts
  var TIME_ZONE = "Asia/Shanghai";
  var LIKES_PAGE_PATH = "/i/history/likes";
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
  function extFromUrl(url, fallback = "jpg") {
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").pop() ?? "";
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(last);
      if (m?.[1]) return m[1].toLowerCase();
      const fmt = u.searchParams.get("format");
      if (fmt && /^[A-Za-z0-9]{2,5}$/.test(fmt)) return fmt.toLowerCase();
    } catch {
    }
    return fallback;
  }

  // src/shared/tweet-parse.ts
  function parseLikesInstructions(instructions, pageKey, capturedAt) {
    const out = { tweets: [], unavailable: 0, unparsed: [] };
    if (!Array.isArray(instructions)) {
      out.unparsed.push({ reason: "instructions_not_array", keys: shapeKeys(instructions) });
      return out;
    }
    for (const instr of instructions) {
      if (!instr || instr.type !== "TimelineAddEntries") continue;
      const entries = instr.entries;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const entryId = typeof entry?.entryId === "string" ? entry.entryId : void 0;
        for (const itemContent of itemContentsOf(entry)) {
          handleItemContent(itemContent, entryId, pageKey, capturedAt, out);
        }
      }
    }
    return out;
  }
  function isTerminated(instructions) {
    if (!Array.isArray(instructions)) return false;
    return instructions.some(
      (i) => i?.type === "TimelineTerminateTimeline" && i?.direction === "Bottom"
    );
  }
  function shapeKeys(v) {
    if (typeof v !== "object" || v === null) return void 0;
    return Object.keys(v).slice(0, 24);
  }
  function itemContentsOf(entry) {
    const content = entry?.content;
    if (!content || typeof content !== "object") return [];
    if (Array.isArray(content.items)) {
      return content.items.map((it) => it?.item?.itemContent).filter((x) => x && typeof x === "object");
    }
    if (content.itemContent && typeof content.itemContent === "object") {
      return [content.itemContent];
    }
    return [];
  }
  function handleItemContent(ic, entryId, pageKey, capturedAt, out) {
    if (ic?.promotedMetadata) return;
    const result = ic?.tweet_results?.result;
    const norm = normalizeResult(result);
    if (norm.kind === "empty") return;
    if (norm.kind === "unavailable") {
      out.unavailable++;
      return;
    }
    if (norm.kind === "unknown") {
      out.unparsed.push({
        reason: "unknown_result",
        entryId,
        typename: result?.__typename,
        keys: shapeKeys(result)
      });
      return;
    }
    const tweet = norm.value;
    const legacy = tweet?.legacy;
    if (!legacy || typeof legacy !== "object") {
      out.unparsed.push({
        reason: "no_legacy",
        entryId,
        typename: tweet?.__typename,
        keys: shapeKeys(tweet)
      });
      return;
    }
    const id = String(tweet?.rest_id ?? legacy?.id_str ?? "");
    if (!id) {
      out.unparsed.push({ reason: "no_id", entryId, keys: shapeKeys(tweet) });
      return;
    }
    out.tweets.push(buildTweet(tweet, legacy, id, pageKey, capturedAt));
  }
  function normalizeResult(result) {
    if (!result || typeof result !== "object") return { kind: "empty" };
    switch (result.__typename) {
      case "TweetUnavailable":
      case "TweetTombstone":
        return { kind: "unavailable" };
      case "TweetWithVisibilityResults":
        return result.tweet && typeof result.tweet === "object" ? { kind: "tweet", value: result.tweet } : { kind: "unavailable" };
      case "Tweet":
        return { kind: "tweet", value: result };
      default:
        break;
    }
    if (result.legacy) return { kind: "tweet", value: result };
    if (result.tweet?.legacy) return { kind: "tweet", value: result.tweet };
    if (result.rest_id === void 0) return { kind: "empty" };
    return { kind: "unknown" };
  }
  function unwrapInner(result) {
    if (!result || typeof result !== "object") return void 0;
    if (result.__typename === "TweetWithVisibilityResults" && result.tweet) return result.tweet;
    if (result.legacy) return result;
    if (result.tweet?.legacy) return result.tweet;
    return void 0;
  }
  function buildTweet(tweet, legacy, id, pageKey, capturedAt) {
    const createdAtRaw = typeof legacy.created_at === "string" ? legacy.created_at : "";
    const parsedDate = parseTwitterDate(createdAtRaw);
    const createdAt = (parsedDate ?? /* @__PURE__ */ new Date(0)).toISOString();
    const noteText = tweet?.note_tweet?.result?.text;
    const isLongForm = typeof noteText === "string" && noteText.length > 0;
    const fullText = typeof legacy.full_text === "string" ? legacy.full_text : "";
    const text = isLongForm ? noteText : fullText;
    const maybeTruncated = !isLongForm && /…$/.test(fullText.trimEnd());
    const rtResult = unwrapInner(legacy.retweeted_status_result?.result);
    const isRetweet = Boolean(rtResult) || /^RT @/.test(fullText);
    const quotedResult = unwrapInner(legacy.quoted_status_result?.result);
    const isQuote = legacy.is_quote_status === true || Boolean(quotedResult);
    const kind = isRetweet ? "retweet" : isQuote ? "quote" : "original";
    const author = extractAuthor(tweet);
    const url = `https://x.com/${author.handle || "i"}/status/${id}`;
    const retweetedFrom = isRetweet && rtResult ? {
      handle: extractAuthor(rtResult).handle,
      tweetId: String(rtResult?.rest_id ?? rtResult?.legacy?.id_str ?? "")
    } : void 0;
    const quoted = isQuote && !isRetweet ? extractQuoted(quotedResult) : void 0;
    return {
      id,
      createdAt,
      createdAtRaw,
      text,
      isLongForm,
      maybeTruncated,
      ...typeof legacy.lang === "string" ? { lang: legacy.lang } : {},
      url,
      author,
      metrics: {
        likes: num(legacy.favorite_count),
        retweets: num(legacy.retweet_count),
        replies: num(legacy.reply_count),
        quotes: num(legacy.quote_count)
      },
      kind,
      ...retweetedFrom ? { retweetedFrom } : {},
      ...quoted ? { quoted } : {},
      media: extractMedia(legacy, rtResult),
      source: { pageKey, capturedAt }
    };
  }
  function extractAuthor(tweet) {
    const r = tweet?.core?.user_results?.result ?? {};
    const core = r.core ?? {};
    const legacy = r.legacy ?? {};
    const handle = String(core.screen_name ?? legacy.screen_name ?? "");
    const name = String(core.name ?? legacy.name ?? handle);
    const id = String(r.rest_id ?? legacy.id_str ?? "");
    const avatar = typeof legacy.profile_image_url_https === "string" ? legacy.profile_image_url_https : void 0;
    let verified;
    if (typeof r.is_blue_verified === "boolean") verified = r.is_blue_verified;
    else if (legacy.verified === true) verified = true;
    return {
      id,
      name,
      handle,
      ...avatar ? { avatar } : {},
      ...verified !== void 0 ? { verified } : {}
    };
  }
  function extractQuoted(quotedResult) {
    if (!quotedResult) return void 0;
    const qLegacy = quotedResult.legacy;
    const tweetId = String(quotedResult.rest_id ?? qLegacy?.id_str ?? "");
    if (!tweetId) return void 0;
    const author = extractAuthor(quotedResult);
    const text = typeof qLegacy?.full_text === "string" ? qLegacy.full_text : "";
    return { tweetId, handle: author.handle, text };
  }
  function extractMedia(legacy, rtResult) {
    const host = rtResult?.legacy ?? legacy;
    const raw = host?.extended_entities?.media ?? host?.entities?.media;
    if (!Array.isArray(raw)) return [];
    const items = [];
    for (const m of raw) {
      const type = m?.type;
      if (type === "photo") {
        const base = m?.media_url_https;
        if (typeof base !== "string") continue;
        items.push({ kind: "photo", url: originalPhotoUrl(base), ext: extFromUrl(base) });
        continue;
      }
      if (type === "video" || type === "animated_gif") {
        const variants = Array.isArray(m?.video_info?.variants) ? m.video_info.variants : [];
        const mp4 = pickBestMp4(variants);
        const hls = pickHls(variants);
        const poster = typeof m?.media_url_https === "string" ? originalPhotoUrl(m.media_url_https) : void 0;
        const durationMs = typeof m?.video_info?.duration_millis === "number" ? m.video_info.duration_millis : void 0;
        const extra = {
          ...mp4 ? { mp4 } : {},
          ...hls ? { hls } : {},
          ...poster ? { poster } : {}
        };
        items.push(
          type === "animated_gif" ? { kind: "gif", ...extra } : { kind: "video", ...extra, ...durationMs !== void 0 ? { durationMs } : {} }
        );
      }
    }
    return items;
  }
  function originalPhotoUrl(base) {
    try {
      const u = new URL(base);
      u.searchParams.set("name", "orig");
      return u.toString();
    } catch {
      return base;
    }
  }
  function pickBestMp4(variants) {
    const mp4s = variants.filter(
      (v) => v?.content_type === "video/mp4" && typeof v?.url === "string"
    );
    if (mp4s.length === 0) return void 0;
    mp4s.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    const best = mp4s[0];
    return { url: String(best.url), bitrate: Number(best.bitrate) || 0 };
  }
  function pickHls(variants) {
    const hls = variants.find(
      (v) => typeof v?.content_type === "string" && v.content_type.toLowerCase().includes("mpegurl") && typeof v?.url === "string"
    );
    return hls ? String(hls.url) : void 0;
  }
  function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  var MONTH_INDEX = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };
  function parseTwitterDate(raw) {
    const m = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(
      raw.trim()
    );
    if (!m) return null;
    const mon = MONTH_INDEX[(m[1] ?? "").toLowerCase()];
    if (mon === void 0) return null;
    const day = Number(m[2]);
    const hh = Number(m[3]);
    const mm = Number(m[4]);
    const ss = Number(m[5]);
    const sign = m[6] === "-" ? -1 : 1;
    const offsetMin = sign * (Number(m[7]) * 60 + Number(m[8]));
    const utc = Date.UTC(Number(m[9]), mon, day, hh, mm, ss);
    const d = new Date(utc - offsetMin * 6e4);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // src/shared/util.ts
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }
  function randomDelay(min, max) {
    return sleep(randomBetween(min, max));
  }
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function errorMessage(err) {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  // src/content/selectors.ts
  var SEL = {
    /** 一条推文的根节点 */
    tweet: 'article[data-testid="tweet"]',
    /** 已点亮（已点赞）的爱心按钮 */
    unlike: 'button[data-testid="unlike"]',
    /** 未点亮的爱心按钮，用于确认点击生效 */
    like: 'button[data-testid="like"]',
    /** 推文内部的时间元素，用它来区分外层推文与引用推文的卡片链接 */
    time: "time",
    /** 虚拟滚动的单元格 */
    cell: '[data-testid="cellInnerDiv"]',
    /** 主时间线容器，用于把错误横幅的搜索范围限制在时间线内 */
    primaryColumn: '[data-testid="primaryColumn"]'
  };
  var LIKES_PATH = LIKES_PAGE_PATH;
  var ERROR_BANNER_TEXTS = [
    "Something went wrong",
    "Try again",
    "Retry",
    "\u91CD\u8BD5",
    "\u51FA\u9519\u4E86",
    "\u51FA\u9519\u4E86\uFF0C\u8BF7\u91CD\u8BD5",
    "\u51FA\u73B0\u95EE\u9898"
  ];

  // src/content/isolated.ts
  var BATCH_SIZE = 20;
  var BATCH_INTERVAL_MS = 5e3;
  var SCROLL_MIN_MS = 800;
  var SCROLL_MAX_MS = 1600;
  var SCAN_IDLE_TIMEOUT_MS = 15e3;
  var SCAN_NO_DATA_TIMEOUT_MS = 3e4;
  var LIKES_BUFFER_MAX = 4;
  var UNLIKE_DELAY_MIN_MS = 1500;
  var UNLIKE_DELAY_MAX_MS = 4e3;
  var UNLIKE_CONFIRM_TIMEOUT_MS = 8e3;
  var UNLIKE_DOM_TIMEOUT_MS = 3e3;
  var MAX_PASSES = 3;
  var scan = {
    runId: "",
    active: false,
    paused: false,
    seen: /* @__PURE__ */ new Set(),
    pageKeys: /* @__PURE__ */ new Set(),
    pending: [],
    lastFlushAt: 0,
    rawResponses: 0,
    terminated: false,
    generation: 0
  };
  var unlike = {
    runId: "",
    active: false,
    budget: 300,
    allowlist: /* @__PURE__ */ new Set(),
    done: 0,
    unknown: 0,
    rateLimitedUntil: 0,
    consecutiveLimits: 0,
    generation: 0,
    dryRunIds: /* @__PURE__ */ new Set()
  };
  var pendingConfirm = /* @__PURE__ */ new Map();
  var mainWorldReady = false;
  var firstUnparsedLogged = false;
  var tapAcked = false;
  var tapArmedAt = 0;
  var tapWarned = false;
  var tapTimer = null;
  var likesBuffer = [];
  var likesBufferPath = "";
  var seenGraphql = 0;
  var seenLikes = 0;
  var noLikesWarned = false;
  var unparsedLikes = [];
  var outbox = [];
  var draining = false;
  function emit(msg) {
    outbox.push(msg);
    void drain();
  }
  function emitPageEvent(runId, event, detail, data) {
    emit({
      v: 1,
      kind: KIND.PAGE_EVENT,
      runId,
      event,
      ...detail !== void 0 ? { detail } : {},
      ...data !== void 0 ? { data } : {}
    });
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (outbox.length > 0) {
        const msg = outbox[0];
        if (!msg) break;
        let attempts = 0;
        for (; ; ) {
          try {
            await chrome.runtime.sendMessage(msg);
            outbox.shift();
            break;
          } catch {
            attempts++;
            if (attempts >= 20) {
              console.warn("[\u5C0F\u871C\u8702] \u6D88\u606F\u53D1\u9001\u5931\u8D25\uFF0C\u5DF2\u4E22\u5F03\u4E00\u6761", msg.kind);
              outbox.shift();
              break;
            }
            await sleep(Math.min(1e3 * attempts, 5e3));
          }
        }
      }
    } finally {
      draining = false;
    }
  }
  function setTap(enabled, wantEndpoints) {
    tapArmedAt = Date.now();
    try {
      window.postMessage(
        { [BEE_NS]: 1, from: "iso", type: "set_tap", enabled, wantEndpoints },
        location.origin
      );
    } catch {
    }
  }
  function armTap(enabled, wantEndpoints) {
    setTap(enabled, wantEndpoints);
    if (tapTimer !== null) return;
    tapTimer = window.setInterval(() => {
      if (tapAcked) return;
      if (Date.now() - tapArmedAt > 2e4) {
        if (!tapWarned) {
          tapWarned = true;
          console.warn("[\u5C0F\u871C\u8702] MAIN world \u672A\u56DE\u5E94 set_tap\uFF0C\u53D6\u6570\u4E0D\u53EF\u7528\uFF08\u53EF\u5C1D\u8BD5\u5237\u65B0\u9875\u9762\uFF09");
          emitPageEvent(scan.runId, "fatal", "\u6CE8\u5165\u811A\u672C\u672A\u5C31\u7EEA\uFF0C\u8BF7\u5237\u65B0 X \u9875\u9762\u540E\u91CD\u8BD5");
        }
        return;
      }
      setTap(enabled, wantEndpoints);
    }, 2e3);
  }
  function bufferLikes(payload) {
    const path = location.pathname.replace(/\/$/, "");
    if (path !== likesBufferPath) {
      likesBuffer.length = 0;
      likesBufferPath = path;
    }
    if (path !== LIKES_PATH) return;
    if (likesBuffer.some((b) => b.pageKey === payload.pageKey)) return;
    likesBuffer.push({ pageKey: payload.pageKey, payload });
    if (likesBuffer.length > LIKES_BUFFER_MAX) likesBuffer.shift();
  }
  function drainLikesBuffer() {
    if (likesBuffer.length === 0) return;
    const items = likesBuffer.splice(0, likesBuffer.length);
    for (const item of items) handleLikesPayload(item.payload);
  }
  function flushBatch(force = false) {
    if (!scan.active && !force) return;
    if (scan.pending.length === 0) return;
    const due = force || scan.pending.length >= BATCH_SIZE || Date.now() - scan.lastFlushAt >= BATCH_INTERVAL_MS;
    if (!due) return;
    const tweets = scan.pending.splice(0, scan.pending.length);
    scan.lastFlushAt = Date.now();
    emit({
      v: 1,
      kind: KIND.BATCH,
      runId: scan.runId,
      pageKey: tweets[0]?.source.pageKey ?? "unknown",
      tweets,
      rawCount: scan.rawResponses
    });
  }
  function handleLikesPayload(payload) {
    if (!scan.active) return;
    if (scan.pageKeys.has(payload.pageKey)) return;
    scan.pageKeys.add(payload.pageKey);
    scan.rawResponses++;
    if (isTerminated(payload.instructions)) scan.terminated = true;
    const outcome = parseLikesInstructions(payload.instructions, payload.pageKey, nowIso());
    if (outcome.unparsed.length > 0 && !firstUnparsedLogged) {
      firstUnparsedLogged = true;
      console.warn("[\u5C0F\u871C\u8702] \u51FA\u73B0\u65E0\u6CD5\u8BC6\u522B\u7684\u54CD\u5E94\u7ED3\u6784\uFF0C\u5DF2\u8BB0\u5F55\uFF1A", outcome.unparsed.slice(0, 3));
      emitPageEvent(scan.runId, "fatal", "\u89E3\u6790\u7ED3\u6784\u5F02\u5E38", {
        unparsed: outcome.unparsed.slice(0, 10)
      });
    }
    for (const tweet of outcome.tweets) {
      if (scan.seen.has(tweet.id)) continue;
      scan.seen.add(tweet.id);
      scan.pending.push(tweet);
    }
    flushBatch();
  }
  function handleUnfavoriteResult(payload) {
    const isRateLimited = payload.httpStatus === 429 || payload.bodyCode === 88;
    if (isRateLimited) {
      unlike.consecutiveLimits++;
      const backoff = payload.retryAfterMs ? Math.max(0, payload.retryAfterMs - Date.now()) + randomBetween(2e3, 5e3) : Math.min(3e4 * 2 ** (unlike.consecutiveLimits - 1), 3e5);
      unlike.rateLimitedUntil = Date.now() + backoff;
      emitPageEvent(unlike.runId, "rate_limited", `\u547D\u4E2D\u9650\u6D41\uFF0C\u9000\u907F ${Math.round(backoff / 1e3)}s`, {
        httpStatus: payload.httpStatus,
        bodyCode: payload.bodyCode,
        consecutive: unlike.consecutiveLimits
      });
    } else {
      unlike.consecutiveLimits = 0;
    }
    const resolve = pendingConfirm.get(payload.tweetId);
    if (!resolve) return;
    if (isRateLimited) {
      resolve({ ok: false, reason: "rate_limited" });
      return;
    }
    resolve(payload.ok ? { ok: true } : { ok: false, reason: `http_${payload.httpStatus}` });
  }
  function handleWindowMessage(ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!isBeeWindowMsg(d) || d.from !== "main") return;
    switch (d.type) {
      case "hello":
        mainWorldReady = d.hasFetchPatch;
        if (!d.hasFetchPatch) {
          console.warn("[\u5C0F\u871C\u8702] MAIN world \u672A\u80FD patch fetch\uFF0C\u53D6\u6570\u5C06\u4E0D\u53EF\u7528");
        }
        break;
      case "tap_ack":
        mainWorldReady = d.hasFetchPatch;
        tapAcked = true;
        console.info(
          `[\u5C0F\u871C\u8702] \u6CE8\u5165\u811A\u672C\u5DF2\u5C31\u7EEA\uFF1Afetch=${d.hasFetchPatch}\uFF0C\u76D1\u542C=${d.wantEndpoints.join(",") || "\u65E0"}`
        );
        break;
      case "graphql_seen":
        seenGraphql = d.payload.total;
        seenLikes = d.payload.likes;
        if (scan.active && seenLikes === 0 && !noLikesWarned) {
          noLikesWarned = true;
          emitPageEvent(
            scan.runId,
            "scan_progress",
            `\u63D0\u9192\uFF1A\u9875\u9762\u5DF2\u53D1\u51FA ${seenGraphql} \u4E2A GraphQL \u8BF7\u6C42\uFF0C\u5176\u4E2D 0 \u4E2A\u662F Likes \u2014\u2014 \u8BF7\u786E\u8BA4\u505C\u7559\u5728\u70B9\u8D5E\u9875\u5E76\u4FDD\u6301\u5411\u4E0B\u6EDA\u52A8`
          );
        }
        break;
      case "likes_unparsed":
        unparsedLikes.push({
          reason: "extract_instructions_null",
          url: d.payload.url.split("?")[0] ?? d.payload.url,
          httpStatus: d.payload.httpStatus,
          keys: d.payload.keys
        });
        if (!firstUnparsedLogged) {
          firstUnparsedLogged = true;
          emitPageEvent(scan.runId, "fatal", "Likes \u54CD\u5E94\u7ED3\u6784\u65E0\u6CD5\u8BC6\u522B\uFF08\u5DF2\u8BB0\u5F55\u5230 unparsed.json\uFF09", {
            unparsed: unparsedLikes.slice(0, 10)
          });
        }
        break;
      case "likes_payload":
        bufferLikes(d.payload);
        handleLikesPayload(d.payload);
        break;
      case "unfavorite_result":
        handleUnfavoriteResult(d.payload);
        break;
      case "rate_limit_observed":
        if (unlike.active) {
          unlike.rateLimitedUntil = Math.max(
            unlike.rateLimitedUntil,
            d.payload.resetAtMs ? d.payload.resetAtMs + randomBetween(2e3, 5e3) : Date.now() + 3e4
          );
          emitPageEvent(unlike.runId, "rate_limited", `\u63A5\u53E3\u8FD4\u56DE ${d.payload.httpStatus}`, {
            endpoint: d.payload.endpoint
          });
        }
        break;
    }
  }
  function docHeight() {
    return document.documentElement.scrollHeight;
  }
  function isOnLikesPage() {
    return location.pathname.replace(/\/$/, "") === LIKES_PATH;
  }
  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
  function scrollDownOneViewport() {
    window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "auto" });
  }
  function scrollToBottom() {
    window.scrollTo({ top: docHeight(), behavior: "auto" });
  }
  function findErrorBanner() {
    const root = document.querySelector(SEL.primaryColumn) ?? document.body;
    if (!root) return null;
    const nodes = root.querySelectorAll('span, div[role="button"], a[role="button"]');
    for (const node of nodes) {
      const text = (node.textContent ?? "").trim();
      if (!text || text.length > 40) continue;
      if (ERROR_BANNER_TEXTS.includes(text)) return node;
    }
    return null;
  }
  function tweetIdOf(article) {
    const anchors = article.querySelectorAll('a[href*="/status/"]');
    for (const a of anchors) {
      if (!a.querySelector(SEL.time)) continue;
      const m = /\/status\/(\d+)/.exec(a.getAttribute("href") ?? "");
      if (m?.[1]) return m[1];
    }
    return null;
  }
  function mountedTweets() {
    const out = [];
    for (const article of document.querySelectorAll(SEL.tweet)) {
      const id = tweetIdOf(article);
      if (id) out.push({ id, article });
    }
    return out;
  }
  async function runScan(runId) {
    if (!isOnLikesPage()) {
      emitPageEvent(runId, "fatal", "\u8BF7\u5148\u6253\u5F00 https://x.com/i/history/likes \u518D\u5F00\u59CB\u626B\u63CF");
      return;
    }
    const generation = ++scan.generation;
    scan.runId = runId;
    scan.active = true;
    scan.paused = false;
    scan.seen.clear();
    scan.pageKeys.clear();
    scan.pending = [];
    scan.rawResponses = 0;
    scan.terminated = false;
    scan.lastFlushAt = Date.now();
    noLikesWarned = false;
    const startedAt = Date.now();
    let lastGrowthAt = startedAt;
    let lastSeen = scan.seen.size;
    let lastHeight = -1;
    let lastResponses = scan.pageKeys.size;
    try {
      armTap(true, ["likes"]);
      drainLikesBuffer();
      emitPageEvent(runId, "scan_progress", "\u5F00\u59CB\u626B\u63CF", { seenTotal: scan.seen.size, fresh: 0 });
      lastSeen = scan.seen.size;
      lastResponses = scan.pageKeys.size;
      lastGrowthAt = Date.now();
      while (scan.active && scan.generation === generation) {
        if (scan.paused) {
          await sleep(500);
          continue;
        }
        if (scan.terminated && scan.pageKeys.size > 0) break;
        const banner = findErrorBanner();
        if (banner) {
          emitPageEvent(runId, "error_banner", banner.textContent?.trim() ?? "", {
            seenTotal: scan.seen.size
          });
          await sleep(3e4);
          if (scan.generation !== generation) break;
          continue;
        }
        scrollToBottom();
        await sleep(randomBetween(SCROLL_MIN_MS, SCROLL_MAX_MS));
        if (scan.generation !== generation) break;
        flushBatch();
        const now = Date.now();
        const height = docHeight();
        const seenNow = scan.seen.size;
        const responses = scan.pageKeys.size;
        const fresh = seenNow - lastSeen;
        const grew = height !== lastHeight;
        const newResponse = responses !== lastResponses;
        lastSeen = seenNow;
        lastHeight = height;
        lastResponses = responses;
        if (fresh > 0 || grew || newResponse) lastGrowthAt = now;
        emitPageEvent(runId, "scan_progress", void 0, {
          seenTotal: seenNow,
          fresh,
          responses,
          scrollTop: Math.round(window.scrollY),
          height
        });
        if (responses === 0) {
          if (now - startedAt > SCAN_NO_DATA_TIMEOUT_MS) {
            emitPageEvent(runId, "fatal", "\u626B\u63CF\u671F\u95F4\u672A\u6355\u83B7\u5230\u4EFB\u4F55 Likes \u54CD\u5E94", {
              diagnosis: {
                onLikesPage: isOnLikesPage(),
                graphqlSeen: seenGraphql,
                likesSeen: seenLikes,
                tapAcked,
                mainWorldReady,
                scannedMs: now - startedAt
              }
            });
            break;
          }
          continue;
        }
        if (now - lastGrowthAt > SCAN_IDLE_TIMEOUT_MS) break;
      }
    } catch (err) {
      emitPageEvent(runId, "fatal", `\u626B\u63CF\u5F02\u5E38\uFF1A${errorMessage(err)}`);
    } finally {
      if (scan.generation !== generation) return;
      flushBatch(true);
      scan.active = false;
      setTap(true, ["likes"]);
      emitPageEvent(runId, "caught_up", "\u626B\u63CF\u7ED3\u675F", {
        seenTotal: scan.seen.size,
        responses: scan.pageKeys.size,
        ...unparsedLikes.length > 0 ? { unparsed: unparsedLikes.slice(0, 20) } : {}
      });
    }
  }
  function waitForConfirm(tweetId) {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingConfirm.delete(tweetId);
        resolve({ ok: false, reason: "unconfirmed" });
      }, UNLIKE_CONFIRM_TIMEOUT_MS);
      pendingConfirm.set(tweetId, (r) => {
        window.clearTimeout(timer);
        pendingConfirm.delete(tweetId);
        resolve(r);
      });
    });
  }
  async function waitForDomToggle(article) {
    const deadline = Date.now() + UNLIKE_DOM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!article.querySelector(SEL.unlike)) return true;
      await sleep(200);
    }
    return false;
  }
  async function runUnlike(runId, payload) {
    if (!isOnLikesPage()) {
      emitPageEvent(runId, "fatal", "\u8BF7\u5148\u6253\u5F00 https://x.com/i/history/likes \u518D\u53D6\u6D88\u70B9\u8D5E");
      return;
    }
    const generation = ++unlike.generation;
    unlike.runId = runId;
    unlike.active = true;
    unlike.budget = Math.max(1, payload.budget);
    unlike.allowlist = new Set(payload.allowlist);
    unlike.done = 0;
    unlike.unknown = 0;
    unlike.rateLimitedUntil = 0;
    unlike.consecutiveLimits = 0;
    unlike.dryRunIds = /* @__PURE__ */ new Set();
    setTap(true, ["unfavorite"]);
    emitPageEvent(runId, "scan_progress", payload.dryRun ? "\u5E72\u8DD1\u5F00\u59CB" : "\u53D6\u6D88\u70B9\u8D5E\u5F00\u59CB", {
      eligible: unlike.allowlist.size
    });
    try {
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        if (!unlike.active || unlike.generation !== generation) break;
        let handledThisPass = 0;
        scrollToTop();
        await sleep(800);
        for (; ; ) {
          if (!unlike.active || unlike.generation !== generation) break;
          const waitMs = unlike.rateLimitedUntil - Date.now();
          if (waitMs > 0) {
            if (unlike.consecutiveLimits >= 5) {
              emitPageEvent(runId, "rate_limited", "\u8FDE\u7EED\u9650\u6D41\uFF0C\u5DF2\u6682\u505C\u53D6\u6D88\u70B9\u8D5E\u9636\u6BB5", {
                consecutive: unlike.consecutiveLimits
              });
              return;
            }
            await sleep(Math.min(waitMs, 6e4));
            continue;
          }
          const candidates = mountedTweets().filter(
            (t) => unlike.allowlist.has(t.id) && !unlike.dryRunIds.has(t.id)
          );
          if (candidates.length === 0 && handledThisPass > 0) break;
          for (const candidate of candidates) {
            if (!unlike.active || unlike.generation !== generation) break;
            if (payload.dryRun) {
              unlike.dryRunIds.add(candidate.id);
              handledThisPass++;
              continue;
            }
            if (unlike.done + unlike.unknown >= unlike.budget) {
              emitPageEvent(runId, "unlike_finished", "\u5DF2\u8FBE\u5230\u5355\u6B21\u8FD0\u884C\u4E0A\u9650", {
                done: unlike.done,
                unknown: unlike.unknown,
                reason: "budget"
              });
              return;
            }
            const button = candidate.article.querySelector(SEL.unlike);
            if (!(button instanceof HTMLElement)) {
              unlike.unknown++;
              emit({
                v: 1,
                kind: KIND.UNLIKE_RESULT,
                runId,
                tweetId: candidate.id,
                ok: false,
                reason: "no_button"
              });
              continue;
            }
            button.scrollIntoView({ block: "center", behavior: "auto" });
            await randomDelay(150, 400);
            if (!unlike.active || unlike.generation !== generation) break;
            unlike.allowlist.delete(candidate.id);
            button.click();
            handledThisPass++;
            const toggled = await waitForDomToggle(candidate.article);
            const confirmed = await waitForConfirm(candidate.id);
            if (confirmed.ok) {
              unlike.done++;
              emit({ v: 1, kind: KIND.UNLIKE_RESULT, runId, tweetId: candidate.id, ok: true });
            } else {
              unlike.unknown++;
              emit({
                v: 1,
                kind: KIND.UNLIKE_RESULT,
                runId,
                tweetId: candidate.id,
                ok: false,
                reason: toggled ? confirmed.reason ?? "unconfirmed" : "dom_not_toggled"
              });
            }
            emitPageEvent(runId, "scan_progress", void 0, {
              done: unlike.done,
              unknown: unlike.unknown,
              remaining: unlike.allowlist.size
            });
            await randomDelay(UNLIKE_DELAY_MIN_MS, UNLIKE_DELAY_MAX_MS);
            if (unlike.rateLimitedUntil > Date.now()) break;
          }
          scrollDownOneViewport();
          await sleep(randomBetween(700, 1400));
        }
        if (payload.dryRun) break;
        if (handledThisPass === 0) break;
      }
    } catch (err) {
      emitPageEvent(runId, "fatal", `\u53D6\u6D88\u70B9\u8D5E\u5F02\u5E38\uFF1A${errorMessage(err)}`);
    } finally {
      unlike.active = false;
      setTap(true, ["likes"]);
      if (payload.dryRun) {
        emitPageEvent(runId, "unlike_dry_run", "\u5E72\u8DD1\u7ED3\u675F", {
          ids: [...unlike.dryRunIds],
          count: unlike.dryRunIds.size
        });
      } else {
        emitPageEvent(runId, "unlike_finished", "\u53D6\u6D88\u70B9\u8D5E\u7ED3\u675F", {
          done: unlike.done,
          unknown: unlike.unknown,
          remaining: unlike.allowlist.size
        });
      }
    }
  }
  function diag() {
    return {
      href: location.href,
      onLikesPage: isOnLikesPage(),
      scanActive: scan.active,
      unlikeActive: unlike.active,
      tapAcked,
      mainWorldReady,
      seenGraphql,
      seenLikes,
      buffered: likesBuffer.length
    };
  }
  function handleCommand(msg) {
    if (msg.kind !== KIND.CMD) return;
    switch (msg.cmd) {
      case "scan_start":
        void runScan(msg.runId);
        break;
      case "scan_pause":
        scan.paused = true;
        break;
      case "scan_resume":
        scan.paused = false;
        break;
      case "scan_stop":
        scan.active = false;
        scan.paused = false;
        break;
      case "unlike_start": {
        if (unlike.active) return;
        const payload = readUnlikePayload(msg.payload);
        if (!payload) {
          emitPageEvent(msg.runId, "fatal", "\u53D6\u6D88\u70B9\u8D5E\u53C2\u6570\u65E0\u6548");
          return;
        }
        void runUnlike(msg.runId, { ...payload, dryRun: false });
        break;
      }
      case "unlike_dry_run": {
        if (unlike.active) return;
        const payload = readUnlikePayload(msg.payload);
        if (!payload) {
          emitPageEvent(msg.runId, "fatal", "\u5E72\u8DD1\u53C2\u6570\u65E0\u6548");
          return;
        }
        void runUnlike(msg.runId, { ...payload, dryRun: true });
        break;
      }
      case "unlike_stop":
        unlike.active = false;
        break;
      case "ping":
        emitPageEvent(msg.runId, "scan_progress", "pong", {
          onLikesPage: isOnLikesPage(),
          mainWorldReady
        });
        break;
    }
  }
  function init() {
    window.addEventListener("message", handleWindowMessage, false);
    chrome.runtime.onMessage.addListener(
      (message, _sender, sendResponse) => {
        if (typeof message === "object" && message !== null) {
          const m = message;
          if (m.kind === KIND.CMD) {
            handleCommand(message);
            sendResponse({ ok: true, diag: diag() });
          }
        }
        return false;
      }
    );
    armTap(true, ["likes"]);
    window.postMessage(
      { [BEE_NS]: 1, from: "iso", type: "hello_ack", version: PROTOCOL_VERSION },
      location.origin
    );
    console.info(`[\u5C0F\u871C\u8702] \u5185\u5BB9\u811A\u672C\u5DF2\u5C31\u7EEA\uFF08\u534F\u8BAE v${PROTOCOL_VERSION}\uFF09`);
  }
  init();
})();
