// ─────────────────────────────────────────────────────────────────────
// 浏览器移植版：对应原项目 src/ncmcrypt.ts
// 改动点：
//  - Node crypto AES-ECB → crypto-js（Web Crypto 不支持 ECB 模式）
//  - Node Buffer/fs/path → Uint8Array / 纯内存处理
//  - 解密后的音频直接返回字节，由上层负责保存
// ─────────────────────────────────────────────────────────────────────

import CryptoJS from 'crypto-js';

import { base64ToBytes, bytesToAscii, bytesToUtf8, readU32LE } from './bytes';

export interface MusicMetadata {
  name: string;
  album: string;
  artist: string;
  format: string;
  bitrate: number;
  duration: number; // 毫秒
}

// ── 与原项目一致的常量 ──────────────────────────────────────────────
const CORE_KEY = Uint8Array.from([
  0x68, 0x7a, 0x48, 0x52, 0x41, 0x6d, 0x73, 0x6f, 0x35, 0x6b, 0x49, 0x6e, 0x62, 0x61, 0x78, 0x57,
]);
const MODIFY_KEY = Uint8Array.from([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21, 0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28,
]);
const NCM_MAGIC = 'CTENFDAM';

// ── Uint8Array <-> crypto-js WordArray ──────────────────────────────
function bytesToWordArray(bytes: Uint8Array): CryptoJS.lib.WordArray {
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    words.push(
      ((bytes[i] << 24) |
        ((bytes[i + 1] ?? 0) << 16) |
        ((bytes[i + 2] ?? 0) << 8) |
        (bytes[i + 3] ?? 0)) >>>
        0,
    );
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length);
}

function wordArrayToBytes(wordArray: CryptoJS.lib.WordArray): Uint8Array {
  const out = new Uint8Array(wordArray.sigBytes);
  for (let i = 0; i < wordArray.sigBytes; i++) {
    out[i] = (wordArray.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return out;
}

// ── AES-128-ECB，与 C++ 相同的 PKCS7 处理 ───────────────────────────
function aesEcbDecrypt(key: Uint8Array, src: Uint8Array): Uint8Array {
  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: bytesToWordArray(src) } as CryptoJS.lib.CipherParams,
    bytesToWordArray(key),
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.NoPadding },
  );
  const out = wordArrayToBytes(decrypted);

  // C++: 最后一个字节是 PKCS7 填充长度
  const pad = out[out.length - 1];
  return pad <= 16 ? out.subarray(0, out.length - pad) : out;
}

// ── RC4 风格 KeyBox（与 C++ 相同的非标准 KSA）────────────────────────
function buildKeyBox(key: Uint8Array): Uint8Array {
  const kb = new Uint8Array(256);
  for (let i = 0; i < 256; i++) kb[i] = i;

  let lastByte = 0;
  let keyOff = 0;
  for (let i = 0; i < 256; i++) {
    const swap = kb[i];
    const c = (swap + lastByte + key[keyOff++]) & 0xff;
    if (keyOff >= key.length) keyOff = 0;
    kb[i] = kb[c];
    kb[c] = swap;
    lastByte = c;
  }
  return kb;
}

// ── 解析结果 ────────────────────────────────────────────────────────
export interface ParsedNcm {
  metadata: MusicMetadata | null;
  imageData: Uint8Array | null;
  keyBox: Uint8Array;
  audioStart: number;
}

// ── 解析 NCM 文件头（同步、快，不涉及大文件音频流）───────────────────
export function parseNcm(bytes: Uint8Array): ParsedNcm {
  if (bytes.length < 10 || bytesToAscii(bytes.subarray(0, 8)) !== NCM_MAGIC) {
    throw new Error('不是有效的 NCM 文件（magic 校验失败）');
  }
  let off = 10; // 8 字节 magic + 2 字节保留位

  // ── RC4 密钥 ──
  const keyLen = readU32LE(bytes, off);
  off += 4;
  if (keyLen <= 0) throw new Error('NCM 文件损坏：缺少密钥数据');

  const keyData = new Uint8Array(keyLen);
  for (let i = 0; i < keyLen; i++) keyData[i] = bytes[off + i] ^ 0x64;
  off += keyLen;

  const decKey = aesEcbDecrypt(CORE_KEY, keyData);
  // C++ 从解密密钥的第 17 字节起构建 KeyBox
  const keyBox = buildKeyBox(decKey.subarray(17));

  // ── 元数据 JSON ──
  const metaLen = readU32LE(bytes, off);
  off += 4;
  let metadata: MusicMetadata | null = null;
  if (metaLen > 0) {
    const metaEnc = new Uint8Array(metaLen);
    for (let i = 0; i < metaLen; i++) metaEnc[i] = bytes[off + i] ^ 0x63;
    off += metaLen;

    // 去掉 "163 key(Don't modify):"（22 字符）前缀后按 Base64 解码
    const b64 = bytesToAscii(metaEnc.subarray(22));
    const decoded = base64ToBytes(b64);
    const decrypted = aesEcbDecrypt(MODIFY_KEY, decoded);
    // 去掉 "music:"（6 字符）前缀得到 JSON
    const jsonStr = bytesToUtf8(decrypted.subarray(6));
    const raw: Record<string, unknown> = JSON.parse(jsonStr);

    // 网易云 artist 是数组（可能嵌套）
    let artist = '';
    const arr = raw.artist;
    if (Array.isArray(arr)) {
      artist = arr
        .map((a) => {
          const name = Array.isArray(a) ? a[0] : a;
          return typeof name === 'string' ? name : '';
        })
        .filter(Boolean)
        .join('/');
    }

    metadata = {
      name: typeof raw.musicName === 'string' ? raw.musicName : '',
      album: typeof raw.album === 'string' ? raw.album : '',
      artist,
      format: typeof raw.format === 'string' ? raw.format : '',
      bitrate: typeof raw.bitrate === 'number' ? raw.bitrate : 0,
      duration: typeof raw.duration === 'number' ? raw.duration : 0,
    };
  }

  // ── 跳过 CRC32 + 版本号（5 字节）──
  off += 5;

  // ── 封面图 ──
  const coverFrameLen = readU32LE(bytes, off);
  off += 4;
  const imgLen = readU32LE(bytes, off);
  off += 4;

  let imageData: Uint8Array | null = null;
  if (imgLen > 0) {
    imageData = bytes.slice(off, off + imgLen);
    off += imgLen;
  }
  off += coverFrameLen - imgLen;

  return { metadata, imageData, keyBox, audioStart: off };
}

export interface DecryptedAudio {
  audio: Uint8Array;
  format: 'mp3' | 'flac';
}

// ── 解密音频流（分块异或，异步 + 进度回调保持 UI 响应）─────────────────
export async function decryptAudio(
  bytes: Uint8Array,
  parsed: ParsedNcm,
  onProgress?: (percent: number) => void,
): Promise<DecryptedAudio> {
  const { keyBox, audioStart } = parsed;
  const total = bytes.length - audioStart;
  const out = new Uint8Array(total);

  // 与原项目保持一致的分块大小；每块的异或偏移从 0 重新计算
  const CHUNK = 0x8000;
  let pos = audioStart;
  let outPos = 0;
  let chunkIndex = 0;

  while (pos < bytes.length) {
      console.log("处理中")
    const end = Math.min(pos + CHUNK, bytes.length);
    for (let i = 0; i < end - pos; i++) {
      const j = (i + 1) & 0xff;
      out[outPos + i] =
        bytes[pos + i] ^ keyBox[(keyBox[j] + keyBox[(keyBox[j] + j) & 0xff]) & 0xff];
    }
    const n = end - pos;
    outPos += n;
    pos = end;

    chunkIndex++;
    if (chunkIndex % 16 === 0) {
      onProgress?.(Math.min(99, Math.round((outPos / total) * 100)));
      // 让出主线程，避免长任务阻塞界面
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  console.log("处理完毕")
  onProgress?.(100);

  // 探测格式：ID3 头 → mp3；否则 flac
  const format: 'mp3' | 'flac' =
    out[0] === 0x49 && out[1] === 0x44 && out[2] === 0x33 ? 'mp3' : 'flac';
  return { audio: out, format };
}
