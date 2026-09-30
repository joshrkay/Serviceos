import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * expo-router's file-system route table, read the way the router reads it:
 * group segments like `(tabs)` are not part of the URL and `index` is the
 * directory's own path.
 *
 * Maestro run 36770097508 (2026-09-30): tapping "Skip for now" left the owner
 * on the onboarding screen. `app/(onboarding)/index.tsx` and
 * `app/(tabs)/index.tsx` BOTH resolve to "/", so the skip's
 * `router.replace('/')` could land on onboarding again, while AuthGate's
 * `router.replace('/onboarding')` named a URL no file served.
 */
const APP = path.resolve(__dirname, '../../app');

function routeFiles(dir = APP): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name.endsWith('.tsx') ? [path.relative(APP, full)] : [];
  });
}

function urlOf(file: string): string | null {
  const parts = file.replace(/\.tsx$/, '').split(path.sep);
  const last = parts[parts.length - 1];
  if (last === '_layout' || last.startsWith('+')) return null;
  const segs = parts.filter((p) => !/^\(.*\)$/.test(p) && p !== 'index');
  return `/${segs.join('/')}`;
}

function routeTable(): Map<string, string[]> {
  const table = new Map<string, string[]>();
  for (const f of routeFiles()) {
    const url = urlOf(f);
    if (url === null) continue;
    table.set(url, [...(table.get(url) ?? []), f]);
  }
  return table;
}

describe('mobile route table (expo-router file routes)', () => {
  it('serves every URL from exactly one screen file', () => {
    const dupes = [...routeTable()].filter(([, files]) => files.length > 1);
    expect(dupes).toEqual([]);
  });

  it('"/" is the Home tab, and the setup gate\'s "/onboarding" is the onboarding screen', () => {
    const table = routeTable();
    expect(table.get('/')).toEqual([path.join('(tabs)', 'index.tsx')]);
    expect(table.get('/onboarding')?.[0]).toMatch(/^\(onboarding\)/);
  });
});
