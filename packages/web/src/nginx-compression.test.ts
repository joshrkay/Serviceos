/**
 * #1397 — web assets were served uncompressed (the 152KB main script had no
 * Content-Encoding). Both web hosts (Railway: nginx.conf.template; compose:
 * nginx.conf) must gzip the text asset types the SPA ships. The stock
 * nginx:alpine image has the gzip module built in (brotli would need a
 * third-party module), so gzip is the contract here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(__dirname, '..');
const hosts = [
  ['Railway (nginx.conf.template)', readFileSync(resolve(webRoot, 'nginx.conf.template'), 'utf8')],
  ['compose (nginx.conf)', readFileSync(resolve(webRoot, 'nginx.conf'), 'utf8')],
] as const;

function directive(conf: string, name: string): string | undefined {
  return conf.match(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'm'))?.[1].trim();
}

describe('web edge compression (#1397)', () => {
  for (const [name, conf] of hosts) {
    it(`${name} gzips JS, CSS, JSON, SVG and HTML`, () => {
      expect(directive(conf, 'gzip')).toBe('on');
      const types = (directive(conf, 'gzip_types') ?? '').split(/\s+/);
      // text/html is always compressed once gzip is on; the rest must be listed.
      for (const type of [
        'application/javascript',
        'text/css',
        'application/json',
        'image/svg+xml',
      ]) {
        expect(types).toContain(type);
      }
      expect(directive(conf, 'gzip_vary')).toBe('on');
    });
  }
});
