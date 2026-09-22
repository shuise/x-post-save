import { errorMessage, sleep } from '../shared/util';
import { openWritable } from './fs';

/**
 * 极简 HLS。只在没有任何 mp4 变体时才走这里。
 *
 * X 的 HLS 用 fMP4（.m4s）而不是 MPEG-TS，init segment + 分片直接拼接就是合法 mp4，
 * 不需要 transmux、不需要 hls.js。所以这里只做最小实现：
 *   master → 选最高 BANDWIDTH 的 variant → 收集 KEY / MAP / 分片 → 顺序 fetch → 边下边写。
 *
 * 刻意不做的事：BYTERANGE 分片（X 不用）、非 AES-128 加密、DRM —— 遇到就直接失败进跳过清单，
 * 让单条 HLS 拖不垮整个任务。
 */

const SEGMENT_FAIL_LIMIT = 3;
const FETCH_TIMEOUT_MS = 30_000;

export type HlsOutcome =
  | { ok: true; file: string; bytes: number; ext: 'mp4' | 'ts'; segments: number }
  | { ok: false; reason: 'drm' | 'fetch' | 'parse' | 'write'; detail: string };

type KeyInfo = { method: string; uri: string; iv?: Uint8Array<ArrayBuffer> };

type MediaPlaylist = {
  segments: string[];
  init?: string;
  key?: KeyInfo;
  /** 只支持整条流用同一把密钥，出现多把就判失败 */
  keyUris: Set<string>;
  byterange: boolean;
  sequence: number;
};

function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

/** 解析 #EXT-X-KEY / #EXT-X-MAP / #EXT-X-STREAM-INF 的 属性列表。 */
function parseAttrs(line: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m = re.exec(line);
  while (m !== null) {
    const key = m[1];
    let value = m[2] ?? '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key) out.set(key.toUpperCase(), value.trim());
    m = re.exec(line);
  }
  return out;
}

async function fetchText(url: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctl.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
  }
}

/** master playlist 里选码率最高的 variant；没有 STREAM-INF 就说明它本身就是 media playlist。 */
function pickVariant(master: string, base: string): string | null {
  let best: { url: string; bandwidth: number } | null = null;
  const lines = master.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bandwidth = Number(parseAttrs(line).get('BANDWIDTH') ?? 0) || 0;

    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next || next.startsWith('#')) continue;
      const url = resolveUrl(base, next.trim());
      if (!best || bandwidth > best.bandwidth) best = { url, bandwidth };
      break;
    }
  }

  return best?.url ?? null;
}

function parseMediaPlaylist(text: string, base: string): MediaPlaylist {
  const out: MediaPlaylist = { segments: [], keyUris: new Set(), byterange: false, sequence: 0 };
  let pendingKey: KeyInfo | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      out.sequence = Number(line.split(':')[1] ?? 0) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttrs(line);
      const method = (attrs.get('METHOD') ?? 'NONE').toUpperCase();
      if (method === 'NONE') {
        pendingKey = undefined;
      } else {
        const uri = attrs.get('URI');
        const ivHex = attrs.get('IV');
        pendingKey = {
          method,
          uri: uri ? resolveUrl(base, uri) : '',
          ...(ivHex ? { iv: hexToBytes(ivHex) } : {}),
        };
        out.keyUris.add(pendingKey.uri);
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const uri = parseAttrs(line).get('URI');
      if (uri) out.init = resolveUrl(base, uri);
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      out.byterange = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    out.segments.push(resolveUrl(base, line));
    if (pendingKey) out.key = pendingKey;
  }

  return out;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/^0[xX]/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

/** 没有显式 IV 时，用分片序号当 128 位大端整数。 */
function ivFromSequence(seq: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(seq));
  return iv;
}

function guessExt(playlist: MediaPlaylist): 'mp4' | 'ts' {
  const probe = playlist.init ?? playlist.segments[0] ?? '';
  const path = probe.split('?')[0] ?? '';
  return /\.ts$/i.test(path) ? 'ts' : 'mp4';
}

/**
 * 把 HLS 拉成单个文件写进 dir。文件名按 X 的规则用序号 + 扩展名，由 nameFor 决定。
 */
export async function downloadHls(
  masterUrl: string,
  dir: FileSystemDirectoryHandle,
  nameFor: (ext: string) => string = (ext) => `1.${ext}`,
): Promise<HlsOutcome> {
  let text: string;
  let mediaUrl = masterUrl;

  try {
    const res = await fetchText(masterUrl);
    if (!res.ok) return { ok: false, reason: 'fetch', detail: `m3u8 HTTP ${res.status}` };
    text = await res.text();
  } catch (err) {
    return { ok: false, reason: 'fetch', detail: `拉取 m3u8 失败：${errorMessage(err)}` };
  }

  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = pickVariant(text, mediaUrl);
    if (!variant) return { ok: false, reason: 'parse', detail: 'master 里没有可用 variant' };
    mediaUrl = variant;
    try {
      const res = await fetchText(mediaUrl);
      if (!res.ok) return { ok: false, reason: 'fetch', detail: `variant HTTP ${res.status}` };
      text = await res.text();
    } catch (err) {
      return { ok: false, reason: 'fetch', detail: `拉取 variant 失败：${errorMessage(err)}` };
    }
  }

  const playlist = parseMediaPlaylist(text, mediaUrl);

  if (playlist.byterange) {
    return { ok: false, reason: 'parse', detail: '分片使用 BYTERANGE，未支持' };
  }
  if (playlist.segments.length === 0) {
    return { ok: false, reason: 'parse', detail: 'media playlist 里没有分片' };
  }
  if (playlist.key && playlist.key.method !== 'AES-128') {
    return { ok: false, reason: 'drm', detail: `不支持的加密方式 ${playlist.key.method}` };
  }
  if (playlist.key && !playlist.key.uri) {
    return { ok: false, reason: 'drm', detail: '#EXT-X-KEY 缺少 URI' };
  }
  if (playlist.keyUris.size > 1) {
    return { ok: false, reason: 'drm', detail: '密钥中途轮换，未支持' };
  }

  let cryptoKey: CryptoKey | null = null;
  if (playlist.key) {
    try {
      const res = await fetchText(playlist.key.uri);
      if (!res.ok) return { ok: false, reason: 'drm', detail: `取密钥 HTTP ${res.status}` };
      const raw = await res.arrayBuffer();
      cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, [
        'decrypt',
      ]);
    } catch (err) {
      return { ok: false, reason: 'drm', detail: `导入密钥失败：${errorMessage(err)}` };
    }
  }

  const ext = guessExt(playlist);
  const file = nameFor(ext);

  let writable: FileSystemWritableFileStream;
  try {
    writable = await openWritable(dir, file);
  } catch (err) {
    return { ok: false, reason: 'write', detail: errorMessage(err) };
  }

  let bytes = 0;
  let consecutiveFailures = 0;
  let written = 0;

  const writeChunk = async (chunk: Uint8Array<ArrayBuffer>): Promise<void> => {
    bytes += chunk.byteLength;
    await writable.write(chunk);
  };

  try {
    const parts: Array<string | undefined> = [playlist.init, ...playlist.segments];

    for (let i = 0; i < parts.length; i++) {
      const partUrl = parts[i];
      if (!partUrl) continue;

      const isInit = i === 0 && Boolean(playlist.init);
      const seq = playlist.sequence + i - (playlist.init ? 1 : 0);

      let buf: Uint8Array<ArrayBuffer> | null = null;
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
            reason: 'fetch',
            detail: `连续 ${consecutiveFailures} 个分片失败：${errorMessage(err)}`,
          };
        }
        await sleep(1500);
        continue;
      }

      if (cryptoKey && !isInit && playlist.key) {
        const iv = playlist.key.iv ?? ivFromSequence(Math.max(0, seq));
        try {
          const plain = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv },
            cryptoKey,
            buf,
          );
          buf = new Uint8Array(plain);
        } catch (err) {
          await abortQuietly(writable);
          return { ok: false, reason: 'drm', detail: `解密失败：${errorMessage(err)}` };
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
    return { ok: false, reason: 'write', detail: errorMessage(err) };
  }

  return { ok: true, file, bytes, ext, segments: written };
}

async function abortQuietly(writable: FileSystemWritableFileStream): Promise<void> {
  try {
    await writable.abort();
  } catch {
    /* ignore */
  }
}