#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import clipboardy from 'clipboardy';
import ignore from 'ignore';

// Get command-line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: ts-node script.ts <directory> <ext1> [ext2] ...');
  process.exit(1);
}

const workingDir = process.cwd();
const baseDir = path.resolve(args[0]);
const extensions = args.slice(1);

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
} else {
  console.warn(`Warning: No .gitignore file found in '${baseDir}'.`);
}
// Add the base directory to the ignore list

// Helper to recursively find files respecting .gitignore
function collectFiles(dir: string, relativeToBase = ''): string[] {
  let result: string[] = [];

  for (const entry of fs.readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    const relPath = path.join(relativeToBase, entry);

    // Skip ignored files
    if (ig.ignores(relPath)) continue;

    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // File was removed or is a broken symlink — skip it
        continue;
      } else {
        throw err;
      }
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
