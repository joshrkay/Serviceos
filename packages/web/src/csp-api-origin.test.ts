/**
 * #1481 item 1 — on a deployed environment the dev storage provider hands
 * the browser a presigned PUT on the API's own public host
 * (`${PUBLIC_API_URL}/storage-dev/...`), a different origin from the web
 * edge. connect-src only allowed 'self', so the photo upload failed with
 * "Failed to fetch". The Railway web edge already knows the API's public
 * URL (API_URL, the /api proxy target); start.sh renders its origin into
 * connect-src via render-security-headers.sh.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(__dirname, '..');

function renderConnectSrc(apiUrl: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'csp-'));
  const conf = join(dir, 'security-headers.conf');
  copyFileSync(resolve(webRoot, 'security-headers.conf'), conf);
  execFileSync('sh', [resolve(webRoot, 'render-security-headers.sh'), conf], {
    env: { ...process.env, API_URL: apiUrl },
  });
  const csp = readFileSync(conf, 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
  if (!csp) throw new Error('rendered conf lost its Content-Security-Policy');
  const connect = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('connect-src '));
  if (!connect) throw new Error('rendered CSP lost connect-src');
  return connect.split(/\s+/).slice(1);
}

describe('web CSP allows the API origin for presigned uploads (#1481)', () => {
  it('adds the API public origin to connect-src', () => {
    const sources = renderConnectSrc('https://serviceosapi-development.up.railway.app');
    expect(sources).toContain('https://serviceosapi-development.up.railway.app');
    expect(sources).toContain("'self'");
  });

  it('uses the origin only, dropping any path or trailing slash', () => {
    const sources = renderConnectSrc('https://api.example.test/some/path/');
    expect(sources).toContain('https://api.example.test');
    expect(sources.some((s) => s.includes('/some/path'))).toBe(false);
  });

  it('keeps the port of a local API', () => {
    expect(renderConnectSrc('http://localhost:3000')).toContain('http://localhost:3000');
  });

  it('never widens connect-src to a wildcard', () => {
    const sources = renderConnectSrc('https://api.example.test');
    expect(sources).not.toContain('*');
    expect(sources).not.toContain('https:');
  });
});
