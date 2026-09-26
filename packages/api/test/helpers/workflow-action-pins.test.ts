import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * #749 — every third-party action runs at an immutable commit. A tag
 * (`@v5`, even `@v1.27.1`) can be repointed after review; a 40-hex SHA
 * cannot. Local actions (`./…`) and docker images are out of scope.
 */
const GITHUB_DIR = resolve(__dirname, '../../../../.github');

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

describe('workflow action pins (#749)', () => {
  it('pins every remote `uses:` to a full commit SHA', () => {
    const unpinned: string[] = [];
    for (const file of yamlFiles(GITHUB_DIR)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = line.match(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)/);
          if (!m || m[1].startsWith('./') || m[1].startsWith('docker://')) return;
          if (!/@[0-9a-f]{40}$/.test(m[1])) unpinned.push(`${file.split('.github/')[1]}:${i + 1} ${m[1]}`);
        });
    }
    expect(unpinned).toEqual([]);
  });
});
