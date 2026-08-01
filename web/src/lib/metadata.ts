// ─────────────────────────────────────────────────────────────────────
// 浏览器移植版：对应原项目 src/metadata.ts
// 改动点：
//  - MP3 标签：node-id3 → browser-id3-writer
//  - FLAC 标签：手写 Vorbis Comment + Picture（与原实现逐字节一致）
//  - 输入输出均为 Uint8Array，不再读写文件
// ─────────────────────────────────────────────────────────────────────

import { ID3Writer } from 'browser-id3-writer';

import { asciiBytes, concatBytes, readU32BE, u32BE, u32LE, utf8Bytes } from './bytes';

export interface MusicTags {
  title?: string;
  artist?: string;
  album?: string;
}

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIG.length) return false;
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bytes[i] !== PNG_SIG[i]) return false;
  }
  return true;
}

// 将字节复制为长度精确的 ArrayBuffer（browser-id3-writer 按 buffer 长度处理）
function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

// ── MP3：通过 browser-id3-writer 写入 ID3v2.3 标签 ──────────────────
async function writeMP3(
  audio: Uint8Array,
  tags: MusicTags,
  imageData?: Uint8Array,
): Promise<Uint8Array> {
  const writer = new ID3Writer(toExactArrayBuffer(audio));
  if (tags.title) writer.setFrame('TIT2', tags.title);
  if (tags.artist) writer.setFrame('TPE1', [tags.artist]);
  if (tags.album) writer.setFrame('TALB', tags.album);
  if (imageData) {
    writer.setFrame('APIC', {
      type: 3, // ImageType.CoverFront
      data: toExactArrayBuffer(imageData),
      description: '',
    });
  }
  const blob = await writer.getBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

// ── FLAC：手写 Vorbis Comment + Picture 块（逐字节对齐原实现）────────
function writeFLAC(
  audio: Uint8Array,
  tags: MusicTags,
  imageData?: Uint8Array,
): Uint8Array {
  const data = audio;
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'fLaC') {
    throw new Error('Not a valid FLAC file');
  }

  interface Block {
    type: number;
    data: Uint8Array;
  }

  // 解析现有元数据块
  const blocks: Block[] = [];
  let off = 4;
  for (;;) {
    const header = readU32BE(data, off);
    const isLast = (header >>> 31) & 1;
    const blockType = (header >>> 24) & 0x7f;
    const blockLen = header & 0x00ffffff;
    off += 4;
    blocks.push({ type: blockType, data: data.subarray(off, off + blockLen) });
    off += blockLen;
    if (isLast) break;
  }
  const audioData = data.subarray(off);

  // 移除旧的 VORBIS_COMMENT(4) 与 PICTURE(6) 块
  const filtered = blocks.filter((b) => b.type !== 4 && b.type !== 6);

  // 构造 VORBIS_COMMENT
  const vendor = 'reference libFLAC 1.3.4 20220220';
  const vendorBuf = utf8Bytes(vendor);
  const comments: string[] = [];
  if (tags.title) comments.push(`TITLE=${tags.title}`);
  if (tags.artist) comments.push(`ARTIST=${tags.artist}`);
  if (tags.album) comments.push(`ALBUM=${tags.album}`);

  const vcParts: Uint8Array[] = [u32LE(vendorBuf.length), vendorBuf, u32LE(comments.length)];
  for (const c of comments) {
    const cb = utf8Bytes(c);
    vcParts.push(u32LE(cb.length), cb);
  }
  const vcBlock: Block = { type: 4, data: concatBytes(vcParts) };

  // 构造 PICTURE（封面）
  let picBlock: Block | null = null;
  if (imageData) {
    const mime = isPng(imageData) ? 'image/png' : 'image/jpeg';
    const mimeBuf = asciiBytes(mime);
    picBlock = {
      type: 6,
      data: concatBytes([
        u32BE(3), // 类型：front cover
        u32BE(mimeBuf.length),
        mimeBuf,
        u32BE(0), // description 为空
        u32BE(0), // width
        u32BE(0), // height
        u32BE(0), // depth
        u32BE(0), // num colors
        u32BE(imageData.length),
        imageData,
      ]),
    };
  }

  // 插到 STREAMINFO(0) 之后；没有则放到最前
  const insIdx = filtered.findIndex((b) => b.type === 0);
  const insertAt = insIdx >= 0 ? insIdx + 1 : 0;
  filtered.splice(insertAt, 0, vcBlock);
  if (picBlock) filtered.splice(insertAt + 1, 0, picBlock);

  // 重组文件
  const out: Uint8Array[] = [asciiBytes('fLaC')];
  for (let i = 0; i < filtered.length; i++) {
    const block = filtered[i];
    const isLast = i === filtered.length - 1;
    const type = block.type | (isLast ? 0x80 : 0);
    const len = block.data.length;
    const hdr = new Uint8Array(4);
    hdr[0] = type;
    hdr[1] = (len >>> 16) & 0xff;
    hdr[2] = (len >>> 8) & 0xff;
    hdr[3] = len & 0xff;
    out.push(hdr, block.data);
  }
  out.push(audioData);
  return concatBytes(out);
}

// ── 统一入口 ────────────────────────────────────────────────────────
export async function writeMetadataBytes(
  audio: Uint8Array,
  format: 'mp3' | 'flac',
  tags: MusicTags,
  imageData?: Uint8Array,
): Promise<Uint8Array> {
  if (format === 'mp3') return writeMP3(audio, tags, imageData);
  return writeFLAC(audio, tags, imageData);
}
