---
title: "Web app security response headers (CSP/HSTS/X-Frame-Options/etc.) — mechanism & config for serviceosweb"
date: 2026-09-16
status: answered
author: deep-research workflow
tags: [security, headers, nginx, railway, csp]
---

# Web app security response headers — mechanism & config for `serviceosweb-*`

> **What this is:** An answer to GitHub issue joshrkay/Serviceos#1284 — the web app
> (Railway service `serviceosweb-development`, and its production sibling
> `serviceosweb-production`) sends no CSP, HSTS, `X-Frame-Options`,
> `X-Content-Type-Options`, or `Referrer-Policy`. This documents the exact
> mechanism to fix that given how this repo actually builds and deploys
> `packages/web`, the exact config to add, a CSP allowlist matched against the
> SPA's real third-party dependencies (grepped from source, not guessed), and a
> curl-based post-deploy verification procedure.

---

## 0. Method & confidence caveats (read first)

- **Source-code audit** of `packages/web` (Dockerfile, `railway.toml`, `start.sh`,
  `nginx.conf.template`, `nginx.conf`, `index.html`, `env.js.template`,
  `render-runtime-config.sh`, and every `src/` file that talks to a third party),
  cross-checked against `packages/api/src/bootstrap/helmet-options.ts` (the API's
  own confirmed-working helmet/CSP precedent).
- **Primary-source fetches**: nginx.org's own `ngx_http_headers_module` docs,
  Railway's own docs (`docs.railway.com`) for Dockerfiles, config-as-code, and
  edge rules, Pendo's own CSP support article, MDN's CSP `connect-src`/`style-src`
  pages, and the W3C `webappsec-csp` GitHub history for the `'self'`+WebSocket
  question. All cited inline and in §7.
- **Confidence tags**: ✅ verified against a primary source or this repo's own
  code · 🟡 inferred from repo code + vendor docs, not yet run against a live
  deploy · 🔴 needs a human/Railway-dashboard action this research cannot do.
- The one thing this research **could not do**: run an actual `vite build` of
  `packages/web` to inspect the literal built `dist/index.html` bytes (would
  require `npm ci`, out of scope for a docs-only pass). The CSP hash source
  given in §3 is computed against the **current source** `packages/web/index.html`
  and is flagged for re-verification against the real build output before ship.

---

## 1. Answer: the mechanism

**Headers must be set with nginx's `add_header` directive inside
`packages/web/nginx.conf.template`.** There is no other layer in this repo's
actual deploy path that can do it:

- `packages/web` is not served by Node/helmet. `packages/web/Dockerfile` builds
  the Vite SPA (`npm run build --workspace=packages/web` → `packages/web/dist`)
  in a `node:20-alpine` stage, then copies the static output into a second
  `FROM nginx:alpine` stage that serves it. Helmet (`packages/api/src/bootstrap/helmet-options.ts`)
  only runs inside `packages/api`'s Express process — a completely separate
  Railway service (`packages/web/railway.toml` has its own
  `builder = "dockerfile"` / `dockerfilePath = "packages/web/Dockerfile"`,
  distinct from the API's root `railway.toml`/`Dockerfile`).
- It is **not** Railway's static-site/Caddy builder either — `railway.toml`'s
  `builder` is `"dockerfile"`, not Railway's Railpack/static path, so none of
  Railway's static-hosting features (which this repo doesn't use anyway) apply.
- **Railway has no platform-level "custom response headers" feature for a
  Dockerfile-deployed service.** Confirmed against Railway's own docs:
  - `docs.railway.com/reference/config-as-code` — the full list of `railway.toml`
    keys is build (`builder`, `watchPatterns`, `buildCommand`, `dockerfilePath`,
    `railpackVersion`) and deploy (`startCommand`, `preDeployCommand`,
    `multiRegionConfig`, `healthcheckPath`, `healthcheckTimeout`,
    `restartPolicyType`, `restartPolicyMaxRetries`, `cronSchedule`,
    `overlapSeconds`, `drainingSeconds`) plus per-environment overrides. **No
    header key exists.** ✅
  - `docs.railway.com/networking/edge-rules` — Railway's one edge-level HTTP
    feature (Block / Allow / Challenge / Redirect / Override-cache) explicitly
    **does not manipulate response headers**; it only blocks, allows,
    challenges, redirects, or overrides cache behavior. ✅
  - `docs.railway.com/builds/dockerfiles` — no mention of headers; a
    Dockerfile-builder service is just "run this container," full stop. ✅
  - Conclusion: for `serviceosweb-*`, the container's own server (nginx) is the
    only place headers can be added — matching the working assumption in the
    issue, now confirmed rather than assumed.
- nginx's config is **templated at container start, not static**:
  `packages/web/start.sh` runs
  `envsubst '${PORT} ${API_URL}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf`,
  `nginx -t`, then `exec nginx -g 'daemon off;'`. The file to edit is
  **`packages/web/nginx.conf.template`** (copied into the image at
  `/etc/nginx/templates/default.conf.template` by the Dockerfile). There is a
  second, unrelated file, **`packages/web/nginx.conf`**, used only by
  docker-compose/single-host deploys (its own header comment says so, and
  `docs/deployment.md:282` documents the split) — do not edit that one for this
  fix, though its Cache-Control blocks are meant to be kept in sync per that
  same comment, so this research also shows the compose file's diff for parity.

---

## 2. The nginx gotcha this fix has to get right

`packages/web/nginx.conf.template`'s `/assets/`, `= /index.html`, and
`= /env.js` locations **already each declare their own `add_header`** (for
`Cache-Control`). Per nginx's own docs (`ngx_http_headers_module`, `add_header`),
fetched verbatim:

> "These directives are inherited from the previous configuration level if and
> only if there are no `add_header` directives defined on the current level."

✅ Confirmed against `nginx.org/en/docs/http/ngx_http_headers_module.html`. In
plain terms: if the new security headers are only added to the `server {}`
block, **`/assets/`, `/index.html`, and `/env.js` will silently get none of
them**, because each already has its own `add_header` for Cache-Control, which
blocks inheritance from `server` entirely — for that location. `/index.html` is
what every browser navigation actually loads, so this is not a corner case, it
is the main case.

The idiomatic fix, standard nginx practice, and the one this research
recommends: put every `add_header` line for the new headers in one shared
`include`-able snippet file, then `include` it **both** in the `server {}`
block (covers every location that declares no `add_header` of its own —
`/`, `/api/`, `/api/ws`, `/public/`, the marketing-redirect regex, `/health`)
**and** individually inside `/assets/`, `= /index.html`, `= /env.js` (each of
which already breaks inheritance). `include` is a pure textual splice, so the
directives become "native" to each block they're spliced into rather than
inherited — this sidesteps the inheritance rule entirely rather than fighting
it.

- The base image is the unpinned `nginx:alpine` tag (`packages/web/Dockerfile`
  line `FROM nginx:alpine`). nginx ≥ 1.29.3 has an `add_header_inherit`
  directive that can change this behavior (`add_header_inherit merge;`), but
  since the image isn't pinned to a version that guarantees that directive
  exists, don't depend on it — the `include`-snippet pattern works on every
  nginx version and is the long-standing idiomatic answer to this exact
  problem. 🟡 (version-dependent feature exists, but not relied on here)
- **`always`** is a separate, unrelated knob: by default `add_header` only
  applies on response codes 200/201/204/206/301/302/303/304/307/308; `always`
  (nginx ≥ 1.7.5) makes it apply to every response code, including 4xx/5xx.
  This matters here because nginx's own generated error responses (e.g. a
  `try_files` 404) should still carry CSP/HSTS/etc. — so every line in the new
  snippet uses `always`. This is orthogonal to the inheritance issue above;
  `always` does not fix inheritance and inheritance-splicing does not need
  `always` to work. ✅ confirmed against the same nginx doc.
- `start.sh`'s `envsubst '${PORT} ${API_URL}' < ...` names only two variables.
  None of the header values proposed below contain a `$`-prefixed token, so
  nothing needs to be added to that allow-list, and the new `include` line
  (added below) is also `$`-free so it passes through `envsubst` unchanged. ✅
  (verified by reading every line proposed in §3/§4 for a literal `$`.)

---

## 3. Third-party dependencies this CSP has to allow (grepped from `packages/web/src` and `index.html`)

| Dependency | Evidence | CSP directive(s) needed |
|---|---|---|
| **Clerk** (auth) | `src/main.tsx` (`ClerkProvider`, `clerkJSVersion="5.127.0"`), used throughout via `@clerk/clerk-react` | `script-src`, `style-src`, `connect-src`, `frame-src`: `https://*.clerk.com https://*.clerk.accounts.dev https://clerk.com` |
| **Stripe.js / Elements** | `src/lib/stripeConnect.ts` (`loadStripe` from `@stripe/stripe-js`), used in `src/components/customer/InvoicePaymentPage.tsx` | `loadStripe` injects `https://js.stripe.com/v3` itself → `script-src https://js.stripe.com`; Elements renders in iframes → `frame-src https://js.stripe.com https://hooks.stripe.com`; API calls → `connect-src https://api.stripe.com` |
| **Pendo** | Inline snippet in `index.html` loading `https://cdn.pendo.io/agent/static/<key>/pendo.js`, gated off view-token public routes (`/portal/:token`, `/pay/:id`, `/e/:id`, `/feedback/:token`, `/intake`, `/book`) | See dedicated Pendo subsection below — **new vs. the API's CSP, which has none of this** |
| **PostHog** (`posthog-js`) | `src/lib/analytics.ts` (default host `https://us.i.posthog.com`, lazy `import('posthog-js')`), `src/lib/errorReporter.ts` (routes through the same `track()`) | `connect-src https://us.i.posthog.com https://us-assets.i.posthog.com`; `script-src https://us-assets.i.posthog.com` (lazy-loaded optional modules) — same hosts the API's own CSP already uses for the same reason |
| **Google Fonts** | `index.html`: `<link rel="preconnect" href="https://fonts.googleapis.com">`, `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`, and a `css2?family=...` stylesheet | `style-src https://fonts.googleapis.com` (the stylesheet); `font-src https://fonts.gstatic.com` (the actual font files — **a separate directive from style-src**, confirmed against MDN: `@font-face`/font file loading is governed by `font-src`, not `style-src`) — **new vs. the API's CSP, which serves no HTML/fonts** |
| **Same-origin WS `/api/ws`** | `nginx.conf.template`'s `location = /api/ws` proxies to `${API_URL}` | `connect-src 'self'` — see the `'self'`-and-`wss:` caveat below |
| **Direct Deepgram WS** | `src/hooks/useDeepgramDictation.ts`: `const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com/v1/listen'`, opened via `new WebSocket(...)` | `connect-src wss://api.deepgram.com` — same as the API's own CSP, same reason |
| Service worker `/sw.js` | `src/pwa/register-sw.ts` registers `/sw.js` at scope `/` (same-origin, confirmed by test: `expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })`) | Same-origin, covered by `worker-src 'self'` |
| Dynamic `<img>` from unpredictable hosts | `src/components/jobs/JobPhotoGallery.tsx`, `src/components/attachments/AttachmentSection.tsx`, `src/components/shared/CameraCapture.tsx`, `src/components/customer/EstimateApprovalPage.tsx` all render `<img src={item.url}>`/`<img src={media.url}>` from job-photo/attachment upload URLs (object-storage-backed, host not fixed) | `img-src https:` — same broad allowance the API's own CSP already uses, for the same reason (arbitrary upload-storage hosts) |
| **Twilio** — checked, **not needed** | Grepped `packages/web/src` for `twilio`/`Twilio`: only hits are UI copy strings about *server-side* phone-number provisioning (`src/components/onboarding/v2/steps/PhoneStep.tsx`, `src/components/auth/ProtectedRoute.tsx`) — no Twilio Voice JS SDK is loaded in the browser here | **Omit** `sdk.twilio.com`/`media.twiliocdn.com`/`*.twilio.com` — this is a genuine divergence from the API's CSP, which needs them for its own reasons |
| **Sentry** — checked, **not needed** | Grepped `packages/web/src` and `packages/web/package.json` for `[Ss]entry`: zero hits. `src/lib/errorReporter.ts` reports errors through PostHog only, not a Sentry browser SDK | **Omit** the API's `*.ingest.sentry.io`/`*.ingest.us.sentry.io` entries entirely — the API needs them for a server-side Sentry SDK the web bundle doesn't ship |
| One static inline `<script>` | `index.html`'s Pendo bootstrap loader is a literal inline `<script>` block (not `nonce`'d — this is a static-file nginx host, no per-request templating to mint a nonce) | Needs either a `'sha256-...'` hash source in `script-src`, or `'unsafe-inline'` — see below |
| Dynamically-generated inline `<style>` | `src/components/ui/chart.tsx` uses `dangerouslySetInnerHTML` on a `<style>` tag to inject per-chart-instance CSS custom properties (content varies per chart `id`, so **cannot** be pinned by a static hash) | Requires `style-src 'unsafe-inline'` — no nonce/hash alternative is feasible on a static SPA host, and this already matches the API's existing precedent (`styleSrc: ["'self'", "'unsafe-inline'", ...]`) |

### Pendo's own CSP requirements (fetched from `support.pendo.io`)

Pendo's Content-Security-Policy support article (✅ fetched directly) lists,
per directive (`{{ SUB_ID }}` is a per-Pendo-subscription placeholder this
research cannot resolve without a Pendo dashboard/support lookup — 🔴):

- `script-src`: `cdn.pendo.io`, `pendo-io-static.storage.googleapis.com`,
  `pendo-static-{{SUB_ID}}.storage.googleapis.com`,
  `content-{{SUB_ID}}.static.pendo.io`, `data.pendo.io` (JSONP delivery),
  `app.pendo.io` (Visual Design Studio only)
- `style-src`: the same `*.storage.googleapis.com`/`*.static.pendo.io` hosts,
  plus `'unsafe-inline'` (guide pseudo-styles) and `app.pendo.io` (VDS only)
- `img-src`: `cdn.pendo.io`, `data.pendo.io`, the storage/static hosts, `data:`
- `connect-src`: `data.pendo.io`, the storage/static hosts, `app.pendo.io` (VDS)
- `frame-src`: `app.pendo.io` (Visual Design Studio/Classic Designer),
  `portal.pendo.io` (Listen ideas portal)

**What's confirmed-necessary from this repo's snippet alone**: only
`https://cdn.pendo.io` in `script-src` (that's literally the only URL the
inline loader references). **What's Pendo-documented but not confirmed against
this specific subscription's actual guide usage** (🟡 inferred, flagged): if
Pendo guides/Resource Center content is or will be used, `data.pendo.io` and
`https://*.storage.googleapis.com` should be added to `img-src` (already
covered by the broad `img-src https:` below, so no action needed) and to
`connect-src`/`script-src` (not otherwise covered, so added explicitly below).
`app.pendo.io`/`portal.pendo.io` (Visual Design Studio / feedback portal) are
**omitted** from the starting CSP — they're only needed if someone configuring
Pendo guides opens the in-app visual designer while logged into production;
add them to `frame-src`/`connect-src` if that workflow breaks after this ships.

### The `'self'` + WebSocket nuance (worth flagging explicitly)

MDN's `connect-src` page carries an explicit caution:
> "`connect-src 'self'` does not resolve to websocket schemes in all browsers"
citing `w3c/webappsec-csp` issue #7. ✅ fetched directly from MDN. Digging into
that issue's resolution: CSP **Level 3** explicitly added scheme-upgrade
matching so that `'self'` on an `https:` origin also matches `wss:` (the
secure variant), while **not** matching plain `ws:` — i.e. modern (CSP3)
browsers should treat `connect-src 'self'` as sufficient for a same-origin
`wss://` connection like this app's `/api/ws`, but this was genuinely
inconsistent in older/CSP2-era implementations, which is exactly why MDN keeps
the warning. Since every evergreen browser today implements CSP3's
scheme-upgrade rule, `'self'` should cover `/api/ws`, but **this should be
spot-checked in a real browser's Network tab post-deploy** (curl cannot
exercise a CSP-gated WebSocket upgrade meaningfully) — flagged 🔴 for a human
check, not asserted as fully verified here.

---

## 4. Exact CSP directive value to start from

```
default-src 'self';
script-src 'self' https://js.stripe.com https://*.clerk.com https://*.clerk.accounts.dev https://clerk.com https://cdn.pendo.io https://us-assets.i.posthog.com 'sha256-lENftx+7152rVD4twAey4nIX8X+7mNlgZFtJB6y2e+I=';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.clerk.com https://clerk.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: blob: https:;
connect-src 'self' https://api.stripe.com https://*.clerk.com https://clerk.com https://*.clerk.accounts.dev wss://api.deepgram.com https://us.i.posthog.com https://us-assets.i.posthog.com https://data.pendo.io https://*.storage.googleapis.com;
frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://*.clerk.com;
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
frame-ancestors 'none';
```

Notes on individual choices:

- **`script-src`'s hash source** (`'sha256-lENftx+7152rVD4twAey4nIX8X+7mNlgZFtJB6y2e+I='`)
  was computed against the current `packages/web/index.html` source's inline
  `<script>...</script>` block content (the Pendo bootstrap loader) with:
  ```bash
  node -e "
  const fs=require('fs'), crypto=require('crypto');
  const html=fs.readFileSync('packages/web/index.html','utf8');
  const m=html.match(/<script>\n([\s\S]*?)\n    <\/script>/);
  console.log('sha256-'+crypto.createHash('sha256').update(m[1],'utf8').digest('base64'));
  "
  ```
  🟡 **This must be recomputed against the actual built `dist/index.html`**
  (not the source file) before shipping — this research didn't run
  `npm ci && npm run build --workspace=packages/web` to confirm Vite's HTML
  output preserves this block byte-for-byte (no HTML-minifier plugin was found
  in `packages/web/package.json`, which suggests it should, but "should"
  isn't "confirmed"). If the hash doesn't match after a real build, the
  fallback is `'unsafe-inline'` in `script-src` — acceptable here since the
  only inline script is static, checked-in content (not attacker- or
  user-controlled), but strictly weaker than a hash and should be treated as
  a stopgap, not a "done."
- **`style-src 'unsafe-inline'`** is required (not optional) because
  `src/components/ui/chart.tsx` generates a `<style>` tag via
  `dangerouslySetInnerHTML` whose content varies per chart instance — no
  static hash can cover it, and there's no per-request nonce mechanism on a
  static nginx host. This exactly matches the API's own precedent
  (`styleSrc: ["'self'", "'unsafe-inline'", ...]` in `helmet-options.ts`), so
  it isn't a new risk being introduced, just a repeat of an already-accepted
  one.
- **`img-src 'self' data: blob: https:'`** deliberately mirrors the API's own
  broad allowance rather than trying to enumerate every image host — this
  repo's job-photo/attachment `<img>` tags load from unpredictable
  object-storage URLs (see table above), the same reason the API's CSP is
  broad here.
- **`connect-src`** omits Twilio and Sentry hosts present in the API's CSP —
  confirmed by grep that `packages/web/src` uses neither in the browser (see
  table above). Do not copy those two entries over "just in case."
- **CSP on proxied `/api/*` responses**: since `/api/`, `/api/ws`, `/public/`
  declare no `add_header` of their own, they'll inherit this same CSP from the
  `server` block by nginx's normal inheritance rule — on top of whatever
  headers the API's own helmet middleware already sends upstream (nginx
  forwards upstream response headers by default; `add_header` appends,
  doesn't replace). For JSON API responses this is functionally harmless (no
  script-execution context to gate), just slightly redundant. If a "single
  source of truth per response type" is wanted, add
  `proxy_hide_header Content-Security-Policy;` (and similarly for the other
  four) inside `/api/`, `/api/ws`, `/public/` — not required by this ticket,
  called out for completeness.

---

## 5. HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy

| Header | Value | Justification |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Matches the API's `helmet-options.ts` exactly (1 year, `includeSubDomains`, **no** `preload`). `preload` is deliberately omitted — submission to the HSTS preload list is a one-way, manual, deliberate action, same reasoning already recorded in the API's own code comment. Safe on a shared Railway domain (`*.up.railway.app`): `includeSubDomains` served from `serviceosweb-development.up.railway.app` only affects subdomains *of that specific host* (e.g. `foo.serviceosweb-development.up.railway.app`), not sibling Railway apps under `up.railway.app` — it does not cascade cross-tenant. |
| `X-Frame-Options` | `DENY` | Matches the API. No documented or code-referenced reason this app is ever legitimately iframed by anything else — grepped `docs/*.md` for `iframe`/`X-Frame-Options`/`frame-ancestors`/embedding language and found nothing. `frame-ancestors 'none'` in the CSP (§4) is the modern, CSP3-preferred version of the same restriction and is included too (browsers that support `frame-ancestors` ignore `X-Frame-Options`; both are set for defense-in-depth / older-browser coverage, same as the API). |
| `X-Content-Type-Options` | `nosniff` | Matches the API; standard MIME-sniffing protection, no reason to differ for static assets. |
| `Referrer-Policy` | `no-referrer` | Matches the API. Notably relevant here because several of this app's own routes carry bearer-style tokens in the URL path itself (`/portal/:token`, `/pay/:id`, `/e/:id`, `/feedback/:token` — the same set the Pendo snippet excludes for the identical leak concern). `no-referrer` prevents those paths leaking via the `Referer` header to any cross-origin resource this page loads (fonts.gstatic.com, js.stripe.com, cdn.pendo.io, etc.) — arguably an even stronger reason to use it here than on the API. |

---

## 6. Exact config to add

### 6.1 New file: `packages/web/security-headers.conf`

```nginx
# Shared response-header directives for every response from this nginx edge
# (packages/web/Dockerfile, Railway service serviceosweb-*). `include`d from
# the `server {}` block in nginx.conf.template AND individually inside the
# /assets/, = /index.html, and = /env.js locations, because nginx's add_header
# is inherited into a location ONLY if that location declares no add_header of
# its own (ngx_http_headers_module docs) — those three already set their own
# Cache-Control add_header, which would otherwise silently swallow these.
# `include` is a pure textual splice, so this file becomes "native" to every
# block it's spliced into rather than something to inherit.
#
# No `$`-prefixed nginx variables appear below, so nothing here needs adding
# to start.sh's `envsubst '${PORT} ${API_URL}' ...` explicit variable list.

add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://js.stripe.com https://*.clerk.com https://*.clerk.accounts.dev https://clerk.com https://cdn.pendo.io https://us-assets.i.posthog.com 'sha256-lENftx+7152rVD4twAey4nIX8X+7mNlgZFtJB6y2e+I='; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.clerk.com https://clerk.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://api.stripe.com https://*.clerk.com https://clerk.com https://*.clerk.accounts.dev wss://api.deepgram.com https://us.i.posthog.com https://us-assets.i.posthog.com https://data.pendo.io https://*.storage.googleapis.com; frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://*.clerk.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
```

### 6.2 `packages/web/nginx.conf.template` — diff

```diff
 server {
     listen ${PORT};
     root /usr/share/nginx/html;
     index index.html;
+
+    # Security response headers (CSP/HSTS/X-Frame-Options/nosniff/Referrer-
+    # Policy) applied to every response from this edge. See
+    # packages/web/security-headers.conf for why this is `include`d here AND
+    # re-`include`d inside /assets/, = /index.html, and = /env.js below.
+    include /etc/nginx/security-headers.conf;
```
```diff
     location /assets/ {
+        include /etc/nginx/security-headers.conf;
         add_header Cache-Control "public, max-age=31536000, immutable";
     }
```
```diff
     location = /index.html {
+        include /etc/nginx/security-headers.conf;
         add_header Cache-Control "no-cache" always;
     }

     location = /env.js {
+        include /etc/nginx/security-headers.conf;
         add_header Cache-Control "no-cache, must-revalidate";
     }
```

(`/`, `/api/`, `/api/ws`, `/public/`, the marketing-redirect regex location,
and `/health` need **no** change — none of them declare an `add_header` today,
so they inherit the new headers from the `server {}` block automatically.)

### 6.3 `packages/web/Dockerfile` — diff

The new snippet file needs its own `COPY` — it is plain, static config with no
`$`-substitution needed, so it should **not** go through the
`/etc/nginx/templates/` + `envsubst` machinery (that only processes files
matching `*.template` and would just add confusion for a file that needs no
substitution). Copy it straight to a fixed path instead:

```diff
 COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
 COPY packages/web/nginx.conf.template /etc/nginx/templates/default.conf.template
+COPY packages/web/security-headers.conf /etc/nginx/security-headers.conf
 COPY packages/web/env.js.template /etc/nginx/templates/env.js.template
```

### 6.4 (Parity) `packages/web/nginx.conf` — the docker-compose variant

Not part of the Railway fix, but `docs/deployment.md:282` documents that this
file's cache-header blocks are meant to be kept in sync with the `.template`
one, so for consistency across the two nginx configs: apply the same
`include`/`add_header` changes to `packages/web/nginx.conf`'s `server {}`,
`/assets/`, `= /index.html`, and `= /env.js` blocks, and add the compose
Dockerfile's own `COPY packages/web/security-headers.conf ...` line
(wherever that file is built — outside the scope of this research, which was
scoped to the Railway `serviceosweb-*` fix per the issue).

---

## 7. Verification (post-deploy, curl-based)

Run against the live host once deployed. Confirmed hostname for the
`serviceosweb-development` service (✅ appears consistently across
`qa/qa-matrix-live-runbook.md`, `docs/runbooks/dev-environment-local.md`,
multiple `docs/verification-runs/*.md`):
`https://serviceosweb-development.up.railway.app` (production:
`https://serviceosweb-production.up.railway.app`, also reachable at the custom
domain `https://app.therivetapp.com` per
`docs/verification-runs/production-retest-2026-07-23.md`).

```bash
BASE=https://serviceosweb-development.up.railway.app

# 1. SPA fallback route ("/") — proves the server-block include worked.
curl -sSI "$BASE/" | grep -Ei '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy):'

# 2. /index.html directly — this is the location that ALREADY had its own
#    add_header for Cache-Control, so this is the specific check that proves
#    the inheritance-gotcha fix actually worked, not just that headers exist
#    somewhere on the site.
curl -sSI "$BASE/index.html" | grep -Ei '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy):'

# 3. A real /assets/* path — same inheritance check, on the other location
#    that already had its own add_header. Get a real filename from index.html
#    first since Vite content-hashes every asset filename per build:
ASSET_PATH=$(curl -sS "$BASE/" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)
curl -sSI "$BASE$ASSET_PATH" | grep -Ei '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy):'

# 4. /env.js — the third location with its own pre-existing add_header.
curl -sSI "$BASE/env.js" | grep -Ei '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy):'

# 5. Sanity check: confirm existing Cache-Control on these three locations was
#    NOT clobbered by the change (it should still be present alongside the
#    new security headers, since `include` is additive, not a replacement).
curl -sSI "$BASE/index.html" | grep -i '^cache-control:'
curl -sSI "$BASE$ASSET_PATH" | grep -i '^cache-control:'
```

Expected on every one of `/`, `/index.html`, `/assets/*`, `/env.js`:
`content-security-policy`, `strict-transport-security`, `x-frame-options`,
`x-content-type-options`, and `referrer-policy` all present, with the
`content-security-policy` value matching §4 and no `Content-Security-Policy`
console errors when actually loading the page in a browser (curl proves the
header shipped; only a real browser proves the allowlist doesn't break Clerk
sign-in, Stripe Elements, Pendo, PostHog, Google Fonts, or the `/api/ws` and
Deepgram WebSockets — check DevTools Console + Network for CSP violation
reports after deploying, especially around the hash-based `script-src` entry
per the §4 caveat).

---

## 8. What's confirmed vs. inferred vs. still needs a human

**✅ Confirmed from a primary source or direct repo read:**
- nginx's `add_header` inheritance rule and `always` semantics (nginx.org docs).
- Railway has no header-setting feature for Dockerfile services, in
  config-as-code or edge rules (docs.railway.com, two pages fetched).
- Pendo's documented CSP host list (support.pendo.io).
- `font-src` vs `style-src` split for `@font-face` (MDN).
- The `'self'`+`wss:` CSP3 scheme-upgrade behavior and its CSP2-era
  inconsistency (MDN + W3C webappsec-csp issue history).
- Every third-party host and code path in the table in §3 (grepped directly).
- The API's existing CSP shape, via `packages/api/src/bootstrap/helmet-options.ts`.
- The live hostname `serviceosweb-development.up.railway.app` (repeated across
  many existing docs/runbooks, not a guess at Railway's naming convention).
- No documented reason this app needs to be iframed (`docs/*.md` grepped).

**🟡 Inferred from repo code + vendor docs, not yet run against a live deploy:**
- The exact `script-src` hash value (computed from source `index.html`, not
  the built `dist/index.html` — re-verify per §4).
- The extended Pendo allowlist entries (`data.pendo.io`,
  `*.storage.googleapis.com`) — Pendo's own docs say these are needed *if*
  guides/Resource Center content is used; this research didn't confirm this
  Pendo subscription actually uses that feature.
- Whether `app.pendo.io`/`portal.pendo.io` (Visual Design Studio) are ever
  opened in-app by whoever administers Pendo guides.

**🔴 Needs a human / Railway-dashboard or live-browser check:**
- Actually building `packages/web` and diffing the built `index.html`'s inline
  script byte-for-byte against the hash in §4.
- Opening the deployed app in a real browser and checking DevTools Console for
  any CSP violation report after this ships — curl can confirm headers exist,
  it cannot confirm the allowlist is complete.
- Confirming Railway's public domain / custom domain (`app.therivetapp.com`)
  routing doesn't strip or rewrite response headers at Railway's own edge
  (nothing in Railway's docs suggests it does, but this wasn't and can't be
  verified from a docs read alone — verify via the curl commands in §7 against
  both the `*.up.railway.app` host and the custom domain).

---

## 9. Sources

**nginx (✅ primary, fetched directly):**
- `ngx_http_headers_module` (`add_header` inheritance + `always`):
  https://nginx.org/en/docs/http/ngx_http_headers_module.html

**Railway (✅ primary, fetched directly):**
- Config as code reference (full `railway.toml` key list — no headers key):
  https://docs.railway.com/reference/config-as-code
- Edge rules (Block/Allow/Challenge/Redirect/Override-cache — no headers):
  https://docs.railway.com/networking/edge-rules
- Dockerfiles guide (no header-related config):
  https://docs.railway.com/guides/dockerfiles / https://docs.railway.com/builds/dockerfiles

**helmet.js (cross-check on recommended values, already partly reflected in this repo's own `helmet-options.ts`):**
- https://github.com/helmetjs/helmet#readme

**Pendo (✅ primary, fetched directly):**
- Content Security Policy (CSP): https://support.pendo.io/hc/en-us/articles/360032209131-Content-Security-Policy-CSP

**MDN (✅ primary, fetched directly):**
- CSP `style-src` (font files load via `font-src`, not `style-src`):
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/style-src
- CSP `connect-src` (`'self'` + WebSocket scheme caveat):
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src

**CSP spec history for `'self'` + WebSocket:**
- W3C webappsec-csp issue #7: https://github.com/w3c/webappsec-csp/issues/7
- W3C webappsec issue #489: https://github.com/w3c/webappsec/issues/489
- content-security-policy.com `connect-src` explainer: https://content-security-policy.com/connect-src/

**Serviceos (this repo, read directly):**
- `packages/web/Dockerfile`, `packages/web/railway.toml`, `packages/web/start.sh`,
  `packages/web/nginx.conf.template`, `packages/web/nginx.conf`,
  `packages/web/index.html`, `packages/web/env.js.template`,
  `packages/web/render-runtime-config.sh`
- `packages/api/src/bootstrap/helmet-options.ts`
- `packages/web/src/lib/analytics.ts`, `packages/web/src/lib/errorReporter.ts`,
  `packages/web/src/lib/stripeConnect.ts`, `packages/web/src/hooks/useDeepgramDictation.ts`,
  `packages/web/src/pwa/register-sw.ts`, `packages/web/src/components/ui/chart.tsx`,
  `packages/web/src/utils/api-fetch.ts`
- `docs/deployment.md` (line 282 on the two nginx-config files),
  `qa/qa-matrix-live-runbook.md`, `docs/runbooks/dev-environment-local.md`,
  `docs/verification-runs/production-retest-2026-07-23.md` (live hostnames)
