#!/usr/bin/env bun
/* bun run d.ts <path> -- <ext1> <ext2> ... -- <include1> <include2> ... -- <exclude1> <exclude2> ... */

import * as fs from 'fs';
import ignore from 'ignore';
import * as path from 'path';
import { encoding_for_model } from 'tiktoken'; // bun add @dqbd/tiktoken

type Segments = {
  baseDir: string;
  exts: string[];
  includes: string[];
  excludes: string[];
};

/* ────────────────── CLI 解析 ────────────────── */
function parseArgs(raw: string[]): Segments {
  if (!raw.length) usageAndExit();

  // `--` ごとに分割
  const groups: string[][] = [];
  let current: string[] = [];
  for (const arg of raw) {
    if (arg === '--') {
      groups.push(current);
      current = [];
    } else {
      current.push(arg);
    }
  }
  groups.push(current);

  if (groups.length < 2) usageAndExit('パスと拡張子セクションは必須です。');

  const [pathSeg, extsSeg, includesSeg = [], excludesSeg = []] = groups;

  if (pathSeg.length !== 1) usageAndExit('パスは 1 個だけ指定してください。');

  if (extsSeg.length === 0)
    usageAndExit('少なくとも 1 つ拡張子を指定してください。');

  for (const ext of extsSeg) {
    if (ext.includes('.') || ext.includes('/'))
      usageAndExit(
        `拡張子 '${ext}' はドットやスラッシュ無しで書いてください。`,
      );
  }

  return {
    baseDir: path.resolve(pathSeg[0]),
    exts: extsSeg,
    includes: includesSeg,
    excludes: excludesSeg,
  };
}

function usageAndExit(msg?: string): never {
  if (msg) console.error('Error:', msg);
  console.error(`
Usage:
  bun run d.ts <directory> -- <ext1> <ext2> ... [-- <includeKw> ... [-- <excludeKw> ...]]

例:
  bun run d.ts src -- ts tsx -- utils api -- test gen
         │        │           │             └ exclude
         │        │           └ include
         │        └ 拡張子
         └ 走査開始ディレクトリ
`);
  process.exit(1);
}

/* ────────────────── ファイル収集 ────────────────── */
function collectFiles(
  dir: string,
  ig: ignore.Ignore,
  opts: { exts: string[]; includes: string[]; excludes: string[] },
  rel = '',
): string[] {
  let results: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const relPath = path.join(rel, entry);

    if (ig.ignores(relPath)) continue;
    if (opts.excludes.some((k) => relPath.includes(k))) continue;
    if (opts.includes.length && !opts.includes.some((k) => relPath.includes(k)))
      continue;

    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      results = results.concat(collectFiles(abs, ig, opts, relPath));
    } else if (stat.isFile()) {
      const ext = path.extname(entry).slice(1);
      if (opts.exts.includes(ext)) results.push(abs);
    }
  }
  return results;
}

/* ────────────────── メイン処理 ────────────────── */
(async () => {
  const { baseDir, exts, includes, excludes } = parseArgs(
    process.argv.slice(2),
  );

  // ベースディレクトリ存在確認
  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory())
    usageAndExit(`'${baseDir}' は存在しないかディレクトリではありません。`);

  // .gitignore 読み込み
  const ig = ignore();
  const gitignore = path.join(process.cwd(), '.gitignore');
  if (fs.existsSync(gitignore)) ig.add(fs.readFileSync(gitignore, 'utf8'));

  const files = collectFiles(baseDir, ig, { exts, includes, excludes });

  if (!files.length) {
    console.warn('条件に合致するファイルが見つかりませんでした。');
    return;
  }

  let output = '';
  for (const file of files) {
    output += `${file}\n---\n${fs.readFileSync(file, 'utf8')}\n\n`;
  }

  console.log(output);

  // トークン数計算
  const enc = await encoding_for_model('gpt-4o-mini'); // CL100k 相当
  const tokenCount = enc.encode(output).length;
  enc.free();

  console.log(
    `\n✅ ${files.length} 個のファイルをまとめてクリップボードへコピーしました。`,
  );
  console.log(`📝 推定トークン数: ${tokenCount}`);
})();
