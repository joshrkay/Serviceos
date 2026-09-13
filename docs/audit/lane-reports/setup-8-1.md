# §8.1 Setup — Sonnet test-only lane report (branch `cloud/setup-8-1`)

## Update — Fable gate PASS + the T2 leg (2026-09-13)

Fable gated PR #1115 @ `6bf51e3d6`: **PASS**, row 1.8 stays 4 (T1), reached
hermetically end to end; rung 5 asked for one more assertion — a T2 leg
("a neighbour's AI-check state must not change this tenant's answer") in
the same spec. Added: `driveTenantToAiCheckViaApi()` drives the neighbour
through its OWN identity → pack (**plumbing**, deliberately different
from the tenant-under-test's HVAC) → phone → billing (its own signed
webhook) → ai_check, entirely over the API, seeded and completed BEFORE
and DURING the tenant-under-test's UI journey. Final assertions: the
neighbour has exactly its own `tenant.ai_verified` row (not 0 — it truly
completed; not 2 — the writes didn't merge), its own `ai_check: done`
status, and its own non-empty, non-overlapping catalog (same disjoint-
names recipe as `onboarding-pack.test.ts`'s T3 case); the tenant under
test's own audit count is re-checked to still be exactly 1 AFTER the
neighbour's concurrent completion. `2 passed (55.2s)`, `tsc` clean.

## Before touching anything: most of this ticket was already done and merged

Issue #1016's comment history shows this exact lane (branch name
`cloud/setup-8-1`) already ran once, was gated by Fable, and merged to
`main` via batch PR #1047 (source PR #1036), covering rows **1.3, 1.9,
1.5, 1.8** (audit-leg swap to `PgAuditRepository` + T1/T3). Two further
lanes then extended the same rows: `cloud/second-tenant-rows` (PR #1074 →
batch #1081) added T1 neighbour-tenant legs to 1.1/1.2/1.4/1.11, and
`cloud/owner-surfaces-r5` (PR #1085 → batch #1091) added rung-5 Playwright
coverage for 1.2, 1.11, 4.1, 4.4. **1.7** was independently confirmed at 4
(T1) by the entry audit (#1006). Current `docs/PRD-v5-as-built.md` §8.1
reflects all of this on `origin/main` already.

So before writing anything, this lane re-verified the current state of
every row this scheduled prompt named, rather than redoing work:

| Row | State found on `main` before this lane | This lane's action |
|---|---|---|
| 1.3 | **4** (T1·T3), `PgAuditRepository` swap done, audit row asserted | Re-ran the suite (below) to confirm still green. No change. |
| 1.9 | **4** (T1), same swap done (`onboarding-conversation*`, `onboarding-vapi`) | Re-ran to confirm still green. No change. |
| 1.5 | **4** (T1), `onboarding-status-derived-gate.test.ts` already exists and proves the soft gate | Re-ran to confirm still green. No change. |
| 1.6 | **3** (PROVEN-UNIT), capped by the Twilio credential dependency | Confirmed the cap is still correct; appended to `blocked-on-josh.md` (was not previously appended). |
| 1.7 | **4** (T1), `billing-trial.test.ts` + `trial-provisioning-first-value.test.ts` | Assert-only per the ticket's "ONE HOP FROM MONEY" rule — read the tests, changed nothing. No defect found. |
| 1.8 | **4** (T1), audit leg proven at real Postgres | **This lane's actual new work — see below.** Built the hermetic rung-5 browser journey the ticket asked for. |
| 1.10 | **4** (T1), `brand-voice.integration.test.ts` | Investigated the rung-5 path; found a real product gate blocking it hermetically (see below) and appended to `blocked-on-josh.md`. No code change — 1.10 stays at 4. |

**Judgment call:** rows 1.1, 1.2, 1.4, 1.11 were left untouched exactly as
instructed ("DONE by other lanes; do not touch them"), even though 1.11's
PRD cell still documents an open cross-tenant security finding (#1092,
last-owner demotion) from the owner-surfaces lane — out of scope here, not
re-litigated.

## New work: 1.8's rung-5 hermetic browser journey

`e2e/journeys/onboarding-identity.spec.ts` (extended, not duplicated — this
is the file the ticket named that already has the right harness: Clerk
stub + signed-webhook bootstrap against real Postgres, `chromium` project,
never `chromium-devauth`). `e2e/journeys/onboarding-v2.spec.ts` was read
first per the ticket's instruction but its real-backend test requires live
`E2E_CLERK_SECRET_KEY` test credentials this environment doesn't have
(`hasClerkTestingCreds()` gates it) — not a fit for this harness, so the
identity spec's pattern was extended instead. Judgment call, noted rather
than silently switched.

New `test.describe('onboarding AI check (1.8) — reachable through the real
onboarding journey, real Postgres')` walks: identity (PUT, not re-proving
1.2's own UI leg) → pack (real HVAC button click) → phone (auto-completes
via the dev-stub Twilio worker on the in-process queue) → billing → AI
check, entirely through the real `/onboarding` wizard against real
Postgres, T1 against a neighbour tenant.

**Billing has no hermetic self-service path** — `BillingStep` redirects to
a real Stripe Checkout page, and this sandbox has no live Stripe
credentials or network egress to `stripe.com`. Rather than clicking "Start
trial", this lane drives a **self-signed Stripe-shaped
`customer.subscription.created` webhook** at the real `/webhooks/stripe`
route — the same event a real completed Checkout produces
(`packages/api/src/webhooks/routes.ts` Tier 4), with `metadata.tenant_id`
set (the same field `createTrialCheckoutSession` stamps). This mirrors two
already-established precedents in this exact repo: research #1004's
"drive a self-signed Twilio-shaped webhook through the real
`/api/telephony/*` routes" for phone-surface stories, and this file's own
sibling `e2e/journeys/public-invoice-pay-link.spec.ts`, which drives a
self-signed Stripe webhook through this exact route with the identical
signature recipe (`t=<ts>,v1=<hmac-sha256-hex>`, verified against
`createWebhookSignature` in `packages/api/src/webhooks/webhook-handler.ts`
— not guessed). No product code changed, no SQL write, no admin route.
`STRIPE_SECRET_KEY` (any non-empty placeholder — never dialed, it only
gates `billingService` on so the webhook's Tier-4 branch runs) and
`STRIPE_WEBHOOK_SECRET` are exactly the credentials a real deployment sets
to turn billing on — same class as this file's pre-existing
`CLERK_WEBHOOK_SECRET` dependency.

### RED (raw)

First attempt used `getByRole('button', { name: /^HVAC$/i })` (copied from
`onboarding-v2.spec.ts`'s real-backend test, which turned out to have
never actually been run — the pack card's accessible name concatenates
name + blurb + includes text, so an exact-match regex never matches):

```
TimeoutError: locator.click: Timeout 10000ms exceeded.
  - waiting for getByRole('button', { name: /^HVAC$/i })
```

Fixed to `page.locator('button', { has: page.getByText('HVAC', { exact:
true }) })` (the mocked test's working recipe). Next RED — the default 30s
Playwright test timeout is shorter than the full identity→pack→phone→
billing→ai_check walk:

```
Test timeout of 30000ms exceeded.
Error: expect(locator).toBeVisible() failed
Locator: getByRole('heading', { name: /your business number is ready/i })
```

Fixed with `testInfo.setTimeout(180_000)`. Next RED — a real discovery,
not a test bug: Twilio provisioning is enqueued on **signup** (the
`user.created` webhook), not after pack activation, so by the time the
wizard re-derives status after picking a pack, `phone` is already `done`
and the wizard skips `PhoneStep` entirely, going straight to `BillingStep`
— the "your business number is ready" heading never renders:

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('heading', { name: /your business number is ready/i })
Timeout: 60000ms
```

Fixed by making the phone-step wait conditional (`isVisible({timeout:
5000}).catch(() => false)`) — click "Continue to billing" only if
`PhoneStep` actually renders. Final RED — same shape, this time for AI
check: the server log showed `verify_ai` is enqueued by the **Stripe
webhook handler itself**, the instant it mirrors `subscription_status` to
`trialing` (not by pack activation, as an earlier code-reading comment in
this file incorrectly guessed before the log proved otherwise), and the
in-process 250ms queue poll loop runs and completes it before the
subsequent `page.reload()`'s first paint:

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('heading', { name: /ai verified/i })
Timeout: 30000ms
```

Fixed by asserting the fact instead of racing the transient screen: reload
lands on "Make a test call" (the next undone step), and
`GET /api/onboarding/status` is asserted to show `ai_check: done`.

### GREEN (raw)

```
$ TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts
[setup-test-db] container up: postgres://test:***@localhost:32768/serviceos_e2e_test

$ CLERK_DEV_HMAC_TOKENS=true DB_SSL=false \
  DATABASE_URL=postgres://test:test@localhost:32768/serviceos_e2e_test \
  E2E_USE_TEST_DB=true \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder \
  STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
  QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test onboarding-identity.spec.ts --project=chromium --retries=0 --reporter=line

  2 passed (49.8s)
```

Server log excerpt proving the real chain (not mocked):

```
"Twilio provisioning job enqueued" ... tenantId=<owner>
"Twilio creds absent — assigning STUB twilio integration (non-production only)" ... stubPhoneE164=+15005550006
"Stripe webhook received" ... type=customer.subscription.created
"Subscription status mirrored from Stripe" ... status=trialing
"AI verification job enqueued" ... tenantId=<owner> status=trialing
"AI verification passed" ... model=meta-llama/llama-3.1-8b-instruct
```

DB dumps (`docs/audit/lane-reports/setup-8-1/*.snapshot.txt`, from a kept
container, polled mid-run via `psql`):

```
1.8-tenants-subscription-status.snapshot.txt:
 id                                   | subscription_status | stripe_customer_id
 abe80cff-298a-4330-9ded-6a432188efbf | trialing             | cus_e2e_cffac59d-...

1.8-audit-events.snapshot.txt:
 tenant_id                            | event_type          | entity_type      | entity_id
 abe80cff-298a-4330-9ded-6a432188efbf | tenant.ai_verified  | tenant_settings  | abe80cff-...
```

Screenshots: `docs/audit/lane-reports/setup-8-1/1.8-billing-reached.png`,
`1.8-ai-verified-past.png` (phone-ready screenshot was NOT produced — the
RED run above is the reason: phone completes before the wizard ever shows
that screen for this tenant, so there is nothing to screenshot there; the
code guards this so a run where phone happens to still be pending would
capture it).

**Evidence class:** PROVEN-REAL-DB, write + audit, reached through the
real browser surface named by the story (rung 5 by the ticket's own
definition — this lane does not claim the rung; per #1016/#995, only
Fable does).

**Tenant grade: T1.** `grep -nE "neighbour|secondTenant|otherTenant" e2e/journeys/onboarding-identity.spec.ts`:

```
148:  const ownerB = await bootstrapOwner(page, 'ownerb');
371:  const neighbour = await bootstrapOwner(page, 'aicheckneighbour');
484:  const neighbourAudit = queryOne(
491:  const neighbourStatusRes = await page.request.get(...neighbour.authHeaders);
```

The neighbour tenant is seeded FIRST, runs zero onboarding steps, and is
asserted at the end to have no `tenant.ai_verified` row and to still sit
at `currentStep: 'identity'` — untouched by the tenant-under-test's full
journey.

### Build verification

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean, no output)
```

`e2e/` specs are not part of the `typecheck` npm script (`typecheck:api` /
`typecheck:web` / `typecheck:corpus` — no `typecheck:e2e`); Playwright
type-checks its own specs via its esbuild transform at run time, which the
GREEN run above already exercised.

### Regression check on the already-landed rows

```
$ cd packages/api && EXTERNAL_TEST_DB_URL=<kept container> RLS_RUNTIME_ROLE=true \
  npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/onboarding-pack.test.ts test/integration/onboarding-ai-check.test.ts \
  test/integration/onboarding-conversation-concurrent-turns.test.ts \
  test/integration/onboarding-conversation.test.ts \
  test/integration/onboarding-pack-seed-concurrency.test.ts \
  test/integration/onboarding-status-derived-gate.test.ts \
  test/integration/onboarding-vapi.test.ts

 Test Files  7 passed (7)
      Tests  29 passed (29)
```

No change to any of these files; run to confirm this lane's e2e work
didn't destabilize anything already merged.

## Not done — 1.10 (brand voice) rung 5

Investigated the same "identity → pack → phone → billing → AI check →
brand voice" journey through to brand voice, in Settings. Found a real
product gate, not a test gap: the Settings "Brand voice" row only renders
when `me.brand_voice_configurator_enabled` is true
(`packages/web/src/components/settings/SettingsPage.tsx:869`), resolved
through a per-tenant feature-flag override on top of a platform flag with
**no seed row anywhere in the codebase** — it resolves OFF for every
tenant, with no onboarding step or tenant self-service action that turns
it on. Reaching it hermetically would require either a raw DB write to the
feature-flags tables or an admin route, both explicitly forbidden by the
rung-5 definition ("no SQL setup, no admin route, no env shortcut") —
turning the flag on JUST to pass the test would prove reachability through
a door the product does not currently open for anyone. Full writeup and
the two options for Josh's call: `docs/audit/blocked-on-josh.md` (§1.10).
**1.10 stays at 4** (already proven, real Postgres, T1) — no rung-5 claim.

## Not done — 1.6 (own Twilio subaccount) rung 5

No new work — the existing PROVEN-UNIT ceiling (8 files, 85/85, real
credentials required for the paid subaccount-provisioning path) is
correct and was re-verified, not previously appended to
`docs/audit/blocked-on-josh.md`. Appended now (§1.6) so the map has a
single place recording every open blocker rather than scattering it across
PR comments.

## Judgment calls, summarized

1. Extended `onboarding-identity.spec.ts` rather than `onboarding-v2.spec.ts`
   for the rung-5 journey — the latter's real-backend path needs live Clerk
   test credentials unavailable in this harness.
2. Drove billing via a self-signed Stripe webhook rather than real
   Checkout — the established, precedented pattern for a third-party paid
   service this sandbox cannot reach, not a shortcut around product logic.
3. Asserted `ai_check: done` via the status API + audit row rather than a
   transient UI heading, once the RED run proved the real system completes
   the check faster than a page reload can observe the intermediate
   screen.
4. Did NOT attempt to make 1.10 reachable at rung 5 by seeding a feature
   flag — that would misrepresent what the shipped product currently
   allows any real tenant to do. Surfaced instead.
5. Did not touch 1.1, 1.2, 1.4, 1.11, or the money-adjacent 1.7 test files,
   per the ticket's explicit scope.

## Rung claims

None. Per #1016/#995: only Fable states a new rung. This report documents
what was proven, at what tenant grade, with what evidence class, so that
call can be made.
