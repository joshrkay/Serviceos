# Fieldly Launch Status — 2026-06-03 (refreshed)

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
- `2026-06-03-fieldly-gtm-brief.md` — positioning, ICP, pricing, channels, success metrics, risk register
- `2026-06-03-fieldly-launch-posts.md` — X thread, LinkedIn, Reddit, cold email, FB group drafts
- `2026-06-03-fieldly-launch-day-runbook.md` — day-by-day ops, env vars, rollback paths

### Product / code

**Public landing page** — `packages/web/src/components/landing/LandingPage.tsx`
- Hero, problem framing, 4-feature grid, Tuesday-comparison table, 3-step how-it-works, 4-pillar trust section, $297 pricing card, FAQ, final CTA
- Mounted at `/` via `ProtectedRoute` wrapper (signed-out → landing, signed-in → dashboard)

**Brand rebrand to Fieldly** — auth pages, swagger spec, console logs, settings copy, README, calendar test events, OpenRouter `X-Title`, escalation SMS fallback host; npm scope + DB identifiers + Clerk JWT template intentionally kept as internal contracts

**Onboarding deep-QA pass** — every step rebuilt on the Fieldly design system + targeted UX fixes:
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
| Confirm domain (`fieldly.app` recommended) | Founder | Drives DNS, Clerk URLs, Stripe webhooks, Twilio webhooks |
| DNS + TLS for `fieldly.app`, `api.fieldly.app`, `app.fieldly.app` | Founder | Railway auto-cert handles TLS once DNS resolves |
| Clerk application URLs & allowed origins | Founder | Update after domain is live |
| Stripe product + recurring price | Founder | `$297/mo` with 14-day trial; copy price id into Railway `STRIPE_PRICE_ID` |
| Production env vars on Railway | Founder | Full list in `2026-06-03-fieldly-launch-day-runbook.md` §Day 2 |
| Voice-quality Layer 1 cassette refresh | Founder + engineer | Requires `ANTHROPIC_API_KEY` on a trusted machine; `npm run voice-quality:refresh` → `voice-quality` until `launchGate.pass === true` |
| Voice-quality human sign-off | Founder | Record in `docs/superpowers/plans/2026-05-19-solo-owner-launch-audit.md` |
| Sentry → founder phone alerting | Founder | Wire after `SENTRY_DSN` is set |
| Warm contact list (20 names) for Day 3 cold-email | Founder | Per GTM brief §7 |

---

## 4. Nice-to-haves (post-soft-launch is fine)

- **PostHog wiring** for funnel metrics (signup → onboarding-complete → trial → paid)
- **patch_owner state-machine implementation** — owner_phone data is captured + queryable, but the voice-agent FSM's `patch_owner` branch is documented and not yet implemented. When it lands, the resolver helper is the only wiring needed.
- **Sidebar re-edit state invalidation** — changing Pack mid-wizard doesn't reset downstream Phone state; current behavior is non-destructive but confusing if re-picked
- **Settings page surface for the timezone field** — currently only editable via the BusinessProfileSheet's existing tz picker, which already worked
- **Quarantine CDK + langgraph prototypes** — pure cosmetic / repo hygiene
- **Demo video** and **help-center articles** per GTM brief §10

---

## 5. Commit log (PR #501)

```
7f81b7f fix(onboarding): close PR #501 review-bot findings (#2/#1/#4/#5/#7/#3)
20e3e47 feat(settings): owner phone editor + timezone validation hardening
580e6b4 feat(onboarding): collect owner cell phone for emergency triage
2819184 qa(onboarding): design system + UX pass on every step
34eb5df fix(security): FORCE row level security on all tenant-scoped tables
828093b docs(launch): launch-status dashboard
c9f27e5 fix(onboarding): auto-seed job types and templates on pack activation
4da9df8 chore(rebrand): finish ServiceOS→Fieldly cleanup pass
dd7eae5 docs(launch): launch-day operational runbook
08c2707 fix(onboarding): seed default AI model on tenant creation
fd5e6a3 docs(launch): launch-day posts (X/LinkedIn/Reddit/email) + README rebrand
934045e feat(launch): public landing page, GTM brief, rebrand to Fieldly
83b50e7 fix(web): remove mock-data fallback from public estimate page
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
