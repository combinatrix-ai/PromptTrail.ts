#!/usr/bin/env bun

import clipboardy from 'clipboardy';
import * as fs from 'fs';
import ignore from 'ignore';
import * as path from 'path';

// -----------------------------------------------------------------------------
// Usage:  bun run collect_files.ts <directory> [keyword1] [keyword2] ...
// Example: bun run collect_files.ts ./src context messages
// -----------------------------------------------------------------------------
// The script walks the directory tree (respecting .gitignore), gathers every
// file whose *relative* path contains at least one of the provided keywords
// (case‑insensitive), prints their contents in a readable bundle, and copies
// the bundle into the clipboard.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 1. Read CLI arguments --------------------------------------------------------
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error(
    'Usage: bun run collect_files.ts <directory> [keyword1] [keyword2] ...',
  );
  process.exit(1);
}

const workingDir = process.cwd();
const baseDir = path.resolve(args[0]);
const patterns = args.slice(1).map((p) => p.toLowerCase()); // keywords

// -----------------------------------------------------------------------------
// 2. Validate directory --------------------------------------------------------
// -----------------------------------------------------------------------------
if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
  console.error(`Error: Directory "${baseDir}" not found or is not a directory.`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 3. Load .gitignore rules (from CWD) -----------------------------------------
// -----------------------------------------------------------------------------
const ig = ignore();
const gitignorePath = path.join(workingDir, '.gitignore');
if (fs.existsSync(gitignorePath)) {
  ig.add(fs.readFileSync(gitignorePath, 'utf8'));
}

// -----------------------------------------------------------------------------
// 4. Recursive walk respecting .gitignore -------------------------------------
// -----------------------------------------------------------------------------
function collectFiles(dir: string, relativeToBase = ''): string[] {
  let files: string[] = [];

  for (const entry of fs.readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    const relPath = path.join(relativeToBase, entry);

    // Skip ignored items
    if (ig.ignores(relPath)) continue;

    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      console.warn(`Warning: Unable to access "${absPath}". Skipping.`);
      continue;
    }

    if (stat.isDirectory()) {
      files = files.concat(collectFiles(absPath, relPath));
    } else if (stat.isFile()) {
      const relPathLower = relPath.toLowerCase();
      const matchesPattern =
        patterns.length === 0 ||
        patterns.some((p) => relPathLower.includes(p));
      if (matchesPattern) files.push(absPath);
    }
  }

  return files;
}

// -----------------------------------------------------------------------------
// 5. Gather matching files -----------------------------------------------------
// -----------------------------------------------------------------------------
const files = collectFiles(baseDir);
if (files.length === 0) {
  console.error(
    patterns.length
      ? `No files in "${baseDir}" match keywords: ${patterns.join(', ')}`
      : `No files found in "${baseDir}".`,
  );
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 6. Build output (filepath + delimiter + file content) ------------------------
// -----------------------------------------------------------------------------
let output = '';
for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  output += `${file}\n---\n${content}\n\n`;
}

// -----------------------------------------------------------------------------
// 7. Emit output to stdout & clipboard ----------------------------------------
// -----------------------------------------------------------------------------
console.log(output);
try {
  clipboardy.writeSync(output);
} catch {
  console.warn('Warning: Unable to write to clipboard (headless environment?).');
}
