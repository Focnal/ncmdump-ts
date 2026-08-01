<script setup lang="ts">
import { onUnmounted, ref } from 'vue';

import { decryptAudio, parseNcm, type MusicMetadata, type ParsedNcm } from './lib/ncm';
import { writeMetadataBytes } from './lib/metadata';
import NcmWorker from './worker/ncm.worker.ts?worker&inline';
import type { NcmWorkerResponse } from './worker/messages';

interface NcmItem {
  id: number;
  fileName: string;
  fileSize: number;
  metadata: MusicMetadata | null;
  imageData: Uint8Array | null;
  coverUrl: string | null;
  format: 'mp3' | 'flac' | null;
  status: 'parsing' | 'queued' | 'decrypting' | 'done' | 'error';
  error: string;
  progress: number;
  blobUrl: string | null;
  outName: string;
}

interface QueuedTask {
  item: NcmItem;
  buffer: ArrayBuffer;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  item: NcmItem | null;
}

// 并发度：最多 4 个 Worker，避免同时驻留过多大文件占满内存
const MAX_WORKERS = Math.min(4, Math.max(1, navigator.hardwareConcurrency || 4));

const items = ref<NcmItem[]>([]);
const dragging = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
const queueCount = ref(0);
const decryptingCount = ref(0);
const workerMode = ref<'worker' | 'main'>('worker');

const taskQueue: QueuedTask[] = [];
const slots: WorkerSlot[] = [];
let nextId = 1;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(ms: number): string {
  if (!ms) return '未知';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Worker 池 ────────────────────────────────────────────────────────
function createPool(): boolean {
  try {
    for (let i = 0; i < MAX_WORKERS; i++) {
      const worker = new NcmWorker();
      slots.push({ worker, busy: false, item: null });
    }
    return true;
  } catch {
    return false;
  }
}

function destroyPool(): void {
  for (const slot of slots) slot.worker.terminate();
  slots.length = 0;
}

function schedule(): void {
  for (const slot of slots) {
    if (slot.busy) continue;
    const task = taskQueue.shift();
    if (!task) break;
    queueCount.value = taskQueue.length;
    dispatch(slot, task);
  }
}

function dispatch(slot: WorkerSlot, task: QueuedTask): void {
  const item = task.item;
  slot.busy = true;
  slot.item = item;
  item.status = 'decrypting';
  item.progress = 0;
  decryptingCount.value++;

  const finish = (): void => {
    slot.busy = false;
    slot.item = null;
    decryptingCount.value--;
    schedule();
  };

  slot.worker.onmessage = (event: MessageEvent<NcmWorkerResponse>) => {
    const msg = event.data;
    if (slot.item?.id !== msg.taskId) return; // 丢弃过期消息
    const current = slot.item;

    switch (msg.type) {
      case 'progress':
        current.progress = msg.percent;
        break;
      case 'done': {
        finalizeItem(current, msg.format, msg.audio);
        finish();
        break;
      }
      case 'error': {
        current.status = 'error';
        current.error = msg.message;
        finish();
        break;
      }
    }
  };

  slot.worker.onerror = (event) => {
    const current = slot.item;
    if (current) {
      current.status = 'error';
      current.error = `后台任务异常：${event.message || '未知错误'}`;
    }
    finish();
  };

  // 文件缓冲区通过 transfer list 转移给 Worker，零拷贝
  slot.worker.postMessage({ type: 'process', taskId: item.id, file: task.buffer }, [task.buffer]);
}

function finalizeItem(
  item: NcmItem,
  format: 'mp3' | 'flac',
  audio: Uint8Array | ArrayBuffer,
): void {
  item.status = 'done';
  item.progress = 100;
  item.format = format;
  item.outName = item.fileName.replace(/\.ncm$/i, '') + '.' + format;
  const blob = new Blob([audio], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/flac' });
  item.blobUrl = URL.createObjectURL(blob);
}

// 兜底：浏览器禁止 Worker（如 file:// 下的特殊限制）时在主线程直接处理
async function processOnMainThread(
  item: NcmItem,
  bytes: Uint8Array,
  parsed: ParsedNcm,
): Promise<void> {
  item.status = 'decrypting';
  item.progress = 0;
  decryptingCount.value++;
  try {
    const { audio, format } = await decryptAudio(bytes, parsed, (p) => (item.progress = p));
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
    finalizeItem(item, format, tagged);
  } catch (err) {
    item.status = 'error';
    item.error = err instanceof Error ? err.message : String(err);
  } finally {
    decryptingCount.value--;
  }
}

// ── 文件接入 ──────────────────────────────────────────────────────────
function addFiles(files: FileList | File[]): void {
  for (const file of Array.from(files)) {
    if (!file.name.toLowerCase().endsWith('.ncm')) continue;
    void processFile(file);
  }
}

async function processFile(file: File): Promise<void> {
  const item: NcmItem = {
    id: nextId++,
    fileName: file.name,
    fileSize: file.size,
    metadata: null,
    imageData: null,
    coverUrl: null,
    format: null,
    status: 'parsing',
    error: '',
    progress: 0,
    blobUrl: null,
    outName: file.name.replace(/\.ncm$/i, ''),
  };
  items.value.push(item);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!items.value.includes(item)) return; // 等待读取期间已被移除

    // 主线程快速解析文件头，立即展示元数据与封面
    const parsed = parseNcm(bytes);
    if (!items.value.includes(item)) {
      releaseItem(item);
      return;
    }
    item.metadata = parsed.metadata;
    item.imageData = parsed.imageData;
    if (parsed.imageData) {
      item.coverUrl = URL.createObjectURL(new Blob([parsed.imageData]));
    }

    // Worker 可用：进入队列，缓冲区零拷贝转移给 Worker
    if (!useWorker) {
      void processOnMainThread(item, bytes, parsed);
      return;
    }
    item.status = 'queued';
    taskQueue.push({ item, buffer: bytes.buffer as ArrayBuffer });
    queueCount.value = taskQueue.length;
    schedule();
  } catch (err) {
    item.status = 'error';
    item.error = err instanceof Error ? err.message : String(err);
  }
}

function onInputChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files) addFiles(input.files);
  input.value = '';
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  if (event.dataTransfer?.files) addFiles(event.dataTransfer.files);
}

function releaseItem(item: NcmItem): void {
  if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
  if (item.coverUrl) URL.revokeObjectURL(item.coverUrl);
}

function removeItem(item: NcmItem): void {
  if (item.status === 'decrypting') return; // 解密中的任务不可移除
  const qIdx = taskQueue.findIndex((t) => t.item.id === item.id);
  if (qIdx >= 0) {
    taskQueue.splice(qIdx, 1);
    queueCount.value = taskQueue.length;
  }
  const idx = items.value.indexOf(item);
  if (idx >= 0) items.value.splice(idx, 1);
  releaseItem(item);
}

function clearAll(): void {
  if (decryptingCount.value > 0) return; // 等所有解密结束后再清空
  for (const item of items.value) releaseItem(item);
  items.value = [];
  taskQueue.length = 0;
  queueCount.value = 0;
}

const useWorker = createPool();
if (!useWorker) workerMode.value = 'main';
onUnmounted(() => {
  destroyPool();
  for (const item of items.value) releaseItem(item);
});
</script>

<template>
  <main class="app">
    <header class="header">
      <h1>NCM 解密工具</h1>
      <p>
        纯本地解密网易云音乐 <code>.ncm</code> 文件，文件不会上传到任何服务器。
      </p>
      <p v-if="workerMode === 'main'" class="warn">
        当前浏览器限制 Web Worker，已切换到主线程解密，超大文件可能会卡顿。
      </p>
    </header>

    <div
      class="drop-zone"
      :class="{ dragging }"
      role="button"
      tabindex="0"
      @click="inputRef?.click()"
      @keydown.enter="inputRef?.click()"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input
        ref="inputRef"
        type="file"
        accept=".ncm"
        multiple
        hidden
        @change="onInputChange"
      />
      <div class="drop-icon">⬇</div>
      <p class="drop-title">点击选择或拖拽 .ncm 文件到此处</p>
      <p class="drop-hint">
        支持多文件 ·
        <template v-if="workerMode === 'worker'">最多 {{ MAX_WORKERS }} 个 Worker 并行解密</template>
        <template v-else>主线程解密模式</template>
        · 自动补写歌名 / 歌手 / 专辑 / 封面标签
      </p>
    </div>

    <section v-if="items.length" class="list">
      <div class="list-head">
        <span>{{ items.length }} 个文件</span>
        <span v-if="decryptingCount || queueCount" class="queue-info">
          解密中 {{ decryptingCount }} · 排队 {{ queueCount }}
        </span>
        <button
          class="link"
          type="button"
          :disabled="decryptingCount > 0"
          :title="decryptingCount > 0 ? '解密结束后才能清空' : ''"
          @click="clearAll"
        >
          清空列表
        </button>
      </div>

      <article v-for="item in items" :key="item.id" class="card" :class="item.status">
        <div class="cover">
          <img v-if="item.coverUrl" :src="item.coverUrl" alt="专辑封面" />
          <div v-else class="cover-placeholder">♪</div>
        </div>

        <div class="info">
          <div class="row title-row">
            <span class="name">{{ item.metadata?.name || item.fileName }}</span>
            <span v-if="item.format" class="badge">{{ item.format.toUpperCase() }}</span>
          </div>

          <div v-if="item.metadata" class="row sub">
            {{ [item.metadata.artist, item.metadata.album].filter(Boolean).join(' — ') || '未知专辑' }}
          </div>

          <div class="row sub">
            {{ formatSize(item.fileSize) }}
            <template v-if="item.metadata?.bitrate"> · {{ (item.metadata.bitrate / 1000).toFixed(0) }} kbps</template>
            <template v-if="item.metadata?.duration"> · {{ formatDuration(item.metadata.duration) }}</template>
          </div>

          <div
            v-if="['parsing', 'queued', 'decrypting'].includes(item.status)"
            class="progress"
          >
            <div class="bar" :style="{ width: item.progress + '%' }"></div>
          </div>

          <p v-if="item.status === 'error'" class="err">{{ item.error }}</p>

          <div class="actions">
            <span v-if="item.status === 'parsing'" class="status-text">解析中…</span>
            <span v-else-if="item.status === 'queued'" class="status-text">排队中…</span>
            <span v-else-if="item.status === 'decrypting'" class="status-text">
              解密中 {{ item.progress }}%
            </span>
            <span v-else-if="item.status === 'error'" class="status-text err">解密失败</span>
            <span v-else-if="item.status === 'done'" class="status-text ok">解密完成</span>

            <a
              v-if="item.status === 'done' && item.blobUrl"
              class="btn"
              :href="item.blobUrl"
              :download="item.outName"
            >
              下载 {{ item.outName }}
            </a>
            <button
              v-if="item.status !== 'decrypting'"
              class="link"
              type="button"
              @click="removeItem(item)"
            >
              移除
            </button>
          </div>
        </div>
      </article>
    </section>
  </main>
</template>

<style scoped>
.app {
  max-width: 720px;
  margin: 0 auto;
  padding: 40px 20px 64px;
}

.header h1 {
  margin: 0 0 8px;
  font-size: 26px;
}

.header p {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.6;
}

.header p.warn {
  margin-top: 8px;
  color: var(--err);
}

.header code {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}

.drop-zone {
  margin-top: 28px;
  padding: 48px 24px;
  border: 2px dashed var(--border);
  border-radius: 12px;
  background: var(--panel);
  text-align: center;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.drop-zone:hover,
.drop-zone.dragging {
  border-color: var(--accent);
  background: var(--panel-2);
}

.drop-icon {
  font-size: 34px;
  line-height: 1;
}

.drop-title {
  margin: 14px 0 6px;
  font-size: 16px;
}

.drop-hint {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.list {
  margin-top: 32px;
}

.list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  color: var(--muted);
  font-size: 14px;
}

.queue-info {
  margin-right: auto;
}

.card {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
}

.card.error {
  border-color: var(--err);
}

.card.decrypting {
  border-color: var(--accent);
}

.cover {
  flex: 0 0 auto;
  width: 88px;
  height: 88px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel-2);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  color: var(--muted);
}

.info {
  flex: 1;
  min-width: 0;
}

.row {
  margin-bottom: 4px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.name {
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.sub {
  color: var(--muted);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress {
  margin: 10px 0 2px;
  height: 6px;
  border-radius: 999px;
  background: var(--panel-2);
  overflow: hidden;
}

.bar {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.1s linear;
}

.err {
  margin: 8px 0 0;
  color: var(--err);
  font-size: 13px;
  word-break: break-all;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}

.status-text {
  color: var(--muted);
  font-size: 13px;
}

.status-text.ok {
  color: var(--ok);
}

.status-text.err {
  color: var(--err);
}

.btn {
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: filter 0.15s ease;
}

.btn:hover {
  filter: brightness(1.1);
}

.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}

.link:hover:not(:disabled) {
  color: var(--text);
  text-decoration: underline;
}

.link:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
