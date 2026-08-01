// ─────────────────────────────────────────────────────────────────────
// 解密后台 Worker：在独立线程中完成 解析 → 解密 → 写标签，
// 主线程只负责展示进度与结果，超大文件也不会阻塞界面。
// ─────────────────────────────────────────────────────────────────────

import { decryptAudio, parseNcm } from '../lib/ncm';
import { writeMetadataBytes } from '../lib/metadata';
import type { NcmWorkerRequest, NcmWorkerResponse, ProcessRequest } from './messages';

// 最小化的 Worker 全局声明，避免与 DOM lib 的 Window 类型冲突
declare const self: {
  postMessage(message: NcmWorkerResponse, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<NcmWorkerRequest>) => void) | null;
};

self.onmessage = (event: MessageEvent<NcmWorkerRequest>) => {
  if (event.data.type !== 'process') return;
  void processFile(event.data);
};

async function processFile(request: ProcessRequest): Promise<void> {
  const { taskId, file } = request;
  try {
    const bytes = new Uint8Array(file);

    // 1. 解析文件头
    const parsed = parseNcm(bytes);

    // 2. 分块解密，实时回传进度
    const { audio, format } = await decryptAudio(bytes, parsed, (percent) => {
      self.postMessage({ type: 'progress', taskId, percent }, []);
    });

    // 3. 写入元数据标签（歌名 / 歌手 / 专辑 / 封面）
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

    // 4. 结果通过 transfer 零拷贝送回主线程
    const audioBuffer = tagged.buffer as ArrayBuffer;
    self.postMessage(
      { type: 'done', taskId, format, audio: audioBuffer },
      [audioBuffer],
    );
  } catch (err) {
    self.postMessage(
      { type: 'error', taskId, message: err instanceof Error ? err.message : String(err) },
      [],
    );
  }
}
