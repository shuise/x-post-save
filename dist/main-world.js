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
  var GRAPHQL_MARK = "/i/api/graphql/";
  function isGraphqlRequest(url) {
    return url.includes(GRAPHQL_MARK);
  }
  function matchEndpoint(url) {
    if (!isGraphqlRequest(url)) return null;
    const path = url.split("?")[0] ?? "";
    if (/\/Likes$/i.test(path)) return "likes";
    if (/\/UnfavoriteTweet$/i.test(path)) return "unfavorite";
    return null;
  }

  // src/shared/paths.ts
  var TIME_ZONE = "Asia/Shanghai";
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

  // src/shared/tweet-parse.ts
  function extractInstructions(data) {
    const d = data;
    const roots = [d?.data, d];
    for (const root of roots) {
      const result = root?.user?.result;
      const timeline = result?.timeline_v2 ?? result?.timeline;
      const instructions = timeline?.timeline?.instructions;
      if (Array.isArray(instructions)) return instructions;
    }
    return null;
  }
  function pageKeyFrom(url, body) {
    const queryId = /\/graphql\/([^/]+)\//.exec(url)?.[1] ?? "unknown";
    let cursor = "";
    const fromVars = (vars) => {
      if (typeof vars === "string") {
        try {
          cursor = String(JSON.parse(decodeURIComponent(vars))?.cursor ?? "");
        } catch {
        }
      } else if (vars && typeof vars === "object") {
        cursor = String(vars.cursor ?? "");
      }
    };
    try {
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      fromVars(parsed?.variables);
    } catch {
    }
    if (!cursor) {
      try {
        fromVars(new URL(url).searchParams.get("variables"));
      } catch {
      }
    }
    return `${queryId}:${cursor || "top"}`;
  }

  // src/content/main-world.ts
  var patchedKinds = /* @__PURE__ */ new Set(["likes"]);
  var gqlTotal = 0;
  var gqlLikes = 0;
  var reportedTotal = -1;
  var reportedLikes = -1;
  function post(msg) {
    try {
      window.postMessage({ [BEE_NS]: 1, ...msg }, location.origin);
    } catch {
    }
  }
  function postLikes(url, httpStatus, pageKey, instructions) {
    post({ from: "main", type: "likes_payload", payload: { url, httpStatus, pageKey, instructions } });
  }
  function postUnfavorite(tweetId, ok, httpStatus, bodyCode, retryAfterMs, bodyPreview) {
    post({
      from: "main",
      type: "unfavorite_result",
      payload: {
        tweetId,
        ok,
        httpStatus,
        ...bodyCode !== void 0 ? { bodyCode } : {},
        ...retryAfterMs !== void 0 ? { retryAfterMs } : {},
        ...bodyPreview ? { bodyPreview } : {}
      }
    });
  }
  function postRateLimit(url, httpStatus, resetAtMs) {
    post({
      from: "main",
      type: "rate_limit_observed",
      payload: {
        httpStatus,
        ...resetAtMs !== void 0 ? { resetAtMs } : {},
        endpoint: url.split("?")[0] ?? url
      }
    });
  }
  function postLikesUnparsed(url, httpStatus, data) {
    const d = data;
    const inner = d?.data;
    const keys = [
      ...Object.keys(typeof d === "object" && d !== null ? d : {}).map((k) => `root.${k}`),
      ...Object.keys(typeof inner === "object" && inner !== null ? inner : {}).map((k) => `data.${k}`)
    ].slice(0, 20);
    post({ from: "main", type: "likes_unparsed", payload: { url, httpStatus, keys } });
  }
  function trackRequest(url) {
    if (!url || !isGraphqlRequest(url)) return { kind: null, tapped: false };
    gqlTotal++;
    const kind = matchEndpoint(url);
    if (kind === "likes") gqlLikes++;
    return { kind, tapped: kind !== null && patchedKinds.has(kind) };
  }
  function startSightingsReporter() {
    window.setInterval(() => {
      try {
        if (gqlTotal === reportedTotal && gqlLikes === reportedLikes) return;
        reportedTotal = gqlTotal;
        reportedLikes = gqlLikes;
        post({
          from: "main",
          type: "graphql_seen",
          payload: { total: gqlTotal, likes: gqlLikes, tapped: patchedKinds.has("likes") }
        });
      } catch {
      }
    }, 5e3);
  }
  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (typeof URL !== "undefined" && input instanceof URL) return input.toString();
      if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    } catch {
    }
    return null;
  }
  async function readRequestBody(input, init) {
    try {
      const body = init?.body;
      if (typeof body === "string") return JSON.parse(body);
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        return Object.fromEntries(body);
      }
    } catch {
    }
    try {
      if (typeof Request !== "undefined" && input instanceof Request) {
        const text = await input.clone().text();
        return text ? JSON.parse(text) : void 0;
      }
    } catch {
    }
    return void 0;
  }
  function tweetIdFromBody(body) {
    const b = body;
    const v = b?.variables;
    const id = v?.tweet_id ?? v?.tweetId ?? b?.tweet_id;
    return id === void 0 || id === null ? null : String(id);
  }
  function graphqlErrorMessage(data) {
    const errors = data?.errors;
    if (!Array.isArray(errors) || errors.length === 0) return void 0;
    const code = errors[0]?.code;
    return typeof code === "number" ? code : void 0;
  }
  function resetAtFrom(res) {
    try {
      const reset = res.headers.get("x-rate-limit-reset");
      if (!reset) return void 0;
      const sec = Number(reset);
      return Number.isFinite(sec) && sec > 0 ? sec * 1e3 : void 0;
    } catch {
      return void 0;
    }
  }
  async function handleLikes(res, url, bodyPromise) {
    const copy = res.clone();
    const text = await copy.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const instructions = extractInstructions(data);
    if (!instructions) {
      postLikesUnparsed(url, res.status, data);
      return;
    }
    const body = await bodyPromise;
    postLikes(url, res.status, pageKeyFrom(url, body), instructions);
  }
  async function handleUnfavorite(res, bodyPromise) {
    const body = await bodyPromise;
    const tweetId = tweetIdFromBody(body);
    if (!tweetId) return;
    const resetAtMs = resetAtFrom(res);
    if (res.status === 429) {
      postUnfavorite(tweetId, false, res.status, 88, resetAtMs);
      return;
    }
    const copy = res.clone();
    const text = await copy.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      postUnfavorite(tweetId, res.ok, res.status, void 0, void 0, text.slice(0, 200));
      return;
    }
    const code = graphqlErrorMessage(data);
    if (code === 88) {
      postUnfavorite(tweetId, false, res.status, 88, resetAtMs, text.slice(0, 200));
      return;
    }
    if (!res.ok || code !== void 0) {
      postUnfavorite(tweetId, false, res.status, code, resetAtMs, text.slice(0, 200));
      return;
    }
    const d = data?.data;
    const done = d?.unfavorite_tweet === "Done" || d?.unfavorite_tweet === "done" || Boolean(d);
    postUnfavorite(tweetId, done, res.status);
  }
  function patchFetch() {
    const original = window.fetch;
    if (typeof original !== "function") return false;
    window.fetch = function patchedFetch(input, init) {
      let url = null;
      let kind = null;
      let bodyPromise = null;
      try {
        url = urlOf(input);
        const seen = trackRequest(url);
        kind = seen.tapped ? seen.kind : null;
        if (kind) {
          bodyPromise = readRequestBody(input, init);
        }
      } catch {
        kind = null;
      }
      const promise = original.call(window, input, init);
      try {
        if (kind && bodyPromise) {
          const activeKind = kind;
          const activeBody = bodyPromise;
          const activeUrl = url ?? "";
          promise.then((res) => {
            if (res.status === 429) postRateLimit(activeUrl, res.status, resetAtFrom(res));
            return activeKind === "likes" ? handleLikes(res, activeUrl, activeBody) : handleUnfavorite(res, activeBody);
          }).catch(() => {
          });
        } else if (url && isGraphqlRequest(url)) {
          const activeUrl = url;
          promise.then((res) => {
            if (res.status === 429) postRateLimit(activeUrl, res.status, resetAtFrom(res));
          }).catch(() => {
          });
        }
      } catch {
      }
      return promise;
    };
    return true;
  }
  function patchXhr() {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    if (typeof origOpen !== "function" || typeof origSend !== "function") return false;
    proto.open = function patchedOpen(...args) {
      try {
        const target = args[1];
        this.__beeUrl = typeof target === "string" ? target : String(target);
      } catch {
      }
      return origOpen.apply(this, args);
    };
    proto.send = function patchedSend(...args) {
      try {
        const url = this.__beeUrl;
        const seen = trackRequest(url ?? null);
        if (seen.tapped && seen.kind) {
          const kind = seen.kind;
          const bodyPromise = Promise.resolve(parseMaybeJson(args[0]));
          this.addEventListener("loadend", () => {
            void handleXhr(this, url ?? "", kind, bodyPromise);
          });
        }
      } catch {
      }
      return origSend.apply(this, args);
    };
    return true;
  }
  function parseMaybeJson(body) {
    if (typeof body !== "string") return void 0;
    try {
      return JSON.parse(body);
    } catch {
      return void 0;
    }
  }
  async function handleXhr(xhr, url, kind, bodyPromise) {
    try {
      if (xhr.responseType !== "" && xhr.responseType !== "text") return;
      const text = xhr.responseText;
      if (xhr.status === 429) postRateLimit(url, xhr.status);
      if (kind === "likes") {
        const data2 = JSON.parse(text);
        const instructions = extractInstructions(data2);
        if (!instructions) {
          postLikesUnparsed(url, xhr.status, data2);
          return;
        }
        postLikes(url, xhr.status, pageKeyFrom(url, await bodyPromise), instructions);
        return;
      }
      const body = await bodyPromise;
      const tweetId = tweetIdFromBody(body);
      if (!tweetId) return;
      if (xhr.status === 429) {
        postUnfavorite(tweetId, false, xhr.status, 88);
        return;
      }
      const data = JSON.parse(text);
      const code = graphqlErrorMessage(data);
      postUnfavorite(tweetId, xhr.status === 200 && code === void 0, xhr.status, code);
    } catch {
    }
  }
  var hasFetch = false;
  var hasXhr = false;
  function listenForTapConfig() {
    window.addEventListener(
      "message",
      (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!isBeeWindowMsg(d) || d.from !== "iso") return;
        if (d.type === "hello_ack") {
          post({
            from: "main",
            type: "tap_ack",
            enabled: patchedKinds.size > 0,
            wantEndpoints: [...patchedKinds],
            hasFetchPatch: hasFetch
          });
          return;
        }
        if (d.type !== "set_tap") return;
        patchedKinds.clear();
        if (d.enabled) {
          for (const e of d.wantEndpoints) {
            if (e === "likes" || e === "unfavorite") patchedKinds.add(e);
          }
        }
        post({
          from: "main",
          type: "tap_ack",
          enabled: patchedKinds.size > 0,
          wantEndpoints: [...patchedKinds],
          hasFetchPatch: hasFetch
        });
      },
      false
    );
  }
  function main() {
    try {
      hasFetch = patchFetch();
      hasXhr = patchXhr();
      listenForTapConfig();
      startSightingsReporter();
      post({
        from: "main",
        type: "hello",
        version: PROTOCOL_VERSION,
        hasFetchPatch: hasFetch,
        hasXhrPatch: hasXhr
      });
    } catch {
    }
  }
  main();
})();
