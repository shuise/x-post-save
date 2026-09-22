import { build } from 'esbuild';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'dist');

const TARGET = 'chrome116';

/**
 * content script 的 js 产物必须是经典脚本（IIFE），MV3 不支持在 content_scripts 里用 ESM。
 * 扩展页面则走 ESM，这样才能用 --splitting 共享 src/shared/*。
 */
const shared = {
  bundle: true,
  target: TARGET,
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
};

async function copyPublic() {
  await cp(path.join(ROOT, 'public'), OUT, { recursive: true });
}

async function copyLogo() {
  await cp(path.join(ROOT, 'logo.jpg'), path.join(OUT, 'logo.jpg'));
}

async function typecheck() {
  await run('npx', ['tsc', '--noEmit'], { cwd: ROOT });
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await Promise.all([
    build({
      ...shared,
      entryPoints: [path.join(ROOT, 'src/content/main-world.ts')],
      outfile: path.join(OUT, 'main-world.js'),
      format: 'iife',
    }),
    build({
      ...shared,
      entryPoints: [path.join(ROOT, 'src/content/isolated.ts')],
      outfile: path.join(OUT, 'isolated.js'),
      format: 'iife',
    }),
    build({
      ...shared,
      entryPoints: [path.join(ROOT, 'src/background/service-worker.ts')],
      outfile: path.join(OUT, 'background.js'),
      format: 'esm',
    }),
    build({
      ...shared,
      entryPoints: [
        path.join(ROOT, 'src/page/task.ts'),
        path.join(ROOT, 'src/popup/popup.ts'),
      ],
      outdir: OUT,
      format: 'esm',
      splitting: true,
      // 两个入口的 basename 唯一，拍平到 dist/ 根部，HTML 里的 src 才不用改
      entryNames: '[name]',
      chunkNames: 'chunks/[name]-[hash]',
    }),
  ]);

  await copyPublic();
  await copyLogo();
  await typecheck();

  const files = await readdir(OUT);
  console.log(`\n构建完成，dist/ 产物：\n  ${files.sort().join('\n  ')}`);
}

main().catch(async (err) => {
  if (err instanceof Error) {
    // tsc 的报错信息在 stdout 上，直接透传给用户
    const out = /** @type {any} */ (err).stdout;
    if (out) console.error(out);
    console.error(err.stderr || err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});