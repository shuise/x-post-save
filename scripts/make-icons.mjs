import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SRC = path.join(ROOT, 'logo.jpg');
const OUT = path.join(ROOT, 'public/icons');
const SIZES = [16, 32, 48, 128];

await mkdir(OUT, { recursive: true });

for (const size of SIZES) {
  const dest = path.join(OUT, `${size}.png`);
  await run('sips', ['-s', 'format', 'png', '-z', String(size), String(size), SRC, '--out', dest]);
  console.log(`生成 ${path.relative(ROOT, dest)}`);
}