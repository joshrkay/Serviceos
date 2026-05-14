# Phase 20 — QA Runbook Remediation (2026-05-14)

> **7 stories** | Source: ServiceOS QA Runbook Results, 2026-05-14
> Build under QA: `index-r-EWlBle.js` (post auth-fix, commit `66e4d8c`) · Environment: Railway development

---

## Purpose

Close the defects surfaced by the 2026-05-14 QA runbook against Railway dev.
The run completed 17/17 sections: **2 PASS, 3 WARN, 12 FAIL**. The release
recommendation was **NOT READY**, gated on two P1 bugs (stale-HTML caching and
a missing AI provider key) plus a cluster of P2 auth-UX defects.

This phase converts the 7 prioritized bugs (BUG-1 … BUG-7) into dispatchable
stories. Five are code stories runnable by autonomous agents in a single
parallel wave; two (P20-002, P20-007) are operational / verification stories
with manual steps — they are **not** dispatched via `/dispatch-story`.

All Phase 20 code stories are **contract-neutral**: they touch deploy config,
build config, error-path messaging, and UX state only. None modify
`packages/shared/**`, repository interfaces, enums, or request/response
schemas — so no Tier 3 freeze (see `freeze-list.md`) is required before the
wave.

## Exit Criteria

Returning browsers load the freshly deployed bundle (no stale HTML); the AI
assistant returns real responses, with accurate error messaging on failure;
a post-401 redirect preserves the originally requested route; authenticated
data panels show an actionable error instead of an infinite spinner; the web
bundle is code-split. A clean-profile re-run of the QA runbook (P20-007)
flips §3–§13 from FAIL to PASS.

## Gap Summary

| ID | QA Bug | Title | Priority | Size | Layer | Dispatch | Dependencies |
|----|--------|-------|----------|------|-------|----------|--------------|
| P20-001 | BUG-1 | Cache-Control on `index.html` | P1 | S | Deploy/web | Wave 1 agent | None |
| P20-002 | BUG-2 | `AI_PROVIDER_API_KEY` missing in Railway | P1 | S | Ops/config | Manual (ops) | None |
| P20-003 | BUG-3 | Preserve destination path through login redirect | P2 | S | Web/auth | Wave 1 agent | None |
| P20-004 | BUG-4 | Error states for authenticated data panels | P2 | M | Web/UX | Wave 1 agent | None |
| P20-005 | BUG-5 | Accurate AI failure messaging + server logging | P2 | M | Web+API/AI | Wave 1 agent | None |
| P20-006 | BUG-6 | Code-split the web bundle | P3 | S | Web/build | Wave 1 agent | None |
| P20-007 | BUG-7 | Re-run QA runbook in a clean browser profile | P3 | S | QA/verify | Manual (verify) | P20-001, P20-003, P20-004 |

---

## Story Specifications

### P20-001 — Cache-Control on index.html

> **Size:** S | **Layer:** Deploy/web | **Priority:** P1 | **AI Build:** High | **Human Review:** Moderate | **Dispatch:** Wave 1 agent

**QA bug:** BUG-1 (affects §1.5, §2.3, §16.3) — release blocker.

**Dependencies:** None.

**Allowed files:**
- `packages/web/nginx.conf.template` — add the cache-control rule (this is the file the deployed `@serviceos/web` service renders at boot).
- `packages/web/nginx.conf` — legacy root-Dockerfile copy; keep it in sync so the two configs do not diverge.

**Problem:** The deployed `index.html` is served by nginx with only an `ETag`
and **no `Cache-Control` header**. Returning browsers serve stale HTML from
disk cache, which references an old, content-hashed JS bundle — so redeployed
fixes (including the auth fix in commit `66e4d8c`) never reach returning
visitors. QA could only verify the new bundle via `curl` + bundle inspection,
not in a live browser.

**Evidence from code:**
- `packages/web` is served by `nginx:alpine`. The active Railway `@serviceos/web`
  service builds from `packages/web/Dockerfile`, which renders
  `packages/web/nginx.conf.template` at container boot (via `envsubst` in
  `packages/web/start.sh`).
- `nginx.conf.template` currently sets only `add_header Content-Type text/plain;`
  on `/health`. There is **no** `Cache-Control` / `Expires` directive anywhere —
  static files (including `index.html`) fall through to nginx defaults (ETag only).
- The repo-root `railway.toml` configures only the **api** service; the web
  service config lives at `packages/web/railway.toml` → `packages/web/Dockerfile`.

**Build prompt:** In `packages/web/nginx.conf.template`, add an **exact-match**
location block for `/index.html` that sets `Cache-Control: no-cache` (e.g.
`add_header Cache-Control "no-cache" always;`). `no-cache` means "the browser
may store it but must revalidate via ETag before use" — that is exactly the
desired behavior. Do **not** use `no-store` (it disables back/forward cache).
Do **not** weaken caching for content-hashed assets under `/assets/` — if you
add an `/assets/` block at all, it must be
`Cache-Control: public, max-age=31536000, immutable`. Apply the identical
`/index.html` rule to `packages/web/nginx.conf` so the legacy copy does not
drift. The SPA `try_files … /index.html` fallback must keep working.

**Review prompt:** Confirm `location = /index.html` is an exact match so it
cannot catch other routes. Confirm `no-cache` (not `no-store`). Confirm hashed
assets are not made uncacheable. Confirm `try_files … /index.html` still
resolves deep links. Remember nginx `add_header` does **not** inherit into a
block that defines its own `add_header` — verify no needed headers were dropped
inside the new block.

**Acceptance criteria:**
- [ ] `packages/web/nginx.conf.template` serves `index.html` with `Cache-Control: no-cache`.
- [ ] `packages/web/nginx.conf` carries the identical rule.
- [ ] Content-hashed assets under `/assets/` remain long-lived (not made `no-cache`).
- [ ] The SPA deep-link fallback (`try_files`) still works.
- [ ] Final runtime confirmation (`curl -sI https://<web-domain>/index.html` shows the header) is **deferred to P20-007** post-deploy — it cannot be verified pre-deploy.

**Out of scope:** Dockerfile / `railway.toml` / `start.sh` changes; any
`packages/web/src/**` change; Vite config (that is P20-006).

**Automated checks:**
```bash
grep -qE 'location *= */index\.html' packages/web/nginx.conf.template
grep -A6 -E 'location *= */index\.html' packages/web/nginx.conf.template | grep -qi 'cache-control'
```

---

### P20-002 — AI_PROVIDER_API_KEY missing in Railway

> **Size:** S | **Layer:** Ops/config | **Priority:** P1 | **AI Build:** N/A | **Human Review:** N/A | **Dispatch:** Manual (ops) — do NOT run `/dispatch-story`

**QA bug:** BUG-2 (affects §4.2, §4.3, §4.4, §17.4) — release blocker.

**Dependencies:** None.

**Allowed files:** None for the primary fix (Railway dashboard change). One
optional, non-blocking code follow-up — see step 4.

**Problem:** The AI assistant cannot produce real responses because
`AI_PROVIDER_API_KEY` is not set in the Railway `@serviceos/api` service.

**Evidence from code:**
- The LLM gateway reads `AI_PROVIDER_API_KEY` at
  `packages/api/src/ai/gateway/factory.ts:44` (throws `'AI_PROVIDER_API_KEY is
  not set…'` if unset). Companion vars: `AI_PROVIDER_BASE_URL` (default
  `https://api.openai.com/v1`), `AI_DEFAULT_MODEL` (default `gpt-4o-mini`).
- `validateProductionConfig` (`packages/api/src/shared/config.ts:96`) already
  lists `AI_PROVIDER_API_KEY` as a required production var.
- `app.ts:782` substitutes a `MockLLMProvider` when the key is unset — which is
  why the service boots "degraded" rather than failing loudly. (Making that
  failure path *honest* is P20-005's job; this story is purely "set the key".)
- The var is documented (commented) in `packages/api/.env.example` but is
  **missing from the repo-root `.env.example`**.

**Manual steps:**
1. Railway → `@serviceos/api` service → **Variables** → add `AI_PROVIDER_API_KEY`.
   Confirm the exact provider key with the backend team. If not using OpenAI,
   also set `AI_PROVIDER_BASE_URL` and `AI_DEFAULT_MODEL`.
2. Restart the `@serviceos/api` service.
3. Confirm `POST /api/assistant/chat` returns a real (non-degraded) response —
   the body should **not** carry `degraded: true`.
4. *(Optional, non-blocking code follow-up — not an agent story.)* Add
   `AI_PROVIDER_API_KEY` (commented, with `AI_PROVIDER_BASE_URL` and
   `AI_DEFAULT_MODEL`) to the repo-root `.env.example` so it matches
   `packages/api/.env.example`. This can ride along in any small PR or be done
   by hand.

**Manual verification:**
```bash
curl -sS -X POST https://<api-domain>/api/assistant/chat \
  -H 'Authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"message":"hello"}'
# Expect a real assistant reply, NOT the canned degraded envelope.
```

**Out of scope:** Changing the gateway, `app.ts` wiring, or the mock-fallback
behavior. Making the *failure messaging* accurate is P20-005.

---

### P20-003 — Preserve destination path through login redirect

> **Size:** S | **Layer:** Web/auth | **Priority:** P2 | **AI Build:** High | **Human Review:** Light | **Dispatch:** Wave 1 agent

**QA bug:** BUG-3 (affects §2.5).

**Dependencies:** None.

**Allowed files:**
- `packages/web/src/lib/apiClient.ts` — fix `redirectToLogin()`.
- `packages/web/src/lib/apiClient.test.ts` — **new** file; dedicated unit test for `redirectToLogin()`.
- `packages/web/src/hooks/useListQuery.test.ts` — **only if** the existing `persistent 401` test breaks; update it minimally to match new behavior.

**Problem:** After an API 401 that cannot be recovered, the app redirects to
`/login?redirect=…` but uses **only `window.location.pathname`** — it drops
`window.location.search`. A user deep-linked to e.g. `/jobs?status=open` lands
back at `/jobs` (or, when the 401 fires on `/`, at `/login?redirect=%2F`),
losing their original destination.

**Evidence from code:**
- `packages/web/src/lib/apiClient.ts` — `redirectToLogin()` (≈ lines 68–73)
  builds `'/login?redirect=' + encodeURIComponent(window.location.pathname)`.
- It is invoked from the 401 handler (≈ lines 131–146): on 401 the client
  retries once with a fresh token; if the retry is still 401 it calls
  `redirectToLogin()`.

**Build prompt:** In `redirectToLogin()`, build the redirect target from
`window.location.pathname + window.location.search` (do **not** include
`window.location.hash`). Guard against redirect loops: if the current
`pathname` already begins with `/login`, fall back to `'/'` as the redirect
target instead of producing `redirect=%2Flogin…`. Keep the existing
`encodeURIComponent` encoding. Add `packages/web/src/lib/apiClient.test.ts`
with cases named to include `P20-003`: (a) path + query string is preserved
and correctly encoded, (b) bare `/` still works, (c) being on `/login` falls
back to `/`. If your change breaks the existing `persistent 401` test in
`useListQuery.test.ts`, update that test minimally — do not expand its scope.

**Review prompt:** Confirm `search` is included and `hash` is not. Confirm the
loop guard. Confirm encoding is applied to the combined string correctly (the
whole `pathname+search` is one redirect value). Confirm no behavior change to
the 401 retry logic itself — only the URL construction changes.

**Acceptance criteria:**
- [ ] `redirectToLogin()` preserves `pathname + search` in the `redirect` param.
- [ ] Being on a `/login*` path redirects with `redirect=%2F` (no loop).
- [ ] `hash` is not included.
- [ ] `packages/web/src/lib/apiClient.test.ts` exists and passes; test names contain `P20-003`.
- [ ] The 401 retry logic is otherwise unchanged.

**Out of scope:** The `LoginPage` component reading the `redirect` param (it
already does); error-state handling for data panels (that is P20-004);
`utils/api-fetch.ts`.

**Automated checks:**
```bash
( cd packages/web && npx --no-install tsc --noEmit )
npm test --workspace=packages/web -- src/lib/apiClient.test.ts
```

---

### P20-004 — Error states for authenticated data panels

> **Size:** M | **Layer:** Web/UX | **Priority:** P2 | **AI Build:** High | **Human Review:** Moderate | **Dispatch:** Wave 1 agent

**QA bug:** BUG-4 (affects §3.4, §7.1, §15.1).

**Dependencies:** None.

**Allowed files:**
- `packages/web/src/components/home/HomePage.tsx` — consume the `error` field its queries already expose.
- `packages/web/src/components/home/HomePage.test.tsx` — new or extended tests.
- `packages/web/src/components/schedule/SchedulePage.tsx` — add an error state to its bespoke fetch path.
- `packages/web/src/components/schedule/SchedulePage.test.tsx` — new or extended tests.

**Problem:** When an authenticated data fetch returns 401 (or otherwise fails),
the Schedule view and dashboard widgets show a **permanent spinner or a
misleading empty state** — no error message, no recovery affordance.

**Evidence from code:**
- The shared hooks (`useListQuery.ts`, `useDetailQuery.ts`, `useMutation.ts`)
  **already populate an `error` field correctly** on failure. The shared
  `ListPage.tsx` / `DetailPage.tsx` shells already render an error state. The
  bug is in two consumers that do **not**:
- `packages/web/src/components/home/HomePage.tsx` calls `useListQuery` three
  times and renders spinners off `isLoading`, but **never reads `error`** — on
  failure `isLoading` flips false, `error` is set and ignored, and the user
  sees misleading "empty" widgets.
- `packages/web/src/components/schedule/SchedulePage.tsx` does **not** use the
  shared hooks — it uses a bespoke `apiFetch` from `utils/api-fetch.ts` with a
  local `loading` flag, and on a non-OK response does
  `if (!res.ok) { setLoading(false); return; }` — swallowing the failure with
  no error state at all, leaving a stuck spinner.

**Build prompt:** Make both panels surface a clear, actionable error instead of
a forever-spinner / misleading empty state.
- `HomePage.tsx`: read the `error` field already returned by each
  `useListQuery` call and render an error affordance when set. Prefer reusing
  the codebase's existing error-display component (e.g. `ErrorState`, used by
  `ListPage.tsx`) — you may **import** it but must **not** modify it. For an
  auth failure (HTTP 401) the message should read **"Session expired — please
  reload"**; for other failures a generic "Couldn't load … — please try again".
- `SchedulePage.tsx`: add an `error` state; set it when the bespoke fetch hits
  a non-OK response or throws; render the same "Session expired — please
  reload" message (with a reload affordance) instead of leaving the spinner up.
- Add/extend the two `.test.tsx` files with cases named to include `P20-004`
  covering: a 401 renders the session-expired message (no infinite spinner),
  and the happy path still renders data.

**Review prompt:** Confirm both panels exit their loading state AND show an
error on 401. Confirm the 401-specific copy is "Session expired — please
reload". Confirm no shared hook or shared component (`useListQuery.ts`,
`ListPage.tsx`, `ErrorState`, etc.) was modified — only the two consumer
components. Confirm the happy path is untouched.

**Acceptance criteria:**
- [ ] `HomePage.tsx` renders an error affordance when any of its queries' `error` is set.
- [ ] `SchedulePage.tsx` tracks and renders an error state; the spinner is not left up on failure.
- [ ] A 401 shows "Session expired — please reload" in both panels.
- [ ] No shared hook or shared component was modified.
- [ ] Tests in both `.test.tsx` files pass; names contain `P20-004`.

**Out of scope:** `lib/apiClient.ts` and the 401 redirect (P20-003);
`utils/api-fetch.ts` itself; the shared hooks; `DispatchBoard` / `ListPage` /
`DetailPage` (they already handle errors); the global `ErrorBoundary`.

**Automated checks:**
```bash
( cd packages/web && npx --no-install tsc --noEmit )
npm test --workspace=packages/web -- src/components/home/HomePage.test.tsx src/components/schedule/SchedulePage.test.tsx
```

---

### P20-005 — Accurate AI failure messaging + server logging

> **Size:** M | **Layer:** Web + API / AI | **Priority:** P2 | **AI Build:** High | **Human Review:** Moderate | **Dispatch:** Wave 1 agent

**QA bug:** BUG-5 (affects §4.3, §4.5, §15.3).

**Dependencies:** None. (Functionally complemented by P20-002, which sets the
key so the happy path works — but this story stands alone: it makes the
*failure* path honest and observable.)

**Allowed files:**
- `packages/web/src/components/assistant/AssistantPage.tsx` — replace the misleading fallback string.
- `packages/web/src/components/assistant/AssistantPage.test.tsx` — new or extended tests.
- `packages/api/src/routes/assistant.ts` — log the real error; correct the user-facing degraded copy.
- `packages/api/test/routes/assistant.route.test.ts` — new or extended tests.

**Problem:** When an AI call fails, the user is told **"I received your
message… The AI backend is not connected yet"** — which implies an
architectural gap rather than the real cause (an auth/config failure, e.g. the
missing key from BUG-2). The real error is also **swallowed server-side with
no logging**, so operators have nothing to debug with.

**Evidence from code:**
- Frontend: `packages/web/src/components/assistant/AssistantPage.tsx:95` — the
  `catch` block in `sendToConversationAPI` sets the literal
  `"…The AI backend is not connected yet — connect it via AI_PROVIDER_API_KEY…"`.
  It fires on a thrown error or non-2xx response.
- Backend: `packages/api/src/routes/assistant.ts` `catch` blocks (≈ lines 201
  and 237–250) return **HTTP 200** with `degraded: true` and a canned `content`
  string, and currently log **nothing**.
- Logging pattern: `createLogger({ service, environment })` from
  `packages/api/src/logging/logger.ts` — see `routes/telephony.ts:31-38` for the
  module-level `const logger = createLogger(...)` convention.

**Build prompt:**
- Frontend: replace the `AssistantPage.tsx:95` message with an accurate one —
  **"Unable to connect to AI service — please try again or contact support."**
  Do not reference env var names in user-facing copy.
- Backend: in the `assistant.ts` `catch` blocks, add server-side logging of the
  real error using the module-level `createLogger` convention
  (`logger.error('assistant/chat: …', { error })`). Also make the user-facing
  `content` returned in the degraded envelope accurate — it must not claim the
  backend is unbuilt. **Do not change** the response shape, status codes, or
  field names (`degraded`, `fallbackStage`, etc.) — error-path *messaging and
  logging* only, so the change stays contract-neutral.
- Add/extend tests named to include `P20-005`: frontend renders the new copy on
  a failed call; backend logs on the degraded path and the returned `content`
  no longer claims "not connected".

**Review prompt:** Confirm the request/response contract is unchanged (status
codes, JSON shape, field names). Confirm the logger is the shared
`createLogger`, not `console.*`, and that no secrets/tokens are logged. Confirm
the new user-facing copy is accurate and support-oriented. Confirm nothing in
`packages/api/src/ai/gateway/**`, `app.ts`, `config.ts`, or the provider files
was touched.

**Acceptance criteria:**
- [ ] `AssistantPage.tsx` shows "Unable to connect to AI service — please try again or contact support." on failure.
- [ ] The string "not connected yet" no longer appears in `AssistantPage.tsx`.
- [ ] `assistant.ts` `catch` blocks log the real error via `createLogger`.
- [ ] The degraded-envelope `content` no longer implies the AI backend is unbuilt.
- [ ] Response status codes, JSON shape, and field names are unchanged.
- [ ] Tests pass in both test files; names contain `P20-005`.

**Out of scope:** The LLM gateway, `app.ts` wiring, the mock-fallback behavior,
config validation; setting the actual key (that is P20-002).

**Automated checks:**
```bash
( cd packages/api && npx --no-install tsc --project tsconfig.build.json --noEmit )
( cd packages/web && npx --no-install tsc --noEmit )
npm test --workspace=packages/api -- test/routes/assistant.route.test.ts
npm test --workspace=packages/web -- src/components/assistant/AssistantPage.test.tsx
```

---

### P20-006 — Code-split the web bundle

> **Size:** S | **Layer:** Web/build | **Priority:** P3 | **AI Build:** High | **Human Review:** Light | **Dispatch:** Wave 1 agent

**QA bug:** BUG-6 (affects §16.2).

**Dependencies:** None.

**Allowed files:**
- `packages/web/vite.config.ts` — add a `build.rollupOptions.output.manualChunks` configuration.

**Problem:** The web app ships a single ~1.56 MB main JS bundle (1,558,923
bytes). It is not code-split, which inflates Time-to-Interactive, especially on
mobile.

**Evidence from code:**
- `packages/web/vite.config.ts` currently defines only `plugins` and
  `server.proxy` — there is **no `build` block, no `rollupOptions`, no
  `manualChunks`**.
- Heavy dependencies in `packages/web/package.json` that are natural vendor
  chunks: `react` / `react-dom` / `react-router`, `@clerk/clerk-react`,
  `@stripe/react-stripe-js` + `@stripe/stripe-js`, `recharts`, and the ~25
  `@radix-ui/*` packages.

**Build prompt:** Add a `build.rollupOptions.output.manualChunks` config to
`packages/web/vite.config.ts` that splits vendor libraries out of the app
entry chunk. Suggested groups: `react-vendor` (`react`, `react-dom`,
`react-router`), `clerk` (`@clerk/*`), `stripe` (`@stripe/*`), `charts`
(`recharts`), `radix` (`@radix-ui/*`). Target a main/entry chunk **well under
300 KB**. Do **not** add or change dependencies, and do **not** touch
`package.json`. Do not commit build output (`packages/web/dist/`).

**Review prompt:** Confirm `manualChunks` is present and the build succeeds.
Confirm no new dependency was introduced. Confirm the function/object form of
`manualChunks` correctly routes `node_modules` paths to chunks and does not
accidentally bundle app code into a vendor chunk. Confirm chunk count increased
and the largest chunk shrank materially versus the ~1.56 MB baseline.

**Acceptance criteria:**
- [ ] `packages/web/vite.config.ts` defines `build.rollupOptions.output.manualChunks`.
- [ ] `npm run build --workspace=packages/web` succeeds.
- [ ] The build emits multiple vendor chunks (react, clerk, stripe, charts, radix).
- [ ] The largest single JS chunk is materially smaller than the ~1.56 MB baseline (entry chunk target < 300 KB).
- [ ] No dependency or `package.json` change.

**Out of scope:** `package.json`; lazy-`import()` route splitting (a larger,
separate effort); nginx asset caching (that is P20-001); any `src/**` change.

**Automated checks:**
```bash
npm run build --workspace=packages/web
ls -la packages/web/dist/assets/*.js
```

---

### P20-007 — Re-run QA runbook in a clean browser profile

> **Size:** S | **Layer:** QA/verify | **Priority:** P3 | **AI Build:** N/A | **Human Review:** N/A | **Dispatch:** Manual (verify) — do NOT run `/dispatch-story`

**QA bug:** BUG-7 (affects §2.3).

**Dependencies:** P20-001 (merged + deployed), and ideally P20-003, P20-004,
P20-005, P20-002 deployed.

**Allowed files:** None — verification only. Results land in `qa/reports/<date>/`.

**Problem:** The 2026-05-14 run could not confirm the auth fix (commit
`66e4d8c`) end-to-end in a live browser, because stale HTML (BUG-1) kept
serving the old JS bundle. Sections §3–§13 are all FAIL pending a clean re-run.

**Manual steps:**
1. Confirm P20-001 is merged and deployed:
   `curl -sI https://<web-domain>/index.html` shows `Cache-Control: no-cache`.
2. Confirm P20-002 (key set), and — if merged — P20-003 / P20-004 / P20-005.
3. In a clean browser profile (or a hard reload with disk cache disabled),
   re-run QA runbook §2 (Authentication) and §3–§13 (Navigation + feature
   modules + DB persistence).
4. Record the run in `qa/reports/<date>/` per the QA harness convention.

**Manual verification:** §3–§13 flip FAIL → PASS; §2.3 confirms the `serviceos`
JWT-template fix loads in a live browser (not just via `curl` + bundle
inspection).

**Out of scope:** Any code change. If the clean re-run surfaces *new* defects,
file them as their own stories — do not fold fixes into this verification story.

---

## Universal pre-flight & dispatch notes

- Dispatch metadata (wave plan, forbidden files, verification gates, pre-flight
  dependencies) lives in `docs/superpowers/contracts/p20-dispatch-addendum.md`.
- Only P20-001, P20-003, P20-004, P20-005, P20-006 are dispatched via
  `/dispatch-story` — they form a single parallel wave (Wave 1).
- P20-002 and P20-007 are manual ops/verification stories; do not dispatch them
  to an autonomous agent.
- Agents run in isolated git worktrees and may not have `node_modules` — see the
  dispatch addendum's note on running `npm install` in the worktree if a
  verification command reports missing modules.
