/**
 * Assert that a workflow runs on Node 20, whichever way it declares the pin.
 *
 * Two forms are legal and both are checked for the *effective* version rather
 * than a literal string:
 *
 *   node-version: '20.20.2'          — inline literal
 *   node-version-file: '.nvmrc'      — resolved from the repo's single pin
 *
 * The repo standardised on the second form so a Node bump is a one-line edit to
 * `.nvmrc` instead of an edit at every workflow site. The original assertions
 * matched `/node-version:\s*['"]?20/` against the file text, so that migration
 * failed them (VQ-024, VQ2-016) even though every workflow still ran Node 20 —
 * the tests were pinning the *spelling* of the pin, not the pin.
 *
 * Reading `.nvmrc` here keeps the real guarantee: a workflow that defers to
 * `.nvmrc` still fails this check if `.nvmrc` itself ever leaves the 20 line.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The major version pinned in `.nvmrc`, or null if it is missing/unreadable. */
export function nvmrcMajor(root: string = REPO_ROOT): number | null {
  const file = path.join(root, '.nvmrc');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8').trim().replace(/^v/, '');
  const major = Number.parseInt(raw.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? null : major;
}

/**
 * Fails unless `src` pins Node 20 — either inline, or by deferring to a
 * `.nvmrc` that is itself on 20. `label` names the file in the failure message.
 */
export function expectEffectiveNode20(src: string, label: string): void {
  const inline = src.match(/node-version:\s*['"]?(\d+)/);
  if (inline) {
    expect(
      Number(inline[1]),
      `${label} pins Node ${inline[1]} inline; expected major 20`,
    ).toBe(20);
    return;
  }

  const viaFile = src.match(/node-version-file:\s*['"]([^'"]+)['"]/);
  expect(
    viaFile,
    `${label} declares neither node-version nor node-version-file`,
  ).not.toBeNull();

  // Only `.nvmrc` is expected today; a different file would need its own
  // resolution and should fail loudly rather than silently pass.
  expect(viaFile?.[1], `${label} defers to an unexpected version file`).toBe(
    '.nvmrc',
  );

  expect(
    nvmrcMajor(),
    `${label} defers to .nvmrc, which is not on the Node 20 line`,
  ).toBe(20);
}
