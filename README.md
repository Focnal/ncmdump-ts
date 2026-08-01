# ncmdump

将网易云音乐缓存文件（`.ncm`）转换为 `mp3` 或 `flac` 格式。

> 本项目是 [taurusxin/ncmdump](https://github.com/taurusxin/ncmdump) 的 TypeScript 移植，提供完全一致的 CLI 接口以及ES Module调用支持。

## 快速开始

请确保你的 Node.js 版本 ≥ 18。

### 构建

```bash
npm install
npm run build
```

### 运行

```bash
# 直接用 tsx 运行（无需编译）
npm start './test/test.ncm'

# 或在构建后运行
node dist/cli.js './test/test.ncm'
```

## 命令行使用

参考 [taurusxin/ncmdump](https://github.com/taurusxin/ncmdump)

```
ncmdump [options] [files...]
```

| 参数                     | 说明                                     |
| ------------------------ | ---------------------------------------- |
| `[files...]`             | 一个或多个 `.ncm` 文件                   |
| `-d, --directory <path>` | 批量处理目录下所有 `.ncm` 文件           |
| `-r, --recursive`        | 配合 `-d` 递归子目录，保留目录结构       |
| `-o, --output <path>`    | 指定输出目录（默认输出到源文件所在目录） |
| `-m, --remove`           | 转换成功后删除源 `.ncm` 文件             |
| `-v, --version`          | 输出版本号                               |
| `-h, --help`             | 输出帮助信息                             |

### 示例

```bash
# 处理单个文件
ncmdump 1.ncm 2.ncm

# 处理目录（非递归）
ncmdump -d ./music

# 递归处理，保留子目录结构
ncmdump -d ./music -r

# 输出到指定目录
ncmdump 1.ncm -o ./output

# 递归处理并输出，保留目录结构
ncmdump -d ./music -r -o ./output

# 转换后删除源文件
ncmdump 1.ncm -m
```

### 全局安装

```bash
npm install -g .
ncmdump test.ncm
```

## 编程接口

```typescript
import { NeteaseCrypt, writeMetadata } from 'ncmdump';
// 或
const { NeteaseCrypt, writeMetadata } = require('ncmdump');
```

### 基本用法

```typescript
const crypt = new NeteaseCrypt('test.ncm');

// 查看元数据（无需 dump）
console.log(crypt.metadata);
// {
//   name: '贝贝',
//   album: '耳朵',
//   artist: '李荣浩',
//   format: 'flac',
//   bitrate: 311454,
//   duration: 4000
// }

console.log(crypt.imageData); // Buffer | null — 封面图片

// 解密音频流到文件
crypt.dump(); // 输出到源文件目录
crypt.dump('/output'); // 输出到指定目录

console.log(crypt.format); // 'mp3' | 'flac'
console.log(crypt.dumpFilepath); // 输出文件的绝对路径

// 写入元数据标签（歌名、歌手、专辑、封面）
crypt.fixMetadata(writeMetadata);
```

### 自定义元数据写入

```typescript
import { writeMetadata } from 'ncmdump';

// writeMetadata 接受四个参数：
writeMetadata(
  filepath, // string — 音频文件路径
  'mp3' | 'flac', // format — 音频格式
  { title, artist, album }, // tags
  imageBuffer, // Buffer | undefined — 封面图片
);

// 可以传入自定义实现：
crypt.fixMetadata(myCustomWriter);
```

### 仅提取元数据

```typescript
const crypt = new NeteaseCrypt('test.ncm');

// 不调用 dump()，也能读取元数据和封面：
const { name, artist, album, format, bitrate, duration } = crypt.metadata!;
fs.writeFileSync('cover.jpg', crypt.imageData!);
```

## 导出 API

```typescript
export class NeteaseCrypt {
  constructor(ncmPath: string); // 解析 NCM 文件头、密钥、元数据
  dump(outputDir?: string): void; // 解密音频流到文件
  fixMetadata(writer?: WriteMetadataFn): void; // 写入标签

  get filepath(): string; // 源文件路径
  get dumpFilepath(): string; // 输出文件路径（dump 后可用）
  get format(): 'mp3' | 'flac'; // 音频格式（dump 后可用）
  get metadata(): MusicMetadata | null;
  get imageData(): Buffer | null;
}

export interface MusicMetadata {
  name: string;
  album: string;
  artist: string;
  format: string;
  bitrate: number;
  duration: number; // 毫秒
}

export function writeMetadata(
  filepath: string,
  format: 'mp3' | 'flac',
  tags: { title?: string; artist?: string; album?: string },
  imageData?: Buffer,
): void;
```

## 技术原理

NCM 文件结构：

```
┌─────────────────────────────┐
│  Magic (8B)  "CTENFDAM"     │
│  Reserved (2B)              │
│  Key Length (4B LE)         │
│  Key Data (n × XOR 0x64)   │  ──→ AES-128-ECB(CoreKey) → RC4 KeyBox
│  Meta Length (4B LE)        │
│  Meta Data (n × XOR 0x63)  │  ──→ Base64 → AES-ECB → JSON
│  CRC32 + Version (5B)       │
│  Cover Frame (variable)     │
│  Encrypted Audio            │  ──→ KeyBox XOR → mp3/flac
└─────────────────────────────┘
```

1. 从文件头提取经过混淆的密钥数据，用内置 `CoreKey` 做 AES-128-ECB 解密得到 RC4 密钥
2. 构建 256 字节 KeyBox（非标准 RC4 KSA 变种），对流式音频数据做异或解密
3. 从文件内嵌的元数据块解密 JSON，提取歌名/歌手/专辑/封面图
4. 探测解密后音频的首字节（`ID3` → mp3，否则 → flac），写入对应扩展名
5. 用 TagLib 等价逻辑写入 ID3v2（MP3）或 Vorbis Comment + Picture（FLAC）标签

## 测试

```bash
npm test
```

运行 14 个测试用例，覆盖 API 和 CLI 的全部功能。测试位于 `test/test.ts`。

## Web 版 Demo

仓库的 [`web/`](web/) 目录是一个基于 Vue 3 + Vite 的纯浏览器端解密页面：解密逻辑已移植到浏览器，
无需启动任何服务即可使用。详见 [web/README.md](web/README.md)。
