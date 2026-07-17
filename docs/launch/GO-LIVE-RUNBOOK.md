# Rivet (ServiceOS) — Go-Live Runbook (Blocker #1: prod env + webhooks)

_Step-by-step procedure to flip the core product on. Every path/var/event below
is verified against the code (file:line). Pairs with `.env.production.example`
and `docs/prod-env-checklist.md`. Deploy target: Railway (`railway.toml`)._

> The core paying-customer loop (signup → 14-day trial → paid) is fully wired
> and verified (see `docs/LAUNCH-READINESS-v4.md`). It is **config-gated**, not
> code-gated — this runbook is the config.

---

## 0. Prerequisites (external accounts)

- **Stripe** account (live mode) — SaaS subscription billing.
- **Clerk** application (production instance) — auth + tenant bootstrap.
- **AI provider** key (OpenAI-compatible; or Anthropic via `AI_PROVIDER_BASE_URL`).
- **Railway** project with an API service, a web service, and a linked Postgres.
- Feature providers as needed: **Twilio** (inbound voice/SMS), **SendGrid**
  (email), **Cloudflare R2** (storage). Each can be disabled with its
  `*_ENABLED=false` flag if not launching that surface.

---

## 1. Stripe setup (the trial → paid engine)

1. **Create the subscription product + price.** Stripe → Products → add your
   plan → copy the **Price ID** (`price_…`) → `STRIPE_PRICE_ID`.
   _Required by `createTrialCheckoutSession` (`billing/subscription.ts:147`); the
   14-day trial + `payment_method_collection=always` are set there
   (`subscription.ts:240`)._
2. **Create the webhook endpoint.** Stripe → Developers → Webhooks → Add
   endpoint:
   - URL: `https://<api-host>/webhooks/stripe`  _(mounted `app.ts:908`; handler
     `webhooks/routes.ts:758`; raw-body parser mounted before JSON at
     `app.ts:640`)._
   - Events to enable (handled in `webhooks/routes.ts`):
     - `customer.subscription.created`, `customer.subscription.updated`,
       `customer.subscription.deleted` _(:1399 — mirrors `subscription_status`
       + `trial_ends_at`; emits `trial_to_paid` on trialing→active :1581 and
       `subscription_canceled` on delete)._
     - `checkout.session.completed`, `checkout.session.expired` _(:916/:902 —
       invoice payment + pending-checkout cleanup)._
     - `charge.refunded` and `payment_intent.succeeded` / `…payment_failed` /
       `…canceled` _(invoice payment + ACH settlement lifecycle)._
   - Copy the **Signing secret** (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.
3. **Secret key.** Stripe → Developers → API keys → **Secret key**
   (`sk_live_…`) → `STRIPE_SECRET_KEY`. _Gates `billingService`/Connect/payment
   links (`app.ts:831`); the payment-link provider throws at boot in prod if
   unset (`app.ts:966`)._
4. **(Optional) Customer portal.** Stripe → Billing → Customer portal →
   configure → copy the configuration id → `STRIPE_BILLING_PORTAL_CONFIGURATION`
   (Stripe default used if unset; portal minted in `subscription.ts:109`).
5. **Publishable key** for the customer invoice-payment page (`pk_live_…`) →
   web build var `VITE_STRIPE_PUBLISHABLE_KEY`.

> ⚠️ **Trial state is written ONLY by `customer.subscription.created`**
> (`webhooks/routes.ts:1490`). If the Stripe webhook isn't wired, a user can
> finish checkout but stays gated as `no_billing` (`voice/trial-limits.ts:42`,
> `voice/voice-gate.ts:39`). The success-page "trial started" toast can briefly
> precede the webhook — expected; tell support.

---

## 2. Clerk setup (auth + tenant bootstrap)

> Full checklist (dev + prod, JWT template, failure modes):
> [`docs/runbooks/clerk-setup.md`](../runbooks/clerk-setup.md).

1. **Use the Production Clerk instance** (keys must be `pk_live_` / `sk_live_`).
   Mixing test keys with a live frontend (or the reverse) breaks JWKS
   verification — different hosts.
2. **API keys.** Clerk → API Keys → `CLERK_SECRET_KEY` (backend),
   `CLERK_PUBLISHABLE_KEY` (also as web build/runtime var
   `VITE_CLERK_PUBLISHABLE_KEY`). Same instance for API + web.
3. **JWT template `serviceos` (required).** Clerk → JWT templates → New →
   name **exactly** `serviceos`. Claims:

   ```json
   {
     "tenant_id": "{{user.public_metadata.tenant_id}}",
     "role": "{{user.public_metadata.role}}"
   }
   ```

   The web/mobile clients call `getToken({ template: 'serviceos' })`. Without
   this template every authenticated request aborts and the app bounce-loops
   to `/login`. `role` must be `owner` | `dispatcher` | `technician`.
4. **Webhook endpoint.** Clerk → Webhooks → Add endpoint:
   - URL: `https://<api-host>/webhooks/clerk` _(handler `webhooks/routes.ts`)._
   - Subscribe to **`user.created`** _(→ `bootstrapTenant`; creates the tenant
     + owner row; PATCHes Clerk `public_metadata` with `{ tenant_id, role }`
     so the JWT template can mint claims)_ and **`user.deleted`**.
   - Copy the **Signing Secret** → `CLERK_WEBHOOK_SECRET` _(missing → the Clerk
     webhook 500s)._
5. **Paths / allowed origins.** Allow the production web origin; sign-in path
   `/login`, sign-up `/signup` (see `packages/web/src/main.tsx`).
6. **Google SSO** (optional, per PRD US-001): enable Google as a social
   connection in Clerk → Configure → SSO.
7. **Refuse local bypass flags in prod.** Do not set `DEV_AUTH_BYPASS` or
   `CLERK_DEV_HMAC_TOKENS=true` on the production API
   (`validateEnvSchema` hard-fails the HMAC flag; test-key prefixes also fail
   unless `ALLOW_CLERK_TEST_KEYS=true` for a staging-shaped deploy).

---

## 3. AI provider

Set `AI_PROVIDER_API_KEY` (and `AI_PROVIDER_BASE_URL` if pointing at Anthropic /
a gateway). Without it, the whole AI pipeline is an inert mock — voice/assistant
features return `unknown` (by design, `app.ts` master gate).

---

## 4. Railway — API service variables

Set every **Tier 0** var (`NODE_ENV=production`, `DATABASE_URL` (auto when
Postgres linked), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
`CLERK_WEBHOOK_SECRET`, `AI_PROVIDER_API_KEY`, `CORS_ORIGIN`,
`STRIPE_SECRET_KEY`) and **Tier 1** (`STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`,
`WEB_URL`) from `.env.production.example`. Add Tier 2 feature creds unless you
set the matching `*_ENABLED=false`. Add Tier 3 (`METRICS_TOKEN`, `SENTRY_DSN`,
transcript encryption) for a secure launch.

> Boot enforcement: `validateProductionConfig` (`shared/config.ts:84`) hard-fails
> the process if any of `DATABASE_URL`(or DB_*), `CLERK_SECRET_KEY`,
> `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SECRET`, `AI_PROVIDER_API_KEY`,
> `CORS_ORIGIN` is missing.

---

## 5. Railway — Web service build variables

`VITE_API_URL` (the API host), `VITE_CLERK_PUBLISHABLE_KEY`,
`VITE_STRIPE_PUBLISHABLE_KEY`, and **`VITE_ONBOARDING_V2_ENABLED=true`** (hosts
the billing step). `VITE_*` are inlined at build time — a rebuild/redeploy is
required after changing them.

---

## 6. Deploy + migrations

Railway runs migrations as a pre-deploy step and then starts the server
(`railway.toml`):

```
preDeployCommand = "node packages/api/dist/src/db/migrate.js"
startCommand     = "node packages/api/dist/src/index.js"
healthcheckPath  = "/health"
```

Confirm the migration step succeeds in the deploy logs before traffic shifts.

---

## 7. Verify boot + webhooks

0. **Pre-flight (optional, local):** with the prod vars exported, run
   `cd packages/api && npm run validate-env` — validates the env *schema/format*
   (`validateEnvSchema`, `shared/config.ts:288`). Full prod-required enforcement
   (`validateProductionConfig`) runs at boot, so the real signal is a clean
   start in step 1.
1. `GET https://<api-host>/health` → **200** (liveness; always 200 when up —
   `health/health.ts:16`, mounted at root `app.ts:742`).
2. `GET https://<api-host>/ready` → **200** when the DB is reachable (503 on DB
   outage — `health/health.ts:48`).
3. Boot logs: no `createWebhookRouter` error → durable `PgWebhookRepository` is
   wired (`app.ts:860`; it throws in prod without a pool).
4. Stripe → send a **test webhook** (or "Send test event") → expect **200**
   (not 500 — a 500 means `STRIPE_WEBHOOK_SECRET` is wrong/missing).
5. Clerk → send a test `user.created` → expect **200** and a new tenant row.

---

## 8. End-to-end smoke test — signup → trial → paid

Run against the live web URL with Stripe **test mode** first (swap to live keys
after it passes), using card `4242 4242 4242 4242`, any future expiry/CVC:

1. Open the web app → **Sign up** (email/password or Google) → lands on
   `/onboarding` (`auth/SignupPage.tsx:29`).
2. Clerk `user.created` fires → tenant bootstrapped (check the DB / Clerk webhook
   log = 200).
3. Complete onboarding to the **Billing** step → "Start trial" → redirected to
   Stripe Checkout → enter the test card → return to the app.
4. Stripe `customer.subscription.created` fires →
   `tenants.subscription_status = 'trialing'`, `trial_ends_at` set
   (`routes.ts:1490`). Onboarding completes (billing is a required step,
   `derive-status.ts:72`); voice gate opens.
5. **Trial → paid:** in Stripe (test clock or by ending the trial) advance past
   the trial, or hit the in-app upgrade nudge (`POST /api/billing/end-trial-now`).
   On `trialing → active`, `trial_to_paid` is emitted (`routes.ts:1581`) and
   `subscription_status = 'active'`.
6. **Manage:** Settings → Billing → "Manage subscription" opens the Stripe
   customer portal (`SettingsPage.tsx`, `routes/billing.ts:73`).
7. **Past-due:** simulate a failed renewal → `PastDueBanner` shows
   (`subscription_status = 'past_due'`).

A green run through steps 1–6 = the commercial loop works end-to-end with no
manual intervention.

---

## 9. Gotchas / rollback

- **Wrong `WEB_URL`** → Stripe success/cancel redirects break (defaults to
  `localhost:5173`).
- **Stripe webhook not wired** → checkout succeeds but tenant stays `no_billing`.
  Re-check the endpoint URL + `customer.subscription.*` events.
- **`/ready` 503 after deploy** → DB unreachable; check `DATABASE_URL` / the
  Postgres plugin. `/health` stays 200 so Railway won't roll back a DB-cold
  deploy (intentional).
- **`no_double_booking` constraint** — confirm it installed (not skipped by the
  pre-existing-overlap guard, `schema.ts:3382`) on the production DB.
- **Rollback:** Railway → redeploy the prior image. Migrations are
  forward-only; coordinate any schema rollback manually.
