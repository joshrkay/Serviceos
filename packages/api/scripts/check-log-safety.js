#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js']);

const banned = [
  /logger\.(debug|info|warn|error)\([^\n]*req\.body/g,
  /logger\.(debug|info|warn|error)\([^\n]*req\.headers\.(authorization|cookie)/g,
  /logger\.(debug|info|warn|error)\([^\n]*['"](authorization|cookie|token)['"]\s*:/g,
];

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(fullPath));
      continue;
    }
    if (entry.isFile() && FILE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(fullPath);
    }
  }
  return out;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

const offenders = [];
for (const filePath of listFiles(SRC_DIR)) {
  const source = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(path.resolve(__dirname, '..'), filePath).replace(/\\/g, '/');

  for (const pattern of banned) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const line = lineNumberAt(source, match.index);
      const snippet = source.split('\n')[line - 1]?.trim() ?? '';
      offenders.push({ pattern: String(pattern), rel, line, snippet });
    }
  }
}

if (offenders.length > 0) {
  console.error('[log-safety] Banned logging patterns found:\n');
  for (const item of offenders) {
    console.error(`- ${item.rel}:${item.line}`);
    console.error(`  pattern: ${item.pattern}`);
    console.error(`  code: ${item.snippet}`);
  }
  process.exit(1);
}

console.log('[log-safety] OK');
