// 主线程 → Worker
export interface ProcessRequest {
  type: 'process';
  taskId: number;
  file: ArrayBuffer; // 通过 transfer list 转移，零拷贝
}

export type NcmWorkerRequest = ProcessRequest;

// Worker → 主线程
export type NcmWorkerResponse =
  | { type: 'progress'; taskId: number; percent: number }
  | { type: 'done'; taskId: number; format: 'mp3' | 'flac'; audio: ArrayBuffer }
  | { type: 'error'; taskId: number; message: string };
