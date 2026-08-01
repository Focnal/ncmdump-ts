// 真实文件验证：将浏览器移植版的处理结果与原版 CLI 输出逐字节对比
// 运行：npm run verify（需先在仓库根目录执行 npm run build 生成 dist/）

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decryptAudio, parseNcm } from '../src/lib/ncm';
import { writeMetadataBytes } from '../src/lib/metadata';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

async function main(): Promise<void> {
  const cli = path.join(root, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.error('未找到 dist/cli.js，请先在仓库根目录运行 `npm run build`。');
    process.exit(1);
  }

  const ncmPath = path.join(root, 'test', 'test.ncm');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmweb-'));

  try {
    // 基线：原版 CLI 输出
    const cliOut = path.join(tmp, 'cli');
    fs.mkdirSync(cliOut, { recursive: true });
    execFileSync(process.execPath, [cli, ncmPath, '-o', cliOut], { cwd: root });

    // 浏览器移植版：解析 → 解密 → 写标签
    const ncmBytes = new Uint8Array(fs.readFileSync(ncmPath));
    const parsed = parseNcm(ncmBytes);
    const { audio, format } = await decryptAudio(ncmBytes, parsed);
    const tagged = await writeMetadataBytes(
      audio,
      format,
      {
        title: parsed.metadata?.name || undefined,
        artist: parsed.metadata?.artist || undefined,
        album: parsed.metadata?.album || undefined,
      },
      parsed.imageData ?? undefined,
    );

    const cliFile = fs.readdirSync(cliOut).find((f) => f.toLowerCase().endsWith(`.${format}`));
    if (!cliFile) throw new Error('CLI 未产生输出文件');

    const expected = fs.readFileSync(path.join(cliOut, cliFile));
    const actual = Buffer.from(tagged);
    const same = expected.length === actual.length && expected.equals(actual);

    console.log('fixture: ', ncmPath);
    console.log('format:  ', format);
    console.log('metadata:', parsed.metadata);
    console.log('CLI 输出:', `${expected.length} bytes`);
    console.log('Web 输出:', `${actual.length} bytes`);
    console.log(same ? '\nPASS —— 输出与原版 CLI 逐字节一致' : '\nFAIL —— 输出不一致');
    process.exitCode = same ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void main();
