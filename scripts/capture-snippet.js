/**
 * 阶段 0 抓包 snippet —— 在真实账号上核对 X 的响应形状。
 *
 * 用法：
 *   1. 打开 https://x.com/i/history/likes 并确认已登录
 *   2. DevTools → Sources → Snippets → 新建 → 粘贴本文件 → Cmd+Enter 运行
 *   3. 慢慢往下滚两屏，手动点掉一个赞（抓 UnfavoriteTweet）
 *   4. 控制台执行：__capture.summary()  看结论
 *                  __capture.skeleton() 看一条推文的 JSON 骨架
 *                  __capture.save()      导出 JSON，放进 tests/fixtures/captured/
 *                  __capture.stop()       卸载 patch
 *
 * 这个文件不参与构建，只是给人工核对用的工具。它刻意和被测代码分开写：
 * 抓包要尽量"照抄"页面原始数据，不能复用任何解析逻辑，否则形状假设错了也发现不了。
 */
(() => {
  const KEY = '__capture';

  if (window[KEY] && window[KEY].active) {
    console.warn('[capture] 已经装过了。先执行 __capture.stop() 再重新运行。');
    return;
  }

  const likes = [];
  const unfavorite = [];
  const rateLimits = [];
  const scrollSamples = [];
  const errors = [];

  const GRAPHQL = '/i/api/graphql/';
  const RETRY_TEXTS = [
    'Something went wrong',
    'Try again',
    'Retry',
    '重试',
    '出错了',
    '出现问题',
    '已达到上限',
    'Rate limit',
  ];

  /* ---------------- 归类与记录 ---------------- */

  function classify(url) {
    const s = String(url || '');
    if (!s.includes(GRAPHQL)) return null;
    const path = s.split('?')[0] || '';
    if (/\/Likes$/i.test(path)) return 'likes';
    if (/\/UnfavoriteTweet$/i.test(path)) return 'unfavorite';
    return null;
  }

  function interestingHeaders(read) {
    const out = {};
    try {
      read((value, name) => {
        if (/^(x-rate-limit|retry-after|content-type|x-client|x-transaction)/i.test(name)) {
          out[name.toLowerCase()] = value;
        }
      });
    } catch {
      /* ignore */
    }
    return out;
  }

  function record(kind, url, httpStatus, headers, reqBody, bodyText) {
    const entry = {
      kind,
      url,
      path: String(url).split('?')[0],
      queryId: (/\/graphql\/([^/]+)\//.exec(url) || [])[1] || null,
      httpStatus,
      headers,
      requestBody: typeof reqBody === 'string' ? reqBody.slice(0, 2000) : null,
      at: new Date().toISOString(),
      bodyLength: typeof bodyText === 'string' ? bodyText.length : 0,
    };

    try {
      entry.body = JSON.parse(bodyText);
    } catch {
      entry.bodyRaw = String(bodyText || '').slice(0, 4000);
    }

    if (kind === 'likes') likes.push(entry);
    else unfavorite.push(entry);
    if (httpStatus === 429) rateLimits.push(entry);

    console.info(
      `[capture] ${kind} HTTP ${httpStatus} queryId=${entry.queryId} ${entry.bodyLength}B`,
    );
    return entry;
  }

  /* ---------------- patch fetch ---------------- */

  const origFetch = window.fetch;

  window.fetch = function (...args) {
    const promise = origFetch.apply(this, args);

    try {
      const first = args[0];
      const url = typeof first === 'string' ? first : (first && first.url) || '';
      const kind = classify(url);

      if (kind) {
        const init = args[1] || {};
        const reqBody =
          typeof init.body === 'string'
            ? init.body
            : (first && typeof first.clone === 'function' && first.method === 'POST'
                ? '(Request body, 见下方 requestBodyHint)'
                : null);

        // 必须 clone 之后异步读；绝不能先读完再还给页面，否则页面的 .json() 会抛 body already read
        promise
          .then((res) => {
            try {
              const clone = res.clone();
              clone
                .text()
                .then((text) => {
                  try {
                    record(kind, url, res.status, interestingHeaders((cb) => res.headers.forEach(cb)), reqBody, text);
                  } catch (err) {
                    console.warn('[capture] 记录失败', err);
                  }
                })
                .catch(() => {});
            } catch (err) {
              console.warn('[capture] clone 失败', err);
            }
          })
          .catch(() => {});
      }
    } catch (err) {
      console.warn('[capture] fetch patch 内部异常（已忽略）', err);
    }

    return promise;
  };

  /* ---------------- patch XHR ---------------- */

  const xhrProto = XMLHttpRequest.prototype;
  const origOpen = xhrProto.open;
  const origSend = xhrProto.send;

  xhrProto.open = function (method, url, ...rest) {
    try {
      this.__captureUrl = url;
    } catch {
      /* ignore */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  xhrProto.send = function (...args) {
    try {
      const url = this.__captureUrl || '';
      const kind = classify(url);
      if (kind) {
        const reqBody = typeof args[0] === 'string' ? args[0] : null;
        this.addEventListener('loadend', () => {
          try {
            const headers = interestingHeaders((cb) => {
              for (const line of (this.getAllResponseHeaders() || '').split('\r\n')) {
                const i = line.indexOf(': ');
                if (i > 0) cb(line.slice(i + 2), line.slice(0, i));
              }
            });
            const text = this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : '';
            record(kind, url, this.status, headers, reqBody, text);
          } catch (err) {
            console.warn('[capture] XHR 记录失败', err);
          }
        });
      }
    } catch (err) {
      console.warn('[capture] XHR patch 内部异常（已忽略）', err);
    }
    return origSend.apply(this, args);
  };

  /* ---------------- 滚动节奏采样 ---------------- */

  const scrollTimer = setInterval(() => {
    scrollSamples.push({
      t: Date.now(),
      y: Math.round(window.scrollY),
      height: document.documentElement.scrollHeight,
      tweets: document.querySelectorAll('article[data-testid="tweet"]').length,
    });
    if (scrollSamples.length > 3000) scrollSamples.shift();
  }, 1000);

  /* ---------------- 检查工具 ---------------- */

  /** 时间线走的是 timeline_v2（旧）还是 timeline（新） */
  function timelineKind(body) {
    const result = body && body.data && body.data.user && body.data.user.result;
    if (!result) return 'unknown';
    if (result.timeline_v2) return 'timeline_v2';
    if (result.timeline) return 'timeline';
    return 'unknown';
  }

  function instructionsOf(body) {
    const result = body && body.data && body.data.user && body.data.user.result;
    const timeline = result && (result.timeline_v2 || result.timeline);
    return timeline && timeline.timeline && timeline.timeline.instructions;
  }

  /** 打印对象骨架：只到 depth 层，数组只取第一个元素 */
  function skeleton(value, depth = 4, indent = 0) {
    const pad = '  '.repeat(indent);
    if (depth <= 0) return `${pad}…`;
    if (Array.isArray(value)) {
      return value.length === 0
        ? `${pad}[]`
        : `${pad}[${value.length}]\n${skeleton(value[0], depth - 1, indent + 1)}`;
    }
    if (value === null) return `${pad}null`;
    if (typeof value !== 'object') return `${pad}${typeof value}`;
    return Object.entries(value)
      .map(([k, v]) =>
        v && typeof v === 'object'
          ? `${pad}${k}:\n${skeleton(v, depth - 1, indent + 1)}`
          : `${pad}${k}: ${v === null ? 'null' : typeof v}`,
      )
      .join('\n');
  }

  /** 找页面上的错误横幅，用来确认选择器与文案 */
  function findBanners() {
    const root = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    const hits = [];
    for (const node of root.querySelectorAll('span, div[role="button"], a[role="button"]')) {
      const text = (node.textContent || '').trim();
      if (!text || text.length > 40) continue;
      if (!RETRY_TEXTS.some((t) => text.includes(t))) continue;
      hits.push({ text, testid: node.getAttribute('data-testid'), html: node.outerHTML.slice(0, 400) });
    }
    return hits;
  }

  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  window[KEY] = {
    active: true,
    likes,
    unfavorite,
    rateLimits,
    scrollSamples,
    errors,

    summary() {
      const firstLikes = likes.find((e) => e.body);
      const out = {
        likesResponses: likes.length,
        likesPaths: [...new Set(likes.map((e) => e.path))],
        likesQueryIds: [...new Set(likes.map((e) => e.queryId))],
        timelineKind: firstLikes ? timelineKind(firstLikes.body) : '还没有数据',
        unfavoriteResponses: unfavorite.length,
        unfavoriteStatuses: [...new Set(unfavorite.map((e) => `${e.httpStatus} ${JSON.stringify((e.body && e.body.data) || null)}`))],
        rateLimited: rateLimits.length,
        rateLimitHeaders: rateLimits.map((e) => e.headers),
        scrollSamples: scrollSamples.length,
        banners: findBanners(),
      };
      console.log('[capture] 结论：', out);
      return out;
    },

    /** 一条推文的真实骨架 */
    skeleton(index = 0) {
      const entry = likes.filter((e) => e.body)[index];
      if (!entry) {
        console.warn('[capture] 还没有 Likes 响应');
        return null;
      }
      const instructions = instructionsOf(entry.body) || [];
      const add = instructions.find((i) => i && i.type === 'TimelineAddEntries');
      const entries = (add && add.entries) || [];
      console.log('[capture] instructions 类型：', instructions.map((i) => i && i.type));
      console.log('[capture] 前 3 个 entryId：', entries.slice(0, 3).map((e) => e && e.entryId));
      const tweet = entries.find((e) => e && String(e.entryId || '').startsWith('tweet-'));
      console.log('[capture] entry 骨架：\n' + skeleton(tweet, 6));
      console.log('[capture] 原始 entry：', tweet);
      return tweet;
    },

    banners: findBanners,
    timelineKindOf: timelineKind,
    skeletonOf: skeleton,

    save() {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download(`bee-likes-${stamp}.json`, likes);
      download(`bee-unfavorite-${stamp}.json`, {
        responses: unfavorite,
        rateLimits,
      });
      download(`bee-scroll-${stamp}.json`, scrollSamples);
      console.log('[capture] 已导出 3 个文件，请移动到 tests/fixtures/captured/');
    },

    stop() {
      window.fetch = origFetch;
      xhrProto.open = origOpen;
      xhrProto.send = origSend;
      clearInterval(scrollTimer);
      this.active = false;
      console.log('[capture] 已卸载 patch');
    },
  };

  console.log(
    [
      '[capture] 已开始抓包。请慢慢往下滚两屏，并手动点掉一个赞。',
      '  __capture.summary()   看结论',
      '  __capture.skeleton()  看一条推文的 JSON 骨架',
      '  __capture.save()      导出 JSON',
      '  __capture.stop()      卸载',
    ].join('\n'),
  );
})();