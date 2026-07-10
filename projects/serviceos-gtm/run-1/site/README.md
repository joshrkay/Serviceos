# ServiceOS GTM Site

Marketing site + signup → Stripe-trial flow for the Rivet/ServiceOS GTM run.

This is a **self-contained Next.js 15 (App Router) + TypeScript + Tailwind** app.
It is intentionally **not** part of the monorepo workspaces — it has its own
`package.json` / `package-lock.json` and deploys independently to Vercel. It does
not touch `/packages`, `/rewrite`, or any product code.

Static-first: every marketing page is statically generated at build time. Only
`/api/checkout`, `/api/demo/complete`, and `/api/stripe/webhook` are dynamic.

## Getting started

```bash
cd projects/serviceos-gtm/run-1/site
npm install
cp .env.example .env.local   # optional — omit Stripe keys to run in DEMO MODE
npm run dev                  # http://localhost:3000
```

Verification commands (all pass on a clean tree):

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (35 tests)
npm run build       # next build — this exact tree deploys to Vercel
```

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | No (enables real checkout) | **TEST MODE ONLY.** Must start with `sk_test_`. A non-test key throws at call time: _"Live Stripe keys are blocked in this build (guardrail: test mode only)"_. **Unset → DEMO MODE.** |
| `STRIPE_WEBHOOK_SECRET` | For webhooks | `whsec_...`. Used to verify the `Stripe-Signature` header (HMAC-SHA256). |
| `STRIPE_PRICE_ID_SOLO` | For real checkout | Stripe Price ID for Solo ($299/mo). |
| `STRIPE_PRICE_ID_SHOP` | For real checkout | Stripe Price ID for Shop ($499/mo). |
| `STRIPE_PRICE_ID_PRO` | For real checkout | Stripe Price ID for Pro ($799/mo). |
| `NEXT_PUBLIC_APP_URL` | No | Product onboarding hand-off target on the success page. Unset → `/go-live-pending` (preview page). Inlined at build time (`NEXT_PUBLIC_*`). |
| `NEXT_PUBLIC_SITE_URL` | Recommended | Canonical/OG base URL + sitemap host (`metadataBase`). Defaults to `https://example.com`. |
| `RESEND_API_KEY` | No | Nurture engine transport. Unset → PreviewTransport (in-memory mailbox + console log). Set → ResendTransport (real send). Either way, sends are still gated to the test-contacts-only allowlist (`src/lib/nurture/allowlist.ts`) until `GO_LIVE_UNLOCK` is flipped by a human. See "Nurture engine" below. |
| `NURTURE_FROM_ADDRESS` | No | Overrides the nurture "from" identity. Defaults to `Josh at Rivet <josh@updates.rivet.example>`. |
| `VERCEL_ENV` | Set by Vercel | Only `production` is indexable; every other value → `robots.txt` disallow-all + `X-Robots-Tag: noindex`. |

## Pricing (final)

| Plan | Price | Trial |
| --- | --- | --- |
| Solo | $299/mo | 14-day free trial, card required |
| Shop (default) | $499/mo | 14-day free trial, card required |
| Pro | $799/mo | 14-day free trial, card required |

Money is stored as integer cents in `src/lib/plans.ts` (never floating point).

## Signup flow

```
/signup  (form: business, name, email, vertical, plan)
   │  POST /api/checkout
   ├── STRIPE_SECRET_KEY set  → create Stripe Checkout Session
   │        mode=subscription, trial_period_days=14, line_items=[{price, qty:1}],
   │        customer_email, metadata{business_name, vertical, plan},
   │        success_url=/signup/success?session_id={CHECKOUT_SESSION_ID},
   │        cancel_url=/signup?canceled=1
   │        → returns { url } (Stripe-hosted checkout)
   └── no key                → DEMO MODE
            → returns { url: /signup/demo-checkout?plan=…&email=… }
```

### Demo mode

When `STRIPE_SECRET_KEY` is unset the site runs a **SIMULATED CHECKOUT** at
`/signup/demo-checkout` — clearly banner-labeled, with the Stripe test card
(`4242 4242 4242 4242`) pre-filled and two buttons:

- **Complete trial signup** → `POST /api/demo/complete`, which runs the **same
  internal `onTrialStarted()` hook the real webhook runs**, then redirects to
  `/signup/success`.
- **Simulate card declined** → shows the decline state with a retry button.

This means the full lifecycle → nurture path is exercised end-to-end with no
Stripe keys configured.

## Webhook → lifecycle → nurture

`POST /api/stripe/webhook`:

1. Verifies the `Stripe-Signature` header via HMAC-SHA256 (`src/lib/stripe.ts`,
   `verifyWebhookSignature`) using `STRIPE_WEBHOOK_SECRET`, with a timestamp
   tolerance window (replay protection).
2. Is **idempotent by event id** (in-memory LRU, `src/lib/idempotency.ts`);
   duplicates are acknowledged but re-run no side effects.
3. Maps each Stripe event through the typed lifecycle bus (`src/lib/lifecycle.ts`):

   | Stripe event | Transition | Lifecycle hook |
   | --- | --- | --- |
   | `checkout.session.completed` | — | `onTrialStarted` |
   | `customer.subscription.updated` | `trialing → active` | `onTrialConverted` |
   | `customer.subscription.updated` | `* → past_due` | `onPaymentPastDue` |
   | `customer.subscription.updated` | `* → canceled` | `onCanceled` |
   | `customer.subscription.deleted` | — | `onCanceled` |
   | `invoice.payment_failed` | — | `onPaymentFailed` |

4. Every lifecycle hook (a) logs a structured event and (b) calls the nurture
   engine hook `notifyNurture(event)` (`src/lib/nurture/trigger.ts`), which now
   forwards to the real `LiveNurtureEngine` (see "Nurture engine" below).

## Nurture engine

The 8 written nurture emails (`nurture/emails/*.md` in this GTM run, transcribed
into `src/lib/nurture/sequences.ts`) are wired to the lifecycle event bus above.
`src/lib/nurture/trigger.ts` registers `liveNurtureEngine`
(`src/lib/nurture/engine.ts`) as the active engine at module load — no edit to
`lifecycle.ts` was needed; tests still override the engine via
`setNurtureEngine()` exactly as before.

**How it works:**

- **`sequences.ts`** — the 8 emails as typed data: id, trigger event, delay in
  days, subject/preview text, suppression rules, and bodyHtml/bodyText
  (rendered from a markdown source via `markdown.ts` so the two never drift).
  Merge fields (`{{first_name}}`, `{{app_url}}`, trial-summary counts, etc.)
  are a typed list (`KNOWN_MERGE_FIELDS`); unknown/missing placeholders are
  left intact rather than silently blanked.
- **`engine.ts`** — on every lifecycle event, updates an in-memory
  `ContactState` (per email) and immediately sends whatever is due right now.
  `computeDueEmails(state, now)` is a **pure function** (no I/O) that a future
  cron can call against persisted contact state to catch up delayed sends —
  this deploy is stateless/serverless, so nothing here sleeps for days; delayed
  emails (+1d, +5d, ...) are visible as a "scheduled queue"
  (`engine.getScheduledQueue()`, shown on `/nurture-preview`) but only actually
  send once real time has passed and a new event/tick calls back in. Suppression
  follows `nurture/lifecycle-mapping.md`: `trial_converted` and `canceled` halt
  the trial drip, win-back sends once ever, `payment_failed` de-dupes retries
  within 24h.
- **`transport.ts`** — `ResendTransport` (real POST to `api.resend.com/emails`
  using `RESEND_API_KEY`) and `PreviewTransport` (default when no key is set;
  writes to the in-memory mailbox + a structured console log).
  `selectTransport()` picks Resend only when the key is present.
- **`allowlist.ts` — TEST-CONTACTS-ONLY GATE.** Enforced in the send path
  (`engine.ts`), not in config or a transport: any recipient not in
  `TEST_CONTACT_ALLOWLIST` (`test+rivet@example.com`, `test+mike@example.com`,
  `test+jenna@example.com`) is blocked and logged
  `{ blocked: true, reason: 'not a test contact' }`, regardless of transport or
  whether `RESEND_API_KEY` is configured. **Go-live** is the single constant
  `GO_LIVE_UNLOCK` in `allowlist.ts`, currently `false`. Flipping it to `true`
  is a deliberate human action taken only once a real ESP key is configured and
  someone has decided this build may email real prospects — it is never
  flipped as part of routine feature work.
- **`/nurture-preview`** — internal (noindexed) reviewer page: the full
  sequence catalog with sample-data-rendered bodies, the live in-memory
  mailbox for this session (resets on cold start), the scheduled queue, and a
  "fire test event" form that POSTs to `/api/nurture/fire-test-event` to fire
  `trial_started` for a chosen test contact — the same `onTrialStarted()` hook
  demo-checkout and the real Stripe webhook use — so a reviewer can watch the
  immediate (delay 0) welcome email land in the mailbox.

## Design tokens

`src/app/tokens.css` holds **placeholder** CSS custom properties (`--color-*`,
type, radius, layout). It carries an `OVERWRITTEN by brand track` header — a later
brand worker replaces the whole file. Tailwind (`tailwind.config.ts`) only ever
references the `var()` names, never literal colors, so the brand swap needs no
config change.

## Content placeholders

Marketing copy is placeholder text marked with `{/* COPY-TODO */}` (and
`COPY-TODO` in data modules like `src/lib/articles.ts`). Content workers fill
these in. Legal pages (`/legal/privacy`, `/legal/terms`) carry a visible DRAFT
banner.

## SEO scaffold

- Per-page `metadata` (title/description placeholders) via `src/lib/metadata.ts`.
- `metadataBase` from `NEXT_PUBLIC_SITE_URL` drives absolute canonical + OG URLs.
- `app/sitemap.ts`, `app/robots.ts` (production-only indexing), `app/llms.txt/route.ts`.
- `src/components/JsonLd.tsx` renders Organization / Product / FAQPage / Article
  structured data.
