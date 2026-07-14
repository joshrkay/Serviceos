# Clerk setup — development & production

Rivet/ServiceOS auth is **Clerk-backed end-to-end**. Most “Clerk is broken”
incidents are misconfiguration of the same five things: instance choice, API
keys, the `serviceos` JWT template, the `user.created` webhook, and allowed
origins. This runbook is the single setup checklist for both environments.

Pairs with: `.env.example`, `.env.production.example`,
`docs/launch/GO-LIVE-RUNBOOK.md` §2, `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`.

---

## How auth works in this codebase

```
Browser (ClerkProvider + VITE_CLERK_PUBLISHABLE_KEY)
  → getToken({ template: 'serviceos' })   // packages/web/src/lib/apiClient.ts
  → Authorization: Bearer <JWT>
API (CLERK_PUBLISHABLE_KEY → JWKS host)
  → verifyClerkSession RS256+JWKS         // packages/api/src/auth/clerk.ts
  → req.auth = { userId, sessionId, tenantId, role }
  → resolveAuthorization (DB role wins)   // packages/api/src/middleware/auth.ts
```

Tenant bootstrap:

```
Clerk user.created webhook
  → POST /webhooks/clerk                  // packages/api/src/webhooks/routes.ts
  → bootstrapTenant() + users row
  → PATCH Clerk public_metadata { tenant_id, role }
  → next serviceos JWT carries those claims
```

**Without the `serviceos` JWT template, every authenticated API call fails**
(`getToken({ template: 'serviceos' })` returns `null` → request aborted →
login redirect loop).

---

## 1. Create two Clerk applications

| Environment | Clerk instance | Key prefixes | Used by |
|-------------|----------------|--------------|---------|
| **Development** | Dashboard → Add application → **Development** | `pk_test_` / `sk_test_` | Local `npm run dev`, Railway `*-development`, Playwright |
| **Production** | Same app’s **Production** instance (or a separate Production app) | `pk_live_` / `sk_live_` | Railway production web + API |

Never mix prefixes: a prod API with `pk_test_` cannot verify tokens minted by
a `pk_live_` frontend (different JWKS hosts). `validateEnvSchema` refuses
test keys when `NODE_ENV=production|prod` unless `ALLOW_CLERK_TEST_KEYS=true`
(staging-only escape hatch).

---

## 2. JWT template named `serviceos` (required on BOTH instances)

Dashboard → **Configure** → **JWT templates** → **New template** → Blank.

| Field | Value |
|-------|-------|
| Name | `serviceos` (exact — the web/mobile clients hard-code this name) |
| Lifetime | Default (60s) is fine |
| Claims | See JSON below |

```json
{
  "tenant_id": "{{user.public_metadata.tenant_id}}",
  "role": "{{user.public_metadata.role}}"
}
```

Claims the API enforces (`packages/api/src/auth/clerk.ts`):

- `sub` — Clerk user id (default claim)
- `sid` — session id (optional; empty is accepted)
- `role` — **must** be one of `owner` | `dispatcher` | `technician`
- `tenant_id` — UUID string; empty → `403 Tenant context required` on
  tenant-scoped routes

Repeat this template on the **production** instance. Templates do not
cross-copy between Clerk instances.

### Verify the template

1. Sign in on the matching frontend.
2. DevTools console:

```js
const t = await window.Clerk.session.getToken({ template: 'serviceos' });
console.log(JSON.parse(atob(t.split('.')[1])));
```

Expect `tenant_id` + `role` after the webhook has written metadata. If
`getToken` returns `null`, the template name is wrong or missing.

---

## 3. Webhook (tenant bootstrap)

Dashboard → **Configure** → **Webhooks** → Add endpoint.

| Env | Endpoint URL |
|-----|----------------|
| Local (real Clerk, not bypass) | `https://<ngrok-or-tunnel>/webhooks/clerk` |
| Staging / Railway development | `https://<api-host>/webhooks/clerk` |
| Production | `https://<api-host>/webhooks/clerk` |

Subscribe at least to:

- `user.created` — bootstraps tenant + owner; writes `public_metadata`
- `user.deleted` — soft-deletes the `users` row

Copy **Signing Secret** → `CLERK_WEBHOOK_SECRET` on the API service.

After signup, confirm in Clerk → Users → user → **Public metadata**:

```json
{ "tenant_id": "<uuid>", "role": "owner" }
```

If metadata is empty, the webhook never succeeded (wrong secret, wrong URL,
or API down). Tokens will verify but every tenant route returns 403.

---

## 4. Paths & allowed origins

Dashboard → **Configure** → **Paths** / **Domains**:

| Env | Application URL / allowed origins |
|-----|-----------------------------------|
| Local | `http://localhost:5173` |
| Staging web | Railway web public URL (e.g. `https://serviceosweb-development.up.railway.app`) |
| Production | Canonical app URL (e.g. `https://app.yourdomain.com`) |

Sign-in / sign-up paths in the app are `/login` and `/signup`
(`packages/web/src/main.tsx`). Mirror those in Clerk Paths if the dashboard
asks for them.

Also set API `CORS_ORIGIN` to the **exact** web origin (no wildcard in
production).

---

## 5. Environment variables

### API service

| Variable | Dev | Prod |
|----------|-----|------|
| `CLERK_PUBLISHABLE_KEY` | `pk_test_…` | `pk_live_…` |
| `CLERK_SECRET_KEY` | `sk_test_…` | `sk_live_…` |
| `CLERK_WEBHOOK_SECRET` | webhook signing secret | webhook signing secret |
| `CORS_ORIGIN` | `http://localhost:5173` | `https://app.yourdomain.com` |
| `DEV_AUTH_BYPASS` | `true` only for hermetic local (see §6) | **must be unset / false** |
| `CLERK_DEV_HMAC_TOKENS` | `true` only for QA HMAC minting | **forbidden** (`validateEnvSchema`) |
| `ALLOW_CLERK_TEST_KEYS` | n/a | `true` only if a prod-like deploy must use `pk_test_` (staging) |

### Web service

| Variable | Notes |
|----------|-------|
| `VITE_CLERK_PUBLISHABLE_KEY` | Same publishable key as the API’s `CLERK_PUBLISHABLE_KEY` for that environment. On Railway web, also rendered into `/env.js` at container start (`packages/web/start.sh`). |
| `VITE_API_URL` | API base the browser calls |
| `VITE_AUTH_MODE=dev` | **Only** for hermetic local/CI — swaps `@clerk/clerk-react` for the local shim. Never set on a real deploy. |

Root `.env.example` and `.env.production.example` list the full set.

---

## 6. Local development — two supported modes

### Mode A — Hermetic (no Clerk cloud)

Use when Clerk’s frontend API is unreachable (sandbox / offline / `/verify`).

```bash
# API
NODE_ENV=dev
DEV_AUTH_BYPASS=true

# Web
VITE_AUTH_MODE=dev
VITE_CLERK_PUBLISHABLE_KEY=pk_test_any_placeholder   # main.tsx still requires a value
```

The Vite alias replaces `@clerk/clerk-react` with
`packages/web/src/dev/clerk-dev-shim.tsx`, which mints an unsigned JWT the
API bypass accepts. **Never enable `DEV_AUTH_BYPASS` or `VITE_AUTH_MODE=dev`
in production.**

### Mode B — Real Clerk (dev instance)

```bash
# API
NODE_ENV=dev
CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…
CLERK_WEBHOOK_SECRET=whsec_…   # via tunnel to /webhooks/clerk
CORS_ORIGIN=http://localhost:5173
# DEV_AUTH_BYPASS unset

# Web
VITE_CLERK_PUBLISHABLE_KEY=pk_test_…   # same instance as API
# VITE_AUTH_MODE unset
```

Complete §2–§4 on the **Development** instance first.

---

## 7. Production checklist (Railway)

1. Switch Clerk dashboard to the **Production** instance.
2. Create the `serviceos` JWT template (§2).
3. Add webhook `https://<prod-api>/webhooks/clerk` for `user.created` +
   `user.deleted`; set `CLERK_WEBHOOK_SECRET`.
4. Set allowed origins / Paths to the prod web URL.
5. API vars: `CLERK_SECRET_KEY=sk_live_…`, `CLERK_PUBLISHABLE_KEY=pk_live_…`,
   `CORS_ORIGIN=<prod web>`, **no** `DEV_AUTH_BYPASS` / `CLERK_DEV_HMAC_TOKENS`.
6. Web vars: `VITE_CLERK_PUBLISHABLE_KEY=pk_live_…` (rebuild or rely on
   `/env.js` runtime injection), `VITE_API_URL=<prod api>`.
7. Smoke: sign up → webhook 200 → Clerk public_metadata has `tenant_id` →
   `GET /api/me` returns that tenant → onboarding loads.

Full commercial loop: `docs/launch/GO-LIVE-RUNBOOK.md`.

---

## 8. Common failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| App white-screens / “VITE_CLERK_PUBLISHABLE_KEY is required” | Missing web env / `/env.js` | Set `VITE_CLERK_PUBLISHABLE_KEY` on the web service |
| Signed in but every API call aborts / bounce to `/login` | Missing JWT template `serviceos` | §2 — create template on **this** instance |
| Console: template `serviceos` diagnostic | Same | §2 |
| API 401 “Token missing or invalid role claim” | `public_metadata.role` empty or template claim wrong | Fix webhook + template; sign out/in to refresh JWT |
| API 403 “Tenant context required” | `tenant_id` missing in JWT | Webhook did not write metadata; check Clerk webhook logs |
| API 401 after deploy with mixed keys | `pk_test` frontend + `pk_live` API (or reverse) | Align prefixes; same Clerk instance for web + API |
| Boot: `CLERK_DEV_HMAC_TOKENS=true is forbidden` | Prod misconfig | Unset the flag |
| Boot: test keys forbidden in production | `pk_test_`/`sk_test_` under `NODE_ENV=production` | Use live keys, or set `ALLOW_CLERK_TEST_KEYS=true` on staging only |
| Local UI works, API rejects tokens | Forgot `CLERK_PUBLISHABLE_KEY` on API (JWKS host) | Set it to the same instance’s publishable key |
| Signup OK, onboarding empty until refresh | Metadata race: JWT minted before webhook wrote claims | Wait ~2s and hard-refresh, or sign out/in; confirm webhook 200 |
| E2E journeys skipped | Missing GitHub secrets | `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md` |

---

## 9. Code map (for reviewers)

| Piece | Path |
|-------|------|
| ClerkProvider + paths | `packages/web/src/main.tsx` |
| `getToken({ template: 'serviceos' })` | `packages/web/src/lib/apiClient.ts`, `AuthTokenBridge.tsx`, streams hooks |
| Dev Clerk shim | `packages/web/src/dev/clerk-dev-shim.tsx` + `vite.config.ts` (`VITE_AUTH_MODE=dev`) |
| RS256 + JWKS verify | `packages/api/src/auth/clerk.ts` |
| Dev unsigned bypass | `packages/api/src/auth/dev-auth-bypass.ts` |
| Webhook bootstrap + metadata PATCH | `packages/api/src/webhooks/routes.ts` |
| Prod env gate | `packages/api/src/shared/config.ts` (`validateEnvSchema`, `validateProductionConfig`) |
| Manual QA user bootstrap | `packages/api/scripts/bootstrap-mobile-qa-user.ts` |

---

## 10. Live instance verification (2026-07-14)

Checked against the linked Development Clerk app and Railway
`serviceosapi-development` / `serviceosweb-development`.

| Check | Development (`romantic-lark-48`) | Production instance |
|-------|----------------------------------|---------------------|
| JWT template `serviceos` | Present — claims `tenant_id` + `role` from `public_metadata` | Present — same claims |
| API keys | `pk_test_` / `sk_test_` | (use `pk_live_` / `sk_live_` on prod Railway) |
| Webhook URL | `https://serviceosapi-development.up.railway.app/webhooks/clerk` | Set to prod API host when launching |
| Webhook events | `user.created` + `user.deleted` | Mirror on prod |
| Webhook enabled | Yes (enabled in Clerk dashboard) | Confirm when wiring prod |
| Localhost origins | Dev instance allows localhost (incl. `:5173`) | N/A — set prod web origin |

### Railway webhook secret (set 2026-07-14)

| Railway API | Clerk webhook | `CLERK_WEBHOOK_SECRET` | Probe / Clerk test |
|-------------|---------------|------------------------|--------------------|
| `serviceosapi-development` | `https://serviceosapi-development.up.railway.app/webhooks/clerk` (`user.created` + `user.deleted`, enabled) | Full Svix secret (must be ≥38 chars — truncated secrets cause `Invalid signature`) | Clerk test + signed probe → **200** `{"received":true}` |
| `serviceosapi-production` | `https://serviceosapi-production.up.railway.app/webhooks/clerk` (created; **no `/api` prefix**) | Prod signing secret | Clerk test → **200** |

Dev users: all 13 Clerk users backfilled with `public_metadata.tenant_id` + `role: owner` via signed `user.created` replays after the secret was fixed (was empty before).
