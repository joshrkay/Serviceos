import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const snippet = read('packages/web/security-headers.conf');
const railwayConfig = read('packages/web/nginx.conf.template');
const composeConfig = read('packages/web/nginx.conf');
const railwayDockerfile = read('packages/web/Dockerfile');
const rootDockerfile = read('Dockerfile');
const sourceHtml = read('packages/web/index.html');

const requiredHeaders = new Map([
  ['Content-Security-Policy', "default-src 'self'"],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
]);

for (const [header, value] of requiredHeaders) {
  assert.match(snippet, new RegExp(`add_header ${header} `), `${header} must be emitted`);
  assert.ok(snippet.includes(value), `${header} must use the approved value`);
}

assert.match(snippet, /frame-ancestors 'none'/, 'CSP must prevent framing in modern browsers');
assert.match(snippet, /object-src 'none'/, 'CSP must block plugin content');

const inlineScript = sourceHtml.match(/<script>\n([\s\S]*?)\n    <\/script>/)?.[1];
assert.ok(inlineScript, 'index.html must contain the expected inline Pendo bootstrap');
const inlineHash = `sha256-${createHash('sha256').update(inlineScript).digest('base64')}`;
assert.ok(
  snippet.includes(`'${inlineHash}'`),
  'CSP must authorize the exact checked-in inline script and nothing broader',
);

const include = 'include /etc/nginx/security-headers.conf;';
for (const [name, config] of [
  ['Railway', railwayConfig],
  ['compose', composeConfig],
]) {
  const occurrences = config.split(include).length - 1;
  assert.equal(
    occurrences,
    5,
    `${name} config must include security headers at server scope and in assets, index.html, env.js, and health`,
  );
}

for (const [name, dockerfile] of [
  ['Railway', railwayDockerfile],
  ['root', rootDockerfile],
]) {
  assert.match(
    dockerfile,
    /COPY packages\/web\/security-headers\.conf \/etc\/nginx\/security-headers\.conf/,
    `${name} Dockerfile must copy the shared header snippet`,
  );
}

console.log('PASS: both web hosts emit the approved security-header contract');
