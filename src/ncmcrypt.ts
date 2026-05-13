import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants from C++ ──────────────────────────────────────────────
const CORE_KEY   = Buffer.from([0x68, 0x7A, 0x48, 0x52, 0x41, 0x6D, 0x73, 0x6F,
                                0x35, 0x6B, 0x49, 0x6E, 0x62, 0x61, 0x78, 0x57]);
const MODIFY_KEY = Buffer.from([0x23, 0x31, 0x34, 0x6C, 0x6A, 0x6B, 0x5F, 0x21,
                                0x5C, 0x5D, 0x26, 0x30, 0x55, 0x3C, 0x27, 0x28]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const NCM_MAGIC  = 'CTENFDAM';

// ── Metadata interface ──────────────────────────────────────────────
export interface MusicMetadata {
  name: string;
  album: string;
  artist: string;
  format: string;
  bitrate: number;
  duration: number;
}

// ── Pure AES-128-ECB, PKCS7-padding handled identically to C++ ─────
function aesEcbDecrypt(key: Buffer, src: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, Buffer.alloc(0));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(src), decipher.final()]);

  // C++: last block's last byte is the PKCS7 pad
  const pad = decrypted[decrypted.length - 1];
  return pad <= 16
    ? decrypted.subarray(0, decrypted.length - pad)
    : decrypted;
}

// ── RC4-style KeyBox (same non-standard KSA as C++) ────────────────
function buildKeyBox(key: Buffer): Uint8Array {
  const kb = new Uint8Array(256);
  for (let i = 0; i < 256; i++) kb[i] = i;

  let lastByte = 0;
  let keyOff   = 0;
  for (let i = 0; i < 256; i++) {
    const swap = kb[i];
    const c    = (swap + lastByte + key[keyOff++]) & 0xff;
    if (keyOff >= key.length) keyOff = 0;
    kb[i]      = kb[c];
    kb[c]      = swap;
    lastByte   = c;
  }
  return kb;
}

// ── MIME type detection (PNG vs JPEG) ──────────────────────────────
function detectMime(data: Buffer): string {
  return data.subarray(0, 8).equals(PNG_HEADER) ? 'image/png' : 'image/jpeg';
}

// ── Main class ─────────────────────────────────────────────────────
export class NeteaseCrypt {
  // ---- state -------------------------------------------------------
  private _filepath   = '';
  private _dumpPath   = '';
  private _format     : 'mp3' | 'flac' = 'mp3';
  private _imageData  : Buffer | null = null;
  private _metadata   : MusicMetadata | null = null;
  private _keyBox     : Uint8Array = new Uint8Array(256);
  private _audioStart = 0;   // byte-offset in the buffer where audio begins
  private _fileBuf!   : Buffer;  // entire NCM contents (fits easily in memory)

  // ---- public accessors --------------------------------------------
  get filepath(): string     { return this._filepath; }
  get dumpFilepath(): string { return this._dumpPath; }
  get format(): string       { return this._format; }
  get metadata(): MusicMetadata | null { return this._metadata; }
  get imageData(): Buffer | null       { return this._imageData; }

  // ---- constructor (reads header, extracts keys + meta + cover) ----
  constructor(ncmPath: string) {
    this._filepath = fs.realpathSync(ncmPath);

    const buf = fs.readFileSync(ncmPath);
    this._fileBuf = buf;

    // --- magic ---
    if (buf.subarray(0, 8).toString('ascii') !== NCM_MAGIC) {
      throw new Error('Not a valid NCM file (bad magic)');
    }
    let off = 10;       // skip 8-byte magic + 2 reserved bytes

    // --- RC4 key ---
    const keyLen = buf.readUInt32LE(off);  off += 4;
    if (keyLen <= 0) throw new Error('Broken NCM file: no key data');

    const keyData = Buffer.alloc(keyLen);
    for (let i = 0; i < keyLen; i++) keyData[i] = buf[off + i] ^ 0x64;
    off += keyLen;

    const decKey = aesEcbDecrypt(CORE_KEY, keyData);
    // C++ builds KeyBox from key+17; key length is decKey.length - 17
    this._keyBox = buildKeyBox(decKey.subarray(17));

    // --- metadata JSON ---
    const metaLen = buf.readUInt32LE(off);  off += 4;
    if (metaLen <= 0) {
      this._metadata = null;
    } else {
      const metaEnc = Buffer.alloc(metaLen);
      for (let i = 0; i < metaLen; i++) metaEnc[i] = buf[off + i] ^ 0x63;
      off += metaLen;

      // strip `163 key(Don't modify):` (22 chars)
      const b64 = metaEnc.subarray(22).toString('ascii');
      const decoded = Buffer.from(b64, 'base64');
      const decrypted = aesEcbDecrypt(MODIFY_KEY, decoded);
      // strip `music:` (6 chars)
      const jsonStr = decrypted.subarray(6).toString('utf-8');
      const raw = JSON.parse(jsonStr);

      // parse artist-array (NetEase format)
      let artist = '';
      const arr = raw.artist;
      if (Array.isArray(arr)) {
        artist = arr
          .map((a: string | string[]) => {
            const name = Array.isArray(a) ? a[0] : a;
            return typeof name === 'string' ? name : '';
          })
          .filter(Boolean)
          .join('/');
      }

      this._metadata = {
        name:     raw.musicName  || '',
        album:    raw.album      || '',
        artist,
        format:   raw.format     || '',
        bitrate:  raw.bitrate    ?? 0,
        duration: raw.duration   ?? 0,
      };
    }

    // --- skip crc32 + image version (5 bytes) ---
    off += 5;

    // --- cover image ---
    const coverFrameLen = buf.readUInt32LE(off);  off += 4;
    const imgLen        = buf.readUInt32LE(off);  off += 4;

    if (imgLen > 0) {
      this._imageData = buf.subarray(off, off + imgLen);
      off += imgLen;
    }
    // skip remaining cover-frame padding
    off += coverFrameLen - imgLen;

    // --- encrypted audio starts here ---
    this._audioStart = off;
  }

  // ---- dump: decrypt audio stream to output file -------------------
  dump(outputDir = ''): void {
    // determine output path
    const srcPath = path.parse(this._filepath);
    const outDir  = outputDir || srcPath.dir;

    if (outputDir) fs.mkdirSync(outDir, { recursive: true });

    this._dumpPath = path.join(outDir, srcPath.base);

    // decrypt first chunk so we can sniff format
    const kb            = this._keyBox;
    const CHUNK         = 0x8000;
    let   audioPos      = this._audioStart;
    const firstChunkEnd = Math.min(audioPos + CHUNK, this._fileBuf.length);
    const firstChunk    = Buffer.from(this._fileBuf.subarray(audioPos, firstChunkEnd));

    for (let i = 0; i < firstChunk.length; i++) {
      const j = (i + 1) & 0xff;
      firstChunk[i] ^= kb[(kb[j] + kb[(kb[j] + j) & 0xff]) & 0xff];
    }

    // detect format: ID3 header → mp3 ; otherwise flac
    if (firstChunk[0] === 0x49 && firstChunk[1] === 0x44 && firstChunk[2] === 0x33) {
      this._format   = 'mp3';
      this._dumpPath = this._dumpPath.replace(/\.\w+$/, '') + '.mp3';
    } else {
      this._format   = 'flac';
      this._dumpPath = this._dumpPath.replace(/\.\w+$/, '') + '.flac';
    }

    const fd = fs.openSync(this._dumpPath, 'w');
    fs.writeSync(fd, firstChunk);
    audioPos = firstChunkEnd;

    // remaining chunks
    while (audioPos < this._fileBuf.length) {
      const end = Math.min(audioPos + CHUNK, this._fileBuf.length);
      const chunk = Buffer.from(this._fileBuf.subarray(audioPos, end));
      for (let i = 0; i < chunk.length; i++) {
        const j = (i + 1) & 0xff;
        chunk[i] ^= kb[(kb[j] + kb[(kb[j] + j) & 0xff]) & 0xff];
      }
      fs.writeSync(fd, chunk);
      audioPos = end;
    }
    fs.closeSync(fd);
  }

  // ---- fixMetadata: delegate to platform writer --------------------
  fixMetadata(writeMetadataFn?: WriteMetadataFn): void {
    if (!this._metadata && !this._imageData) return;

    const fn = writeMetadataFn ?? require('./metadata').writeMetadata;
    fn(
      this._dumpPath,
      this._format,
      {
        title:  this._metadata?.name   || undefined,
        artist: this._metadata?.artist || undefined,
        album:  this._metadata?.album  || undefined,
      },
      this._imageData ?? undefined,
    );
  }
}

// ---- type for pluggable metadata writer ----------------------------
export type WriteMetadataFn = (
  filepath: string,
  format: 'mp3' | 'flac',
  tags: { title?: string; artist?: string; album?: string },
  imageData?: Buffer,
) => void;
