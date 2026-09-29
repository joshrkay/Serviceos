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

// Browsers hash the EXACT text between <script> and </script>, surrounding
// whitespace included. Stripping the leading/trailing newlines here (#1397)
// let a wrong pin pass CI while production blocked the Pendo loader. The
// vitest guard packages/web/src/csp-inline-script-hash.test.ts pins the full
// set of inline-script hashes.
const inlineScript = sourceHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
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

// #1481 — the Railway edge renders the API's public origin into connect-src
// at boot (presigned dev-storage PUTs target the API host). The rendering
// itself is covered by packages/web/src/csp-api-origin.test.ts.
assert.match(
  railwayDockerfile,
  /COPY packages\/web\/render-security-headers\.sh \/render-security-headers\.sh/,
  'Railway Dockerfile must ship the CSP API-origin renderer',
);
assert.match(
  read('packages/web/start.sh'),
  /\/render-security-headers\.sh \/etc\/nginx\/security-headers\.conf/,
  'Railway start.sh must render the API origin into the CSP before nginx starts',
);

const cspValue = snippet.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
assert.ok(cspValue, 'CSP header must be present');
const directives = new Map(
  cspValue
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const [name, ...sources] = d.split(/\s+/);
      return [name, sources];
    }),
);

// Clerk loads clerk-js and talks to its Frontend API from the instance's FAPI
// host. In production that host is the custom domain encoded in the pk_live_
// publishable key (clerk.therivetapp.com), NOT a *.clerk.com / *.clerk.accounts.dev
// host — leaving it out blanked /login and /signup in prod (2026-09-17..23).
// Sign-up bot protection is Cloudflare Turnstile, which needs its script and
// iframe origins. See https://clerk.com/docs/guides/secure/best-practices/csp-headers
const clerkRequirements = [
  ['script-src', 'https://clerk.therivetapp.com'],
  ['connect-src', 'https://clerk.therivetapp.com'],
  ['script-src', 'https://challenges.cloudflare.com'],
  ['frame-src', 'https://challenges.cloudflare.com'],
  ['script-src', 'https://*.protect.clerk.com'],
  ['connect-src', 'https://*.protect.clerk.com:*'],
  ['frame-src', 'https://*.protect.clerk.com'],
];
for (const [directive, origin] of clerkRequirements) {
  assert.ok(
    directives.get(directive)?.includes(origin),
    `${directive} must allow ${origin} (Clerk production FAPI / Turnstile)`,
  );
}

console.log('PASS: both web hosts emit the approved security-header contract');
