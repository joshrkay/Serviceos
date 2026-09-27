/**
 * #1397 — the CSP pinned a hash that did not match the served inline Pendo
 * loader, so the browser blocked it (Pendo never loaded, console error on
 * every page). The old guard (scripts/ci/test-web-security-headers.mjs)
 * hashed the script body with its leading/trailing newlines stripped, but a
 * browser hashes the EXACT text between `<script>` and `</script>` —
 * whitespace included — so the check passed while production broke.
 *
 * This derives the hashes from index.html the way a browser does and
 * asserts script-src allows exactly those hashes: no stale pin, no extras.
 * (Vite copies classic inline scripts into dist/index.html verbatim — the
 * QA sweep's served-page hash equals the source hash.)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
const securityHeaders = readFileSync(resolve(webRoot, 'security-headers.conf'), 'utf8');

function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const attrs = match[1] ?? '';
    if (/\bsrc\s*=/.test(attrs)) continue; // external script — not hash-gated
    const body = match[2];
    hashes.push(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
  }
  return hashes;
}

function scriptSrcHashes(conf: string): string[] {
  const csp = conf.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
  if (!csp) throw new Error('security-headers.conf must emit a Content-Security-Policy');
  const scriptSrc = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('script-src '));
  if (!scriptSrc) throw new Error('CSP must declare script-src');
  return scriptSrc
    .split(/\s+/)
    .filter((s) => /^'sha(256|384|512)-/.test(s))
    .map((s) => s.slice(1, -1));
}

describe('CSP inline-script hashes (#1397)', () => {
  it('index.html has the Pendo inline loader to hash', () => {
    expect(inlineScriptHashes(indexHtml)).toHaveLength(1);
  });

  it('script-src allows exactly the sha256 of each inline <script> in index.html', () => {
    expect(scriptSrcHashes(securityHeaders).sort()).toEqual(
      inlineScriptHashes(indexHtml).sort(),
    );
  });

  it('pins the hash the QA sweep measured on the served page', () => {
    // Independent source of truth: the hash the browser reported for the
    // served inline loader (dev QA sweep 2026-09-26). If index.html's inline
    // script is edited, this literal must be re-measured, not recomputed.
    expect(scriptSrcHashes(securityHeaders)).toContain(
      'sha256-aZMpeYECdzzxmDLBhnOjENAvYOF7sj61Qkt1ogk9GMk=',
    );
  });
});
