# ncmdump-web

基于 Vue 3 + Vite 的纯浏览器端 `.ncm` 解密 Demo，移植自仓库根目录的 TypeScript 实现。

所有解密与标签写入都在浏览器本地完成，文件不会上传到服务器。

## 使用

```bash
npm install
npm run dev        # 开发模式，浏览器打开 http://localhost:5173
npm run build      # 类型检查 + 打包为单个 dist/index.html
npm run preview    # 预览构建产物
```

构建产物为**单个 `dist/index.html`**（`vite-plugin-singlefile` 内联全部 JS/CSS），
可直接双击在浏览器中离线使用。已针对 `file://` 协议做了专门适配，详见下文。

## 后台 Worker

解密与标签写入在 Web Worker 中执行，主线程只负责文件头解析（即时展示歌名 / 封面）与结果展示：

- 文件缓冲区通过 Transferable 零拷贝转移给 Worker，避免大文件结构化克隆的内存开销
- 固定大小 Worker 池并行处理多文件，并发数默认 `min(4, hardwareConcurrency)`
- 解密进度由 Worker 实时回传，超大文件也不会阻塞界面
- Worker 通过 `?worker&inline` 内联为**经典 Blob Worker**：Chromium 在 `file://` 下会拦截
  外部脚本 Worker 与 module Worker，但允许经典 Blob Worker，因此双击 HTML 仍能获得后台并行解密
- 若浏览器限制 Worker 创建（极少数环境），会自动降级为主线程解密，功能不受影响

Worker 相关代码位于 `src/worker/`（`ncm.worker.ts` 为解密线程，`messages.ts` 为消息协议）。

## 与 Node 版的对应关系

| Node 版（仓库根目录） | 浏览器版（本目录） |
| --- | --- |
| `src/ncmcrypt.ts`（Node crypto / fs） | `src/lib/ncm.ts`（crypto-js + Uint8Array） |
| `src/metadata.ts`（node-id3 / fs） | `src/lib/metadata.ts`（browser-id3-writer + 手写 FLAC 块） |

## 验证

`npm run verify` 会把仓库根目录的 `test/test.ncm` 用移植版逻辑处理一遍，与原版 CLI 的输出逐字节对比。
