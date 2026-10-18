/**
 * Service vocabulary, not software vocabulary (brief: "Vocabulary: software
 * words out, service words in"). Every file under v3/ that ships to the owner
 * is scanned for the words Rivet never says. The check is on whole words, so
 * identifiers like `proposalIds` or `proposal_count` are not flagged; prefer
 * renaming over exempting anything. The saved-and-pending state is called
 * "waiting for your OK".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = ['AI', 'agent', 'verify', 'provisioning', 'proposal', 'dashboard', 'Twilio', 'Stripe'];

const here = dirname(fileURLToPath(import.meta.url));

function shippedSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : shippedSources(path);
    const isSource = /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name);
    return isSource ? [path] : [];
  });
}

/** Import paths are code, not copy: `@ai-service-os/shared` is a package name. */
function withoutModulePaths(line: string): string {
  return line.replace(/(\bfrom\s*|\bimport\s*\(?\s*)'[^']*'/g, '$1\'\'');
}

describe('v3 vocabulary', () => {
  const files = shippedSources(here);

  it('scans the screens', () => {
    const names = files.map((f) => f.slice(here.length + 1));
    expect(names).toEqual(expect.arrayContaining(['ConversationShell.tsx', 'ReadyScreen.tsx', 'ReadbackCard.tsx', 'AnswerAsScreen.tsx']));
  });

  for (const word of FORBIDDEN) {
    it(`never says "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, 'i');
      const offenders = files.flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((text, i) => ({ file: file.slice(here.length + 1), line: i + 1, text: withoutModulePaths(text).trim() }))
          .filter((l) => pattern.test(l.text)),
      );
      expect(offenders).toEqual([]);
    });
  }
});
