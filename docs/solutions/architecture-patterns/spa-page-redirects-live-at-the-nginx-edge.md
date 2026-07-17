---
title: "Browser page-path redirects for the web SPA belong in the nginx edge, not just the Express catch-all"
date: 2026-07-17
track: knowledge
problem_type: architecture-patterns
module: "packages/web (nginx.conf.template, nginx.conf); packages/api/src/marketing-redirects.ts"
tags: ["nginx", "spa", "redirects", "deployment", "railway", "serving-topology", "seo", "attribution"]
related: []
---

## Context

When retiring in-app routes that were externally reachable (marketing/legal
pages `/features`, `/pricing`, `/privacy`, …), the natural instinct is to
add a server-side redirect in the Express app (`packages/api/src/app.ts`,
before the SPA catch-all). That is **not sufficient in production**, and the
gap is invisible in local dev and in unit tests.

The web app is served under **two different topologies**, and browser page
requests hit a *different* server in each:

1. **Railway production (the real one for `app.therivetapp.com`)** — the
   SPA is served by a **separate `@serviceos/web` nginx service**. Built by
   `packages/web/Dockerfile` (final stage `FROM nginx:alpine`) using
   `packages/web/nginx.conf.template`. That config only proxies `/api/` and
   `/public/` to the API; **every other path** (e.g. `/pricing`) is served
   straight from the SPA via `location / { try_files $uri $uri/ /index.html; }`.
   Browser page requests **never reach the Express app**, so a redirect in
   `app.ts` is dead code here.
2. **Single-service / docker-compose** — the root `Dockerfile` `api` stage
   runs Express (`node packages/api/dist/src/index.js`), which serves the
   SPA statics **and** the `app.get('*')` catch-all. Here a redirect in
   `app.ts` *does* run. (The compose `web` nginx stage uses
   `packages/web/nginx.conf`, the second nginx config.)

A redirect added only to Express passes every test (supertest hits Express
directly) and works in compose, then silently serves the SPA shell for the
retired path in Railway production. This was caught as a **P1 review finding**,
not by CI.

## Guidance

For any redirect/rewrite of a **browser page path** (not an `/api` or
`/public` call) on the web SPA, add it at the **nginx edge**, in *both*
configs, and keep the Express handler as the compose/single-service fallback:

- `packages/web/nginx.conf.template` — Railway `@serviceos/web` service
- `packages/web/nginx.conf` — compose/single-host `web` stage
- `packages/api/src/marketing-redirects.ts` (wired in `app.ts` before the
  catch-all) — covers the API-serves-SPA topology only

Use a **regex `location`** so it outranks the plain `location /` prefix
without disturbing `/assets`, `/api`, `/public`, or the exact-match
cache/health blocks:

```nginx
# Retired paths → standalone marketing site. This edge serves page requests
# directly, so the API redirect handler is NOT in front of them here.
location ~ ^/(features|pricing|about|download|privacy|terms)/?$ {
    return 302 https://therivetapp.com$request_uri;
}
```

**Preserve the query string in every layer** or campaign/attribution params
(`utm_*`, `gclid`) are silently dropped — and the three layers must agree:

| Layer | Preserve query with |
|-------|---------------------|
| nginx | `$request_uri` (path + query) |
| Express (`marketing-redirects.ts`) | `req.originalUrl` (not the route literal) |
| client redirect (`ProtectedRoute` → external) | `${URL}${window.location.search}` |

The fragment (`#…`) is only visible client-side; leave it off so the client
matches the server (browsers never send fragments upstream).

`302` (not `301`) when the destination is a **separate deploy** you don't
control — a `301` gets cached hard and is painful to undo. Promote to `301`
once the target pages are confirmed live.

## Why This Matters

The Express-only redirect is a **false green**: unit tests, typecheck, and
compose all pass, so nothing flags that production browser traffic bypasses
it entirely. The failure only shows as retired URLs rendering an empty SPA
shell (React route removed) on the live `@serviceos/web` domain. Getting the
serving topology right up front avoids shipping a redirect that looks done
but isn't.

## When to Apply

Any time you redirect, rewrite, block, or add headers for a **page path**
the browser requests directly from the web app: retiring routes, vanity
URLs, legacy-link forwarding, SEO canonicalization, `noindex`, auth gates
that must happen before the SPA loads. (Auth-dependent redirects like
signed-out `/` still must be client-side — the edge can't see Clerk state —
but everything topology-independent belongs at the edge.)

## Examples

**Insufficient (what didn't work):** redirect only in `app.ts` before the
catch-all. Passed CI and compose; served the SPA shell for `/pricing` in
Railway production because the `@serviceos/web` nginx service answered first.

**Correct:** the same 302 in `nginx.conf.template` + `nginx.conf` (edge,
primary) *and* `marketing-redirects.ts` (Express, compose fallback), all
query-preserving and mutually consistent.

**Verification gotcha:** `nginx -t` couldn't run in the agent sandbox
(`nginx:alpine` pull blocked, `apt install nginx` 404'd). Fallbacks that did
work: brace-balance check (`awk` count of `{` vs `}`), confirming the regex
has no `{}`/whitespace (so no quoting needed), and knowing the deploy's
`packages/web/start.sh` runs `nginx -t` under `set -eu` — so a bad config
fails the deploy at container start, not at build. Distinguish build-phase
from deploy-phase failures: the Railway status/label ("Build Failed" vs
"Deployment failed") tells you whether nginx even ran yet.
