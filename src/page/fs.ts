import { kv } from '../shared/db';
import { CHECK_FILE } from '../shared/paths';
import { errorMessage } from '../shared/util';

/**
 * File System Access 封装。
 *
 * 硬约束：扩展读不到也探测不到任何绝对路径，所有操作只能从用户选中的句柄往下走。
 * 所以「目标目录存在且可写」只能靠写一个 .bee-check 探针再删掉来判定。
 *
 * 外置盘掉线、权限被收回、目录被删，抛出的 DOMException 名字各不相同且不可靠，
 * 这里统一转成 StorageUnavailableError，UI 上只给「重新授权 / 中止」两个选择。
 */

export const PICKER_ID = 'x-medias-root';
export const TARGET_DIR_NAME = 'x-medias';

const WRITE: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };

export class StorageUnavailableError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'StorageUnavailableError';
    this.detail = detail;
  }
}

export function wrapFsError(err: unknown, action: string): StorageUnavailableError {
  if (err instanceof StorageUnavailableError) return err;
  const detail = err instanceof DOMException ? `${err.name}: ${err.message}` : errorMessage(err);
  return new StorageUnavailableError(`${action}失败（${detail}）`, detail);
}

export type Binding = {
  /** 用户实际选中的句柄，存 IndexedDB 的就是它 */
  picked: FileSystemDirectoryHandle;
  /** 真正的输出根目录，名字一定是 x-medias */
  root: FileSystemDirectoryHandle;
};

let binding: Binding | null = null;

export function currentBinding(): Binding | null {
  return binding;
}

export function clearBinding(): void {
  binding = null;
}

/**
 * queryPermission 返回 'prompt' 时才 requestPermission，且必须由用户手势触发。
 * Chrome 122+ 的三态提示下用户选「每次访问都允许」后直接返回 'granted'，不会再弹。
 */
async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  request: boolean,
): Promise<void> {
  let state: PermissionState;
  try {
    state = await handle.queryPermission(WRITE);
  } catch (err) {
    throw wrapFsError(err, '查询目录权限');
  }
  if (state === 'granted') return;

  if (!request) {
    throw new StorageUnavailableError('目录权限已失效，需要重新授权', 'prompt');
  }

  try {
    state = await handle.requestPermission(WRITE);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'SecurityError') {
      throw new StorageUnavailableError('授权必须由你点击按钮触发，请再点一次「选择目录」', 'gesture');
    }
    throw wrapFsError(err, '申请目录权限');
  }
  if (state !== 'granted') {
    throw new StorageUnavailableError('你拒绝了目录授权', 'denied');
  }
}

/** 选中 x-medias 就直接用，否则在它下面创建 x-medias。 */
async function resolveRoot(
  picked: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  if (picked.name === TARGET_DIR_NAME) return picked;
  try {
    return await picked.getDirectoryHandle(TARGET_DIR_NAME, { create: true });
  } catch (err) {
    throw wrapFsError(err, `创建 ${TARGET_DIR_NAME} 目录`);
  }
}

/** 探针：写入后删除。这是唯一可行的「目录在且可写」判定方式。 */
export async function probe(root: FileSystemDirectoryHandle): Promise<void> {
  try {
    const fh = await root.getFileHandle(CHECK_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(`${new Date().toISOString()}\n`);
    await w.close();
  } catch (err) {
    throw wrapFsError(err, '写入探针文件');
  }
  try {
    await root.removeEntry(CHECK_FILE);
  } catch {
    // 探针没删掉不影响判定，下次会覆盖
  }
}

/**
 * 由用户手势触发。第一句就是 showDirectoryPicker，中间不能有 await，
 * 否则用户激活会被消耗掉导致 picker 打不开。
 */
export async function bindFromPicker(): Promise<Binding> {
  let picked: FileSystemDirectoryHandle;
  try {
    picked = await window.showDirectoryPicker({ id: PICKER_ID, mode: 'readwrite' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new StorageUnavailableError('已取消选择目录', 'abort');
    }
    if (err instanceof DOMException && err.name === 'SecurityError') {
      throw new StorageUnavailableError('打开目录选择器必须由你点击按钮触发', 'gesture');
    }
    // 选择器是全局单例：连点两次，或上一次的窗口还开着，Chrome 就抛这个。
    // 这不算失败，也不该报成「打开目录选择器失败」吓人一跳。
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new StorageUnavailableError(
        '目录选择器已经打开了，请先在弹出窗口里完成或取消这次选择',
        'picker-busy',
      );
    }
    throw wrapFsError(err, '打开目录选择器');
  }

  await ensurePermission(picked, true);
  const root = await resolveRoot(picked);
  await probe(root);

  binding = { picked, root };
  await kv.setRootHandle(picked);
  return binding;
}

/** 页面加载后恢复上次的句柄。request=false 时只查权限，绝不在无手势时弹窗。 */
export async function restoreBinding(request: boolean): Promise<Binding | null> {
  const picked = await kv.getRootHandle();
  if (!picked) return null;

  await ensurePermission(picked, request);
  const root = await resolveRoot(picked);
  binding = { picked, root };
  return binding;
}

/* ---------------- 目录与文件 ---------------- */

export async function ensureSubdir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  try {
    return await parent.getDirectoryHandle(name, { create: true });
  } catch (err) {
    throw wrapFsError(err, `创建目录 ${name}`);
  }
}

export async function openWritable(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemWritableFileStream> {
  try {
    const fh = await dir.getFileHandle(name, { create: true });
    return await fh.createWritable();
  } catch (err) {
    throw wrapFsError(err, `创建文件 ${name}`);
  }
}

export async function writeText(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string,
): Promise<number> {
  const data = new TextEncoder().encode(text);
  const w = await openWritable(dir, name);
  try {
    await w.write(data);
    await w.close();
  } catch (err) {
    try {
      await w.abort();
    } catch {
      /* ignore */
    }
    throw wrapFsError(err, `写入文件 ${name}`);
  }
  return data.byteLength;
}

/**
 * 流式写入 HTTP 响应。不把整个响应读成 Blob，长视频才不会爆内存。
 * 返回写入的字节数。
 */
export async function writeResponse(
  dir: FileSystemDirectoryHandle,
  name: string,
  res: Response,
  onBytes?: (written: number) => void,
): Promise<number> {
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        // TS 5.7 的 ReadableStream 给的是 Uint8Array<ArrayBufferLike>，
        // 而 FileSystemWriteChunkType 只接受 ArrayBufferView<ArrayBuffer>，这里断言收窄。
        await w.write(value as Uint8Array<ArrayBuffer>);
        if (onBytes) onBytes(bytes);
      }
    }
    await w.close();
  } catch (err) {
    try {
      await w.abort();
    } catch {
      /* ignore */
    }
    throw wrapFsError(err, `写入文件 ${name}`);
  }
  return bytes;
}

/** 判断 root/{fileName} 是否存在。用来发现被手工删掉的已完成 md。 */
export async function hasFile(
  root: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  try {
    await root.getFileHandle(fileName);
    return true;
  } catch {
    return false;
  }
}