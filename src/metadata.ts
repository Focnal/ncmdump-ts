import * as fs from 'fs';
import NodeID3 from 'node-id3';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf: Buffer): boolean {
  return buf.subarray(0, 8).equals(PNG_SIG);
}

// ── MP3 via node-id3 ────────────────────────────────────────────────
function writeMP3(
  filepath: string,
  tags: { title?: string; artist?: string; album?: string },
  imageData?: Buffer,
): void {
  const id3Tags: NodeID3.Tags = {};
  if (tags.title) id3Tags.title = tags.title;
  if (tags.artist) id3Tags.artist = tags.artist;
  if (tags.album) id3Tags.album = tags.album;

  if (imageData) {
    id3Tags.image = {
      mime: isPng(imageData) ? 'image/png' : 'image/jpeg',
      type: { id: 3, name: 'front cover' },
      description: '',
      imageBuffer: imageData,
    };
  }

  NodeID3.write(id3Tags, filepath);
}

// ── FLAC manual block writer ───────────────────────────────────────
function writeFLAC(
  filepath: string,
  tags: { title?: string; artist?: string; album?: string },
  imageData?: Buffer,
): void {
  const data = fs.readFileSync(filepath);
  if (data.subarray(0, 4).toString('ascii') !== 'fLaC') {
    throw new Error('Not a valid FLAC file');
  }

  // parse metadata blocks
  interface Block {
    type: number;
    data: Buffer;
  }
  const blocks: Block[] = [];
  let off = 4;
  for (;;) {
    const header = data.readUInt32BE(off);
    const isLast = (header >>> 31) & 1;
    const blockType = (header >>> 24) & 0x7f;
    const blockLen = header & 0x00ffffff;
    off += 4;
    blocks.push({ type: blockType, data: data.subarray(off, off + blockLen) });
    off += blockLen;
    if (isLast) break;
  }
  const audioData = data.subarray(off);

  // remove old VORBIS_COMMENT (4) and PICTURE (6)
  const filtered = blocks.filter((b) => b.type !== 4 && b.type !== 6);

  // build new VORBIS_COMMENT
  const vendor = 'reference libFLAC 1.3.4 20220220';
  const vendorBuf = Buffer.from(vendor, 'utf-8');
  const comments: string[] = [];
  if (tags.title) comments.push(`TITLE=${tags.title}`);
  if (tags.artist) comments.push(`ARTIST=${tags.artist}`);
  if (tags.album) comments.push(`ALBUM=${tags.album}`);

  const vcParts: Buffer[] = [];
  // vendor
  {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(vendorBuf.length, 0);
    vcParts.push(len, vendorBuf);
  }
  // comment count
  {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(comments.length, 0);
    vcParts.push(len);
  }
  // each comment
  for (const c of comments) {
    const cb = Buffer.from(c, 'utf-8');
    const l = Buffer.alloc(4);
    l.writeUInt32LE(cb.length, 0);
    vcParts.push(l, cb);
  }

  const vcBlock: Block = { type: 4, data: Buffer.concat(vcParts) };

  // build PICTURE if we have image
  let picBlock: Block | null = null;
  if (imageData) {
    const mime = isPng(imageData) ? 'image/png' : 'image/jpeg';
    const mimeBuf = Buffer.from(mime, 'ascii');
    const pp: Buffer[] = [];

    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(3, 0);
      pp.push(b);
    } // type: front cover
    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(mimeBuf.length, 0);
      pp.push(b, mimeBuf);
    }
    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(0, 0);
      pp.push(b);
    } // desc empty
    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(0, 0);
      pp.push(b);
    } // width
    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(0, 0);
      pp.push(b);
    } // height
    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(0, 0);
      pp.push(b);
    } // depth
    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(0, 0);
      pp.push(b);
    } // num colors
    {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(imageData.length, 0);
      pp.push(b, imageData);
    }

    picBlock = { type: 6, data: Buffer.concat(pp) };
  }

  // insert after STREAMINFO (type 0); if no STREAMINFO, prepend
  const insIdx = filtered.findIndex((b) => b.type === 0);
  const insertAt = insIdx >= 0 ? insIdx + 1 : 0;
  filtered.splice(insertAt, 0, vcBlock);
  if (picBlock) filtered.splice(insertAt + 1, 0, picBlock);

  // reassemble
  const out: Buffer[] = [Buffer.from('fLaC')];
  for (let i = 0; i < filtered.length; i++) {
    const block = filtered[i];
    const isLast = i === filtered.length - 1;
    const type = block.type | (isLast ? 0x80 : 0);
    const len = block.data.length;
    const hdr = Buffer.alloc(4);
    hdr[0] = type;
    hdr.writeUIntBE(len, 1, 3);
    out.push(hdr, block.data);
  }
  out.push(audioData);

  fs.writeFileSync(filepath, Buffer.concat(out));
}

// ── Public entry ───────────────────────────────────────────────────
export function writeMetadata(
  filepath: string,
  format: 'mp3' | 'flac',
  tags: { title?: string; artist?: string; album?: string },
  imageData?: Buffer,
): void {
  if (format === 'mp3') {
    writeMP3(filepath, tags, imageData);
  } else {
    writeFLAC(filepath, tags, imageData);
  }
}
