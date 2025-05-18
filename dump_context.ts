#!/usr/bin/env ts-node

import clipboardy from 'clipboardy';
import * as fs from 'fs';
import ignore from 'ignore';
import * as path from 'path';

// Get command-line arguments
const rawArgs = process.argv.slice(2);
const excludeArgs: string[] = [];
const positionalArgs: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--exclude') {
    excludeArgs.push(rawArgs[i + 1]);
    i++; // skip next arg
  } else {
    positionalArgs.push(rawArgs[i]);
  }
}

if (positionalArgs.length < 2) {
  console.error('Usage: ts-node script.ts <directory> <ext1> [ext2] ... [--exclude keyword]');
  process.exit(1);
}

const workingDir = process.cwd();
const baseDir = path.resolve(positionalArgs[0]);
const extensions = positionalArgs.slice(1);

// Validate base directory
if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
  console.error(`Error: Directory '${baseDir}' not found or not a directory.`);
  process.exit(1);
}

// Validate extensions
for (const ext of extensions) {
  if (ext.includes('.') || ext.includes('/')) {
    console.error(
      `Error: Invalid extension format '${ext}'. Provide extensions without dots or slashes.`,
    );
    process.exit(1);
  }
}

// Load and parse .gitignore
const ig = ignore();
const gitignorePath = path.join(workingDir, '.gitignore');
if (fs.existsSync(gitignorePath)) {
  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  ig.add(gitignoreContent);
}

// Helper to recursively find files respecting .gitignore
function collectFiles(dir: string, relativeToBase = ''): string[] {
  let result: string[] = [];

  for (const entry of fs.readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    const relPath = path.join(relativeToBase, entry);

    // Skip ignored files and excluded patterns
    if (ig.ignores(relPath)) continue;
    if (excludeArgs.some(keyword => relPath.includes(keyword))) continue;

    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      console.warn(`Warning: Unable to access '${absPath}'. Skipping.`);
      continue;
    }

    if (stat.isDirectory()) {
      result = result.concat(collectFiles(absPath, relPath));
    } else if (stat.isFile()) {
      const ext = path.extname(entry).slice(1); // drop the dot
      if (extensions.includes(ext)) {
        result.push(absPath);
      }
    }
  }

  return result;
}

// Find and process files
const files = collectFiles(baseDir);
let output = '';

files.forEach((file) => {
  const content = fs.readFileSync(file, 'utf-8');
  output += `${file}\n---\n${content}\n\n`;
});

// Output
console.log(output);
clipboardy.writeSync(output);
