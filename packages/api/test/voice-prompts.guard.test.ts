import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const ALLOWED_FILE = path.resolve(repoRoot, 'packages/shared/src/voice-prompts.ts');
const SCAN_DIRS = [
  path.resolve(repoRoot, 'packages/api/src/routes'),
  path.resolve(repoRoot, 'packages/api/src/telephony'),
  path.resolve(repoRoot, 'packages/api/src/ai/tts'),
];

const FORBIDDEN = [
  "We're experiencing technical difficulties. Please try again later.",
  "I'm sorry, no one is available right now.",
  'will call you back as soon as possible.',
  'Tap to confirm on screen.',
];

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
}

describe('voice prompt guard', () => {
  it('blocks hardcoded GTM voice phrases outside shared prompt module', () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) walk(dir, files);

    const offenders: Array<{ file: string; phrase: string }> = [];
    for (const file of files) {
      if (path.resolve(file) === ALLOWED_FILE) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const phrase of FORBIDDEN) {
        if (text.includes(phrase)) offenders.push({ file: path.relative(repoRoot, file), phrase });
      }
    }

    expect(offenders).toEqual([]);
  });
});
