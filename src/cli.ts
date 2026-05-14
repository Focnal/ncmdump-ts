#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { NeteaseCrypt } from './ncmcrypt';
import { writeMetadata } from './metadata';

const RED = '\x1b[31m';
const BOLDRED = '\x1b[1;31m';
const BOLDGREEN = '\x1b[1;32m';
const RESET = '\x1b[0m';

function processFile(filePath: string, outputDir: string, removeSource: boolean): void {
  if (!fs.existsSync(filePath)) {
    console.error(`${BOLDRED}[Error]${RESET} file '${filePath}' does not exist.`);
    return;
  }
  if (path.extname(filePath).toLowerCase() !== '.ncm') return;

  try {
    const crypt = new NeteaseCrypt(filePath);
    crypt.dump(outputDir);
    crypt.fixMetadata(writeMetadata);

    const msg = `${BOLDGREEN}[Done]${RESET} '${filePath}' -> '${crypt.dumpFilepath}'`;
    if (removeSource) {
      fs.unlinkSync(filePath);
      console.log(msg + ' with removed as required.');
    } else {
      console.log(msg);
    }
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      console.error(`${BOLDRED}[Exception]${RESET} ${RED}Can't open file${RESET} '${filePath}'`);
    } else {
      console.error(`${BOLDRED}[Exception]${RESET} ${RED}${e.message}${RESET} '${filePath}'`);
    }
  }
}

const PROGRAM = new Command();

PROGRAM.name('ncmdump')
  .description('Convert Netease Cloud Music .ncm files to mp3/flac')
  .version('2.0.0', '-v, --version')
  .option('-d, --directory <path>', 'Process all *.ncm files in a folder')
  .option('-r, --recursive', 'Process recursively (requires -d)')
  .option('-o, --output <path>', 'Output directory (default: same as source)')
  .option('-m, --remove', 'Remove original .ncm file on success')
  .argument('[files...]', 'Input .ncm files')
  .action((files: string[], opts: Record<string, any>) => {
    const hasFiles = files.length > 0;
    const hasDir = !!opts.directory;
    const output = (opts.output as string) || '';
    const remove = !!opts.remove;
    const recurse = !!opts.recursive;

    if (!hasFiles && !hasDir) {
      console.log(PROGRAM.helpInformation());
      return;
    }
    if (recurse && !hasDir) {
      console.error(`${BOLDRED}[Error]${RESET} -r requires -d`);
      process.exit(1);
    }

    if (output) {
      if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) {
        console.error(`${BOLDRED}[Error]${RESET} '${output}' is not a directory.`);
        process.exit(1);
      }
      fs.mkdirSync(output, { recursive: true });
    }

    // ── directory mode ──────────────────────────────────────────
    if (hasDir) {
      const srcDir = opts.directory as string;
      if (!fs.statSync(srcDir).isDirectory()) {
        console.error(`${BOLDRED}[Error]${RESET} '${srcDir}' is not a directory.`);
        process.exit(1);
      }

      if (recurse) {
        const relPaths = fs.readdirSync(srcDir, { recursive: true }) as string[];
        for (const rel of relPaths) {
          const fullPath = path.join(srcDir, rel);
          if (!fs.statSync(fullPath).isFile()) continue;

          const effectiveOut = output || srcDir;
          const destDir = path.join(effectiveOut, path.dirname(rel));
          processFile(fullPath, destDir, remove);
        }
      } else {
        for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
          if (!ent.isFile()) continue;
          processFile(path.join(srcDir, ent.name), output, remove);
        }
      }
      return;
    }

    // ── single-file mode ────────────────────────────────────────
    for (const fp of files) {
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        console.error(`${BOLDRED}[Error]${RESET} '${fp}' is not a valid file.`);
        continue;
      }
      processFile(fp, output, remove);
    }
  });

PROGRAM.parse();
