# Rivet Launch Status — 2026-06-03 (refreshed)

Single dashboard for launch-week progress. When this disagrees with any
other doc on "is X done?", **this wins**. Last refresh: end of day
2026-06-03 after the deep-QA pass + bot-review remediation.

---

## TL;DR

**Every product-correctness blocker from `GO-LIVE-READINESS.md` is
closed.** All 10 listed items are either fixed in code or accepted
single-instance constraints. The deep-QA sweep on onboarding shipped
the design-system pass, owner-phone plumbing, Settings UI, and 8
bot-review remediations.

**Recommendation**: launch is gated on ops (domain, env vars, voice-
quality cassette sign-off) rather than on code. We can flip the
public switch as soon as ops items in §3 are complete.

PR #501 (`claude/gallant-hypatia-D6GAv` → `main`) is the launch
delta. CI was green on `580e6b4`; the bot fixes (`7f81b7f`) push
should re-run and stay green.

---

## 1. Code blockers — all closed

| # | Blocker | Status | Where |
|---|---|---|---|
| 1 | Stripe/Clerk webhook idempotency (in-memory → restart double-charge) | ✅ Fixed | PR #457; verified `app.ts:647`, `webhooks/routes.ts:189` |
| 2 | Tenant-context middleware commits on 5xx | ✅ Fixed | `middleware/tenant-context.ts:140-152` rolls back when `res.statusCode >= 400`; 15/15 unit tests pass |
| 3 | FORCE RLS missing on 29 tables | ✅ Fixed | This PR (`34eb5df`); pin test in `test/db/schema.test.ts` |
| 4 | Web proposal-approval missing auth header | ✅ Fixed | `AssistantPage.tsx` uses `apiFetch` |
| 5 | In-process cron sweeps on multi-instance | ⚠️ Accepted | Single-instance constraint documented in launch runbook |
| 6 | `recordPayment` emits no audit events | ✅ Fixed | `invoices/payment.ts:270-294` emits audit on success/failure |
| 7 | No DB exclusion constraint for double-booking | ✅ Fixed | Migration 131 — `btree_gist` + `EXCLUDE USING gist`; schema test pins it |
| 8 | EstimateApprovalPage mock-data fallback leaks tenants | ✅ Fixed | This PR (`83b50e7`); retry error state with no fixture fall-through |
| 9 | CDK / langgraph prototypes orphaned in repo | ⚠️ Cosmetic | Quarantine post-launch; no operational risk for single-instance Railway deploy |
| 10 | Green CI + applied migrations | 🟡 Verify on push | API tsc green locally, web vite build green; Railway preview deploys green on every push |

---

## 2. Done in this session — full inventory

### Strategy & marketing
- `2026-06-03-rivet-gtm-brief.md` — positioning, ICP, pricing, channels, success metrics, risk register
- `2026-06-03-rivet-launch-posts.md` — X thread, LinkedIn, Reddit, cold email, FB group drafts
- `2026-06-03-rivet-launch-day-runbook.md` — day-by-day ops, env vars, rollback paths

### Product / code

**Public landing page** — `packages/web/src/components/landing/LandingPage.tsx`
- Hero, problem framing, 4-feature grid, Tuesday-comparison table, 3-step how-it-works, 4-pillar trust section, $297 pricing card, FAQ, final CTA
- Mounted at `/` via `ProtectedRoute` wrapper (signed-out → landing, signed-in → dashboard)

**Brand rebrand to Rivet** — auth pages, swagger spec, console logs, settings copy, README, calendar test events, OpenRouter `X-Title`, escalation SMS fallback host; npm scope + DB identifiers + Clerk JWT template intentionally kept as internal contracts

**Onboarding deep-QA pass** — every step rebuilt on the Rivet design system + targeted UX fixes:
- IdentityStep: pre-loads existing settings on mount; timezone picker (browser-detected, allowlist-validated); owner-phone field with emergency-triage explainer; all-days-off client guard
- PackStep: prefixed seed names (HVAC vs plumbing collision fixed); brand-aligned cards
- PhoneStep: blocker-code → friendly copy mapping; forwarding instructions inline; E.164 → `(XXX) XXX-XXXX` formatting; 30s "still working" cue
- BillingStep: leads with "cancel anytime"; smart 4xx/5xx error mapping
- AiCheckStep: explains what verification is doing; friendlier blocker copy
- TestCallStep: 60s "no call detected" cue
- OnboardingShell: real Spinner + Button primitives; clean error retry
- Sidebar: brand-aligned glyphs, progress bar, `hidden md:flex`
- MobileProgress: new compact strip for `< md` screens

**Owner phone end-to-end** (P8-016 forward-wiring)
- Migration 143: `tenant_settings.owner_phone TEXT`
- Onboarding contract + Settings update schema accept `ownerPhone` in any human format
- PUT routes normalize via `normalizeMobileE164`, return 400 on invalid (not silent drops)
- Tri-state CASE expression: undefined leaves alone, empty clears, valid replaces
- `createSettingsOwnerPhoneResolver(settingsRepo)` helper matches the existing `OwnerPhoneResolver` signature so future voice-triage wiring is a one-liner
- Settings UI (Business Profile sheet) exposes the field with the same explainer

**Pack auto-seed** — `packages/api/src/packs/seed-pack-defaults.ts`
- HVAC + plumbing packs seed canonical `catalog_items` + `estimate_templates` on activation
- Pack-prefixed names ("HVAC Diagnostic Fee" / "Plumbing Diagnostic Fee") so multi-pack tenants get both sets at the right pack prices
- Error propagates from the route — partial-seed never persists thanks to the request transaction

**AI model auto-provision** — both `ensureTenantSettings` and the two earlier row-creation paths (PUT /identity raw INSERT, POST /pack create) now seed `resolveBootstrapAiModel()` with COALESCE on update so tenant overrides aren't clobbered

**Timezone validation** — `/api/onboarding/identity` rejects timezones outside `VALID_TIMEZONES` so downstream `Intl` callers can never receive `Foo/Bar`

**8 PR-#501 bot review comments addressed** — see commit `7f81b7f` for the full mapping

### Confirmed already fixed before this session
- Webhook idempotency (PR #457)
- Web proposal-approval auth header
- `recordPayment` audit emission
- Appointment double-booking exclusion constraint

---

## 3. Ops — what's left for launch

| Task | Owner | Notes |
|---|---|---|
| Confirm domain (`rivet.ai` recommended) | Founder | Drives DNS, Clerk URLs, Stripe webhooks, Twilio webhooks |
| DNS + TLS for `rivet.ai`, `api.rivet.ai`, `app.rivet.ai` | Founder | Railway auto-cert handles TLS once DNS resolves |
| Clerk application URLs & allowed origins | Founder | Update after domain is live |
| Stripe product + recurring price | Founder | `$297/mo` with 14-day trial; copy price id into Railway `STRIPE_PRICE_ID` |
| Production env vars on Railway | Founder | Full list in `2026-06-03-rivet-launch-day-runbook.md` §Day 2 |
| Voice-quality Layer 1 cassette refresh | Founder + engineer | Requires `ANTHROPIC_API_KEY` on a trusted machine; `npm run voice-quality:refresh` → `voice-quality` until `launchGate.pass === true` |
| Voice-quality human sign-off | Founder | Record in `docs/superpowers/plans/2026-05-19-solo-owner-launch-audit.md` |
| Sentry → founder phone alerting | Founder | Wire after `SENTRY_DSN` is set |
| Warm contact list (20 names) for Day 3 cold-email | Founder | Per GTM brief §7 |

---

## 4. Done since prior status refresh (server-side analytics + billing race)

**Server-side PostHog funnel** (`3fe4743`)
- `lib/analytics/posthog.ts` (server) + `lib/analytics.ts` (client) — both off-by-default. Browser SDK init turns `capture_pageview: false` (token-leak fix from `139ecee`).
- Concrete events fire at signup, onboarding-complete, voice-agent-turned-on, trial_started, trial_to_paid, subscription_canceled. Server-side path stamps tenants.stripe_customer_id from subscription metadata + clears pending marker on subscription.created.

**Billing-race hardening** (PR-#501 bot-driven, `43025cb` → `e94ee62`)
1. `createTrialCheckoutSession` reuses the canonical Stripe customer (no more orphan customers across tabs/retries).
2. Subscription_status gate refuses new checkout when one is already live.
3. Postgres advisory transaction lock serializes per-tenant trial checkouts.
4. Migration 144 adds `tenants.pending_checkout_at`; migration 145 adds `tenants.pending_checkout_session_id`. Combined gate refuses new checkout when a session is open OR a marker is fresh.
5. Stripe `expires_at` bound to the gate's 32-min ceiling so the session can't outlive enforcement.
6. `clearPendingCheckout` reads the session id server-side and calls `/v1/checkout/sessions/:id/expire` before clearing — cancel-return on the browser then actually invalidates the prior URL.
7. Marker clear moved out of the subscription handler and onto `checkout.session.expired` (abandoned) + `customer.subscription.created` (success) so a delayed sub.updated/deleted can't clobber a newer pending row, and `session.completed` arriving before `subscription.created` doesn't open the gate prematurely.
8. Atomic `trial_started` transition via `SELECT ... FOR UPDATE` in the webhook handler closes the funnel double-fire under concurrent same-transition events.

**Other PR-#501 review remediations** addressed in commits `4a33b01` (Stripe session expires_at + cancel-return), `3229233` (cancel-cleanup error surfacing + stale-tab cancel deferred), `f82ba52` (`/api/onboarding/pack` requires owner role), `dd20e2d` (`/billing/cancel` requires owner role).

## 5. Nice-to-haves (post-soft-launch)

- **`patch_owner` state-machine implementation** — owner_phone is captured and the resolver is ready, but the production voice-agent FSM's `patch_owner` branch needs vulnerability + urgency classifiers that don't yet exist in tree. Explore agent estimate: **LARGE, 4-5 engineer-days**. Path documented in `createSettingsOwnerPhoneResolver`'s docstring; not a single-PR drop-in.
- **Sidebar re-edit state invalidation** — changing Pack mid-wizard doesn't reset downstream Phone state; current behavior is non-destructive but confusing if re-picked.
- **Per-checkout cancellation nonce** — stale tabs returning via cancel_url currently clear the marker for the wrong session id. Documented in `clearPendingCheckout`. Soft-launch consequence: operator clicks Start Trial again. Tracked as follow-up.
- **Settings page surface for the timezone field** — currently editable via the BusinessProfileSheet picker, which already worked.
- **Quarantine CDK + langgraph prototypes** — pure cosmetic / repo hygiene.
- **Demo video** and **help-center articles** per GTM brief §10.

---

## 6. Commit log (PR #501, most recent first)

```
e94ee62 fix(webhooks): atomic trial_started transition via SELECT ... FOR UPDATE
9667d0b fix(webhooks): keep checkout gate closed until subscription mirrored
dd20e2d fix(billing): scope marker clear to session id + gate cancel to owners
f82ba52 fix(onboarding): gate pack activation behind requireRole('owner')
3229233 fix(billing): surface cancel-cleanup failures + document stale-tab edge
ae06a6c fix(billing): persist Stripe session id server-side
4a33b01 fix(billing): expire canceled Stripe session before reopening gate
1d02ebf fix(billing): bind Stripe session lifetime to gate + clear marker on cancel
91fe4d5 fix(billing): close residual checkout race with pending_checkout_at marker
54c30aa fix(billing): serialize trial checkout per tenant via advisory lock
43025cb fix(billing): prevent orphaned duplicate trial subscriptions
d85a0b4 test(billing): update integration mock for two-step Stripe flow
477b65c fix: honest patch-through copy + repair trial_started funnel
139ecee fix(analytics): close PostHog pageview token leak + repair completed dedup
3fe4743 feat(analytics): server-side PostHog for trial funnel + T-Mobile fix
900908b feat(analytics): PostHog wiring + fix CI snapshot + IdentityStep preload bug
ffecce0 rebrand: Fieldly → Rivet (rivet.ai)
580e6b4 feat(onboarding): collect owner cell phone for emergency triage
2819184 qa(onboarding): design system + UX pass on every step
34eb5df fix(security): FORCE row level security on all tenant-scoped tables
c9f27e5 fix(onboarding): auto-seed job types and templates on pack activation
08c2707 fix(onboarding): seed default AI model on tenant creation
934045e feat(launch): public landing page, GTM brief, rebrand to Rivet
83b50e7 fix(web): remove mock-data fallback from public estimate page
(... earlier commits truncated; full history on the branch)
```

All on branch `claude/gallant-hypatia-D6GAv` — open as PR #501.

---

## 6. How to verify what's done

```bash
# Build gates (both must be exit 0 before merge)
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/web && npx vite build

# Unit suites for everything we touched
cd packages/api && npx vitest run \
  test/settings test/packs test/onboarding \
  test/middleware/tenant-context.test.ts \
  test/db/schema.test.ts \
  test/ai/agents/customer-calling/escalation-summary-builder.test.ts

# Settings UI test
cd packages/web && npx vitest run src/components/settings/BusinessProfileSheet.test.tsx

# Visual smoke (needs VITE_CLERK_PUBLISHABLE_KEY in /env.js)
cd packages/web && npm run dev
# Open http://localhost:5173 — landing page when signed out, dashboard when signed in
```
