import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { NeteaseCrypt } from '../src/ncmcrypt';
import { writeMetadata } from '../src/metadata';

const TEST_NCM  = path.join(__dirname, 'test.ncm');
const TMP_DIR   = path.join(__dirname, '..', '.test-tmp');
const CLI       = path.join(__dirname, '..', 'dist', 'cli.js');

let passed = 0;
let failed = 0;

function check(desc: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${desc}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function shell(cmd: string): string {
  return cp.execSync(cmd, { encoding: 'utf-8', cwd: TMP_DIR });
}

// ── setup ──────────────────────────────────────────────────────────
console.log('[setup]');
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.copyFileSync(TEST_NCM, path.join(TMP_DIR, 'test.ncm'));

// ── Library API ────────────────────────────────────────────────────
console.log('\n[Library API]');

check('NeteaseCrypt constructor opens valid NCM', () => {
  const c = new NeteaseCrypt(TEST_NCM);
  assert.ok(c.filepath);
});

check('NeteaseCrypt rejects non-NCM file', () => {
  fs.writeFileSync(path.join(TMP_DIR, 'fake.ncm'), Buffer.alloc(32));
  assert.throws(() => new NeteaseCrypt(path.join(TMP_DIR, 'fake.ncm')));
});

check('metadata parsed correctly', () => {
  const c = new NeteaseCrypt(TEST_NCM);
  const m = c.metadata;
  assert.ok(m, 'metadata should exist');
  assert.ok(m!.name.length > 0, 'name should not be empty');
  assert.ok(m!.artist.length > 0, 'artist should not be empty');
  assert.ok(m!.album.length > 0, 'album should not be empty');
  assert.ok(typeof m!.bitrate === 'number', 'bitrate should be number');
  assert.ok(typeof m!.duration === 'number', 'duration should be number');
});

check('imageData extracted', () => {
  const c = new NeteaseCrypt(TEST_NCM);
  assert.ok(c.imageData, 'imageData should exist');
  assert.ok(c.imageData!.length > 0, 'imageData should not be empty');
});

check('dump() writes output file', () => {
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'dump-api.ncm'));
  const c = new NeteaseCrypt(path.join(TMP_DIR, 'dump-api.ncm'));
  c.dump(TMP_DIR);
  assert.ok(fs.existsSync(c.dumpFilepath), 'output file must exist');
  assert.ok(fs.statSync(c.dumpFilepath).size > 0, 'output must not be empty');
});

check('dump() detects format', () => {
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'format.ncm'));
  const c = new NeteaseCrypt(path.join(TMP_DIR, 'format.ncm'));
  c.dump(TMP_DIR);
  assert.ok(c.format === 'mp3' || c.format === 'flac', 'format must be mp3 or flac');
  assert.ok(c.dumpFilepath.endsWith('.' + c.format), 'extension must match format');
});

check('fixMetadata() writes tags to output', () => {
  const c = new NeteaseCrypt(TEST_NCM);
  c.dump(TMP_DIR);
  c.fixMetadata(writeMetadata);

  const buf = fs.readFileSync(c.dumpFilepath);
  if (c.format === 'flac') {
    assert.equal(buf.subarray(0, 4).toString(), 'fLaC', 'must be valid FLAC');
    // find VORBIS_COMMENT block (type 4)
    let off = 4;
    while (off < buf.length - 4) {
      const hdr = buf.readUInt32BE(off);
      const type = (hdr >>> 24) & 0x7f;
      const len  = hdr & 0x00ffffff;
      if (type === 4) {
        const vc = buf.subarray(off + 4, off + 4 + len);
        const vendorLen = vc.readUInt32LE(0);
        const nComments = vc.readUInt32LE(4 + vendorLen);
        assert.ok(nComments >= 2, 'should have title and artist at minimum');
        break;
      }
      off += 4 + len;
      if ((hdr >>> 31) & 1) break;
    }
  } else {
    // MP3 should have ID3 header
    const hasId3 = buf.subarray(0, 3).toString() === 'ID3';
    assert.ok(hasId3, 'MP3 must have ID3 header');
  }
});

// ── CLI ────────────────────────────────────────────────────────────
console.log('\n[CLI]');

check('--version (-v)', () => {
  const out = cp.execSync(`node "${CLI}" -v`, { encoding: 'utf-8' }).trim();
  assert.match(out, /^\d+\.\d+\.\d+$/);
});

check('--help', () => {
  const out = cp.execSync(`node "${CLI}" -h`, { encoding: 'utf-8' });
  assert.ok(out.includes('ncmdump'));
  assert.ok(out.includes('--directory'));
});

check('basic conversion', () => {
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'cli-basic.ncm'));
  const out = shell(`node "${CLI}" cli-basic.ncm`);
  assert.ok(out.includes('[Done]'), 'should print [Done]');
  const dumpFile = path.join(TMP_DIR, 'cli-basic.flac');
  assert.ok(fs.existsSync(dumpFile) || fs.existsSync(path.join(TMP_DIR, 'cli-basic.mp3')));
});

check('-o output directory', () => {
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'cli-o.ncm'));
  const outdir = path.join(TMP_DIR, 'cli-out');
  shell(`node "${CLI}" cli-o.ncm -o "${outdir}"`);
  const files = fs.readdirSync(outdir);
  assert.ok(files.length >= 1, 'output dir should have files');
});

check('-m removes source', () => {
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'cli-m.ncm'));
  shell(`node "${CLI}" cli-m.ncm -m`);
  assert.ok(!fs.existsSync(path.join(TMP_DIR, 'cli-m.ncm')), 'source must be removed');
});

check('-d directory mode', () => {
  fs.rmSync(path.join(TMP_DIR, 'dir-flat'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP_DIR, 'dir-flat'), { recursive: true });
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'dir-flat', 'a.ncm'));
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'dir-flat', 'b.ncm'));
  const outdir = path.join(TMP_DIR, 'dir-flat-out');
  shell(`node "${CLI}" -d "${path.join(TMP_DIR, 'dir-flat')}" -o "${outdir}"`);
  const files = fs.readdirSync(outdir).filter(f => /\.(mp3|flac)$/.test(f));
  assert.equal(files.length, 2, 'should have 2 output files');
});

check('-d -r recursive mode', () => {
  fs.rmSync(path.join(TMP_DIR, 'dir-rec'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP_DIR, 'dir-rec', 'sub'), { recursive: true });
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'dir-rec', 'a.ncm'));
  fs.cpSync(TEST_NCM, path.join(TMP_DIR, 'dir-rec', 'sub', 'b.ncm'));
  const outdir = path.join(TMP_DIR, 'dir-rec-out');
  shell(`node "${CLI}" -d "${path.join(TMP_DIR, 'dir-rec')}" -r -o "${outdir}"`);
  assert.ok(fs.existsSync(path.join(outdir, 'a.flac')) || fs.existsSync(path.join(outdir, 'a.mp3')));
  assert.ok(fs.existsSync(path.join(outdir, 'sub', 'b.flac')) || fs.existsSync(path.join(outdir, 'sub', 'b.mp3')));
});

// ── teardown ───────────────────────────────────────────────────────
console.log('\n[teardown]');
fs.rmSync(TMP_DIR, { recursive: true, force: true });

// ── summary ────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(32)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(32)}`);
process.exit(failed > 0 ? 1 : 0);
