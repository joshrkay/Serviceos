/**
 * Tests for the workflow Node-pin assertion helper.
 *
 * The helper exists because the original VQ-024 / VQ2-016 assertions pinned the
 * *spelling* of the Node version (`/node-version:\s*['"]?20/`) rather than the
 * version itself, so migrating the workflows to
 * `node-version-file: '.nvmrc'` failed them even though every workflow still
 * ran Node 20. These tests pin the behaviour that replaced it, including the
 * cases that must still fail.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectEffectiveNode20,
  nvmrcMajor,
} from './workflow-node-version';

const roots: string[] = [];

function rootWithNvmrc(contents: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nvmrc-test-'));
  roots.push(root);
  writeFileSync(path.join(root, '.nvmrc'), contents);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

describe('nvmrcMajor', () => {
  it('reads the major from an exact pin', () => {
    expect(nvmrcMajor(rootWithNvmrc('20.20.2\n'))).toBe(20);
  });

  it('tolerates a v prefix and whitespace', () => {
    expect(nvmrcMajor(rootWithNvmrc('  v20.20.2  \n'))).toBe(20);
  });

  it('reads a bare major', () => {
    expect(nvmrcMajor(rootWithNvmrc('22\n'))).toBe(22);
  });

  it('returns null when .nvmrc is absent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nvmrc-test-'));
    roots.push(root);
    expect(nvmrcMajor(root)).toBeNull();
  });

  it('returns null when .nvmrc is not a version', () => {
    expect(nvmrcMajor(rootWithNvmrc('lts/iron\n'))).toBeNull();
  });
});

describe('expectEffectiveNode20', () => {
  it('accepts an inline Node 20 pin', () => {
    expect(() =>
      expectEffectiveNode20("      node-version: '20.20.2'\n", 'w.yml'),
    ).not.toThrow();
  });

  it('accepts an unquoted inline pin', () => {
    expect(() =>
      expectEffectiveNode20('      node-version: 20\n', 'w.yml'),
    ).not.toThrow();
  });

  // The migration that broke the original assertions.
  it('accepts a node-version-file pointing at .nvmrc', () => {
    expect(() =>
      expectEffectiveNode20("      node-version-file: '.nvmrc'\n", 'w.yml'),
    ).not.toThrow();
  });

  it('rejects an inline pin on a different major', () => {
    expect(() =>
      expectEffectiveNode20("      node-version: '22.22.2'\n", 'w.yml'),
    ).toThrow();
  });

  it('rejects a workflow that declares no Node pin at all', () => {
    expect(() => expectEffectiveNode20('      uses: actions/checkout@v4\n', 'w.yml')).toThrow();
  });

  it('rejects deferral to an unexpected version file', () => {
    expect(() =>
      expectEffectiveNode20("      node-version-file: '.tool-versions'\n", 'w.yml'),
    ).toThrow();
  });

  it('names the workflow in the failure message', () => {
    expect(() =>
      expectEffectiveNode20("      node-version: '18'\n", 'deploy.yml'),
    ).toThrow(/deploy\.yml/);
  });
});
