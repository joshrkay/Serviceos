# §8.1 Setup — rung-5 reachability, Sonnet test-only lane (branch `test/8-1-setup-r5`)

Scope per the ticket: rows **1.1, 1.3, 1.4, 1.5, 1.7, 1.9** ("reach hermetically" —
each currently at cell `4`) and **1.10** ("as far as the real surface allows").
Rows 1.2, 1.8, 1.11 are already at target (cell `5`) — not touched. Row 1.6 is
report-only (capped at 3 by a live-Twilio-subaccount dependency, already
documented) — re-confirmed, not touched.

Six new spec files, one shared bootstrap fixture (copied, not imported, from
`onboarding-identity.spec.ts` so that already-landed 1.2/1.8 spec is never
edited):

- `e2e/fixtures/onboarding-hermetic-lane.ts` — `bootstrapOwner`,
  `postSignedWebhook`, `pollDbSnapshot`, `queryOne`, `queryColumn`.
- `e2e/journeys/onboarding-signup-webhook.spec.ts` — **1.1**
- `e2e/journeys/onboarding-pack-concurrency.spec.ts` — **1.3**
- `e2e/journeys/onboarding-status-gate.spec.ts` — **1.4** and **1.5** (one
  file, two tests — both are about `/onboarding`'s derived status/soft gate
  reachable through the real browser)
- `e2e/journeys/onboarding-conversation-hermetic.spec.ts` — **1.9**
- `e2e/journeys/onboarding-billing-plan-validation.spec.ts` — **1.7**
- `e2e/journeys/onboarding-brand-voice-gate.spec.ts` — **1.10**

Every spec drives the real running Playwright webServer pair (real Express
app, real Postgres via a testcontainer) — never a mock — following the exact
`bootstrapOwner`/`installClerkStub`/`blockExternalHosts` pattern already
proven by `onboarding-identity.spec.ts` (1.2/1.8) and
`accept-invitation.spec.ts` (1.11).

## Environment issues found and worked around (not product bugs, not filed)

1. **Shared `node_modules` version drift breaks `ts-node`.** The root
   checkout's `node_modules/@types/node` is at `26.5.1`; `package-lock.json`
   pins `20.19.39`. `packages/api/src/voice/voice-service.ts`,
   `auth/clerk.ts`, and `routes/assistant.ts` fail `tsc` under the drifted
   types (confirmed via `npx tsc --project tsconfig.build.json --noEmit` on
   unmodified `origin/main` — same 3 pre-existing errors, none in files this
   lane touched). `ts-node/register`'s default (non-transpile-only) mode
   refuses to boot the API webServer at all under this drift. Worked around
   per-invocation with `TS_NODE_TRANSPILE_ONLY=true` (skips ts-node's own
   type-check; the compiled-JS runtime behavior is unaffected) — every
   command in this report uses it. Not a code change; not filed, since it's
   an environment/dependency-lockfile drift outside this lane's file scope.
2. **Vite's dependency optimizer mis-resolves `@stripe/react-stripe-js`
   across the git-worktree boundary.** With no `node_modules` at the
   worktree root (real one lives in the parent checkout, found via Node's
   upward resolution), `vite@8.3.0`'s rolldown-based `extractExportsData`
   computes an absolute path rooted at the WORKTREE directory instead of the
   resolved package location and throws `ENOENT`, crashing the whole `vite`
   dev process (reproduced standalone, outside Playwright, confirming it is
   not a Playwright-specific race). Worked around with a local, untracked
   symlink (`ln -s <repo-root>/node_modules <worktree>/node_modules`,
   removed again after this lane's runs) — a filesystem-only fix, no
   tracked file touched, scoped to this worktree only.
3. **`playwright.config.ts`'s Vite dev proxy target defaults to port 3000**
   (`VITE_API_URL`, read only by `vite.config.ts`'s server-side proxy — nothing
   client-side reads it). The preamble's dedicated-port instructions name
   `E2E_API_URL`/`PUBLIC_API_URL` but not `VITE_API_URL`; every command in
   this report adds `VITE_API_URL=http://localhost:<port>` alongside them —
   worth folding into the shared preamble for future dedicated-port lanes
   that drive a browser (webhook-only specs like 1.1 don't need it).

None of the three above are product defects; all are noted so the next lane
on this shared box doesn't re-spend the time diagnosing them.

## Row 1.1 — signup webhook idempotency + replay window

Real surface: the webhook itself (no browser UI names this story — "I never
see a setting-up screen"). `e2e/journeys/onboarding-signup-webhook.spec.ts`
drives `POST /webhooks/clerk` twice for the same Clerk user (two distinct
svix ids — a genuine redelivery, not the same-id dedup path) through the
real router.

- Two real deliveries → both 200; `tenants` has exactly 1 row
  (`owner_id` match), `users` has exactly 1 row with `role='owner'`.
- A webhook 600s stale, with a deliberately garbage signature, is rejected
  400 `"Timestamp outside tolerance"` — not 401 — proving the replay window
  is checked **before** signature verification (matches
  `packages/api/src/webhooks/routes.ts`'s comment at the check). No tenant
  created for the stale attempt.
- T2: a neighbour tenant bootstrapped first is untouched (own tenant + user
  row counts unaffected) by all of the above traffic.

**Observation, not filed (matches the section file's own #1075 note):** the
`tenant.signup.bootstrap.completed` audit write is not gated on
`result.created`, so the genuine redelivery leg above wrote **2** audit rows
for 1 tenant (`docs/audit/lane-reports/setup-8-1-r5/1.1-bootstrap-audit-after-redelivery.snapshot.txt`).
Not part of 1.1's stated acceptance ("exactly one tenant exists"), so not
asserted as a failure — recorded for the record only.

Command:
```
PORT=38540 E2E_API_URL=http://localhost:38540 PUBLIC_API_URL=http://localhost:38540 \
E2E_DEV_AUTH=0 E2E_NOAUTHBYPASS=0 \
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<testcontainer> E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_… TS_NODE_TRANSPILE_ONLY=true \
npx playwright test onboarding-signup-webhook.spec.ts --project=chromium --retries=0
```
GREEN twice: `1 passed (28.4s)`, `1 passed (10.2s)`.

## Row 1.3 — pack activation, concurrent, through the real route

`e2e/journeys/onboarding-pack-concurrency.spec.ts`. `onboarding-pack.test.ts`
+ `onboarding-pack-seed-concurrency.test.ts` already prove the lock at real
Postgres by calling `activatePackWithSeed`/the execution handlers directly;
this spec drives the SAME real `POST /api/onboarding/pack` route a browser
click actually posts to — once through a real browser click (persona
reachability), then twice **concurrently** (`Promise.all` of two
`page.request.post`) for a second tenant — the literal acceptance shape.

- Browser pick: 1 `pack_activations` row, 1 `tenant.pack_activated` audit row.
- The race: every response is 200 or the advisory lock's own 409
  `PACK_ACTIVATION_IN_PROGRESS` (never 500 — `packages/api/src/routes/onboarding.ts`'s
  `pg_try_advisory_xact_lock` path); exactly 1 `pack_activations` row and 1
  audit row survive; no duplicate `catalog_items`/`estimate_templates` names.
- T3: a third tenant activates `plumbing` through the same route; its
  catalog and the race tenant's HVAC catalog share zero item names
  (`1.3-T3-catalog-disjoint.snapshot.txt`: 6 rows each, 0 overlap).
- T2: a bystander tenant seeded first has zero pack activations / catalog
  items throughout.

RED (first attempt, before the `VITE_API_URL` fix above was known):
`Error: expect(locator).toBeVisible() failed — getByRole('heading', {name:
/pick your trade/i})` — the browser showed **"We couldn't load your setup"**
because the Vite dev proxy was pointed at the wrong port.

GREEN twice (after the fix, fresh web server each time): `1 passed (24.9s)`,
`1 passed (41.8s)`.

## Rows 1.4 + 1.5 — derived status + soft gate, through the real browser gate

`e2e/journeys/onboarding-status-gate.spec.ts`, two tests.

**1.5** drives the REAL client-side gate
(`packages/web/src/components/auth/ProtectedRoute.tsx`'s `OnboardingGuard`)
that `test/integration/onboarding-status-derived-gate.test.ts` already
proves never exists server-side: pre-identity, `/customers` hard-redirects
to `/onboarding`; `/inbox` (the approval queue) is exempt even pre-identity;
post-identity, `/customers` unlocks with phone/billing/AI/test-call all
still incomplete (`isComplete:false` asserted directly, so the unlock is
provably a nudge, not a secret finish). T2: a neighbour who never touched
identity keeps its own gate locked, independent of the tenant under test.

**1.4** activates `pack` (HVAC) **before** ever touching identity over the
API — the wizard still lands on Identity (the earliest undone step,
`currentStep: 'identity'`) even though a later step is already `done`,
which a stored "step N" pointer has no slot for. Identity is then submitted
through the real form, and a **full page reload** ("close the laptop and
come back") re-derives from Postgres straight to the next real step
(phone-ready or, if the dev-stub already finished, billing) — never back to
pack.

Screenshots: `1.5-pre-identity-customers-redirect.png`,
`1.5-post-identity-customers-unlocked.png`, `1.4-after-reload-derived-step.png`.

GREEN twice: `2 passed (26.2s)`, `2 passed (1.9m)`.

## Row 1.9 — conversational path, hermetic

`e2e/journeys/onboarding-conversation-hermetic.spec.ts`. Drives the real
`/onboarding` "Talk it through instead" panel — real `POST
/api/onboarding/conversation/turn`, the app's own hermetic `MockLLMProvider`
(no `AI_PROVIDER_API_KEY`, matching 1.8's already-proven wiring), up to 15
turns.

- `MockLLMProvider.scriptHermeticResponse()` has no branch for this
  feature's extractor task types (`extract_business_profile` etc.), so
  every extraction is low-confidence/empty — this is the REAL hermetic
  behavior, not a test shortcut, and it still exercises every mechanical
  claim in the acceptance: `MAX_CLARIFICATIONS_PER_STATE` (2) force-advances
  each capture state, `MAX_TURNS` (15) force-caps the session
  (`fsm_state: 'capped'`, `turn_count: 15`, `transcript_turns` 31 entries —
  `1.9-session-terminal-state.snapshot.txt`), `clarification_count_by_state`
  round-trips through JSONB.
- RLS: `pg_class.relrowsecurity`/`relforcerowsecurity` both true on
  `onboarding_session`; a policy exists.
- Cross-tenant refused: a neighbour (its OWN, separate auth) POSTing a turn
  against the real session id gets 404 `ONBOARDING_SESSION_NOT_FOUND` — the
  RLS-aware "doesn't exist" shape, not a 403 that would leak the id.
  Neighbour has zero sessions of its own.
- Form wizard stays reachable the entire time ("Prefer the form? Switch
  back" visible from the very first render, before any turn is sent).
- **Pinned, not faked:** a second test states a business name in plain
  English on the first turn and asserts it round-trips into
  `extraction_state->'businessProfile'->>'businessName'` — `test.fail(true,
  …)`, naming the seam (`packages/api/src/ai/providers/mock.ts:223-232`,
  `packages/api/src/ai/tasks/onboarding/business-profile-extractor.ts:78-90`).
  Same class of gap as the already-parked #1119 decision (a real model turn
  the hermetic mock cannot script). Confirms the natural failure (the name
  is not captured) rather than throwing without attempting it.

**Observation, not filed:** the first click into "Talk it through" created
**two** `onboarding_session` rows for the same tenant — one abandoned at
`turn_count:0` (just the opening prompt), one that received all 15 real
turns (visible in both RED and the final GREEN snapshot). Consistent with
`ConversationStep`'s no-message "surface the opening prompt" effect firing
twice under Vite/React dev double-invoke before the returned session id was
persisted to `localStorage`. Cosmetic (one wasted row; the user's actual
conversation is unaffected) — not asserted as a failure, but it did make
`ORDER BY created_at DESC LIMIT 1` pick the wrong row on the first pass of
this test (fixed by reading the session id straight from the turn response
instead of querying it back — see RED below).

RED #1: `Error: FSM reached a terminal state, got 'profile_capture'` — the
DB query above picked the stray empty session, not the one actually driven.
Fixed by capturing `sessionId` from each turn response's own JSON body.
RED #2: `Expected: "t,t" / Received: "true,true"` — `bool::text` casts to
the word, not the single-letter I/O shorthand; fixed the expected literal.

GREEN twice: `2 passed (1.7m)`, `2 passed (2.1m)`.

## Row 1.7 — billing plan validation

`e2e/journeys/onboarding-billing-plan-validation.spec.ts`.

- With no `STRIPE_BASIC_PRICE_ID`/`STRIPE_ENTERPRISE_PRICE_ID` set (this
  deployment's actual current state), `GET /api/onboarding/billing/plans`
  fails closed 503 `BILLING_PLANS_UNAVAILABLE` (not an empty 200 array);
  the real `BillingStep` never renders a plan radiogroup at all — the
  fail-closed message replaces it, it doesn't sit next to a
  broken/priceless card.
- **Pinned, not faked:** the OTHER half of the acceptance — a plan
  CONFIGURED with a price that fails live Stripe validation, as opposed to
  simply being unconfigured — needs `validatePlanPrice`
  (`packages/api/src/billing/subscription.ts:293-345`) to make a real fetch
  to `api.stripe.com`. `billing-trial.test.ts` already proves this at the
  unit/integration layer with a **mocked** `fetchFn`; this lane does not
  re-count a mocked fetch as rung-5 real-surface proof, and does not
  exercise a live third-party. Same class of gap as the already-parked
  #1000/#1002 decision. `test.fail(true, …)` names the exact seam.

RED #1: `Received: "BILLING_NOT_CONFIGURED"` — first attempt omitted
`STRIPE_SECRET_KEY` entirely, so `billingService` itself was never
constructed (a different, earlier fail-closed branch than the one under
test). Fixed by adding the same `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`
stub placeholders 1.8's spec already established as the pattern for
"billing on, never dialed."
RED #2: a naive `page.getByText(/\$\d/)).toHaveCount(0)` false-positived on
a legitimate marketing bullet elsewhere on the same screen ("500 voice
minutes included; $0.30 each after") — fixed to assert on the actual plan
**radiogroup** (`role="radiogroup"`, `aria-label="Choose a billing plan"`)
being absent, the real shape of "a rendered plan card."
RED #3 (intermittent, ~2 of 5 attempts): the FIRST `/api/onboarding/status`
fetch after `page.goto('/onboarding')` failed under this shared sandbox's
variable concurrent load, landing on the app's own "We couldn't load your
setup" error boundary; the hook's built-in exponential-backoff retry
sometimes didn't land inside a single 30s wait. Fixed by nudging its
"Try again" button (up to 3 attempts) before the main assertion, matching
what a real user would do — not a product gap, a resilience gap in this
one test against a noisy shared box.

GREEN twice (post-fix): `2 passed (2.0m)`, `2 passed (58.4s)`.

## Row 1.10 — brand-voice configurator: reachability ceiling, re-confirmed

`e2e/journeys/onboarding-brand-voice-gate.spec.ts`. Per the ticket: "reach
what an owner can reach; if the flag has a real owner-facing or
onboarding-time toggle, use it; otherwise pin the stop and report — decision
already parked." Re-verified against the CURRENT tree (not assumed stale
from the prior §8.1 lane's finding, `docs/audit/blocked-on-josh.md` §1.10):

1. `GET /api/me` resolves `brand_voice_configurator_enabled: false` for a
   real owner past identity (1.5's soft gate — the real page any owner
   reaches).
2. The real `/settings` page (reached by the browser, not assumed) never
   renders a "Brand voice" row/text (`page.getByText(/brand voice/i)`
   count 0) — screenshot `1.10-settings-no-brand-voice-row.png`.
3. **The real self-service mechanism this codebase gives owners for OTHER
   per-tenant capabilities** (`PUT /api/settings/capabilities/:key`,
   `dropped_call_recovery` / `voice_vulnerability_triage`) is called with
   `brand_voice_configurator` and refuses 400 `"Not an owner-settable
   capability. Allowed: dropped_call_recovery, voice_vulnerability_triage"`
   — proving there is no owner-facing toggle, not merely that today's UI
   doesn't show a button for one. No onboarding-time toggle either (no
   `brand_voice`/`BrandVoice` reference anywhere in `OnboardingShell.tsx` or
   the onboarding step types).

No SQL write, no admin route, no env shortcut. 1.10's reachability ceiling
is confirmed unchanged; this is not a rung claim.

GREEN twice: `1 passed (1.6m)`, `1 passed (57.0s)`.

## Regression check

`onboarding-identity.spec.ts` (1.2/1.8, already at target — not touched by
this lane) re-run once against the same environment/fixes: `2 passed
(1.5m)`. No change to that file; confirms this lane's new specs and
environment workarounds did not destabilize it.

`packages/api` build check (`npx tsc --project tsconfig.build.json
--noEmit`) shows the 3 pre-existing errors documented above, unchanged by
this lane (this lane touched no `packages/api/src` file) — see "Environment
issues" §1.

## What is NOT proven (honest list)

- **1.9**: the FSM reaching `completed` (vs. `capped`) with genuinely
  extracted business details — needs a real model turn (#1119-class),
  pinned with `test.fail()`.
- **1.7**: a plan configured with a price that fails LIVE Stripe validation
  (vs. simply unconfigured) — needs a real Stripe secret key + live network
  egress to a third party (#1000/#1002-class), pinned with `test.fail()`.
- **1.10**: no rung-5 path exists at all while the flag has no self-service
  toggle — confirmed, not a gap in this lane's reach.
- **1.1**: the duplicated `tenant.signup.bootstrap.completed` audit row on
  genuine redelivery (#1075-class, already known) — not part of the row's
  stated acceptance, recorded not asserted.
- **1.9** (observation): a stray, abandoned `onboarding_session` row is
  created on the first "Talk it through" mount under Vite/React dev
  double-invoke — cosmetic, not asserted as a failure.

## Product gaps found (for Fable to ticket, none filed by this lane)

None beyond the two already-parked-class gaps (1.9, 1.7) and the two
recorded-not-asserted observations (1.1's duplicate audit row, 1.9's stray
session row) above — all four are pre-existing/known-class, not new
findings this lane is claiming credit for discovering.

## Rung claims

None. Per #1016/#995: only Fable states a rung.
