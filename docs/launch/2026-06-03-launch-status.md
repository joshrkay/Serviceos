# Fieldly Launch Status — 2026-06-03

This document is the single dashboard for launch-week progress. It's
updated as work lands. When this disagrees with any other doc on
"is X done?", this wins.

---

## TL;DR

We are **5 days from a full public launch**. Strategy and marketing
artifacts are done. The landing page is shipped. Three of four
critical blockers identified pre-session are fixed. Two onboarding
blockers are fixed in this session. One critical product-correctness
blocker remains (transaction rollback) plus medium-risk hygiene
items. None requires a redesign.

**Recommendation**: hold the public switch until the remaining
transaction-rollback fix lands and the voice-quality gate is signed
off (both on the GO-LIVE checklist).

---

## Done this session

### Strategy &amp; marketing
- [x] **GTM brief** — `2026-06-03-fieldly-gtm-brief.md`
- [x] **Launch-day social posts** — `2026-06-03-fieldly-launch-posts.md`
- [x] **Launch-day operational runbook** — `2026-06-03-fieldly-launch-day-runbook.md`

### Product / code
- [x] **Public landing page at `/`** — `packages/web/src/components/landing/LandingPage.tsx`. Unauthenticated visitors see the marketing page; authenticated users still see the dashboard.
- [x] **ProtectedRoute wired** to render LandingPage on `/` when not signed in.
- [x] **Brand cleanup (Fieldly)** — HTML title, swagger API title, startup log, Terminology &amp; Calendar settings copy, README, Calendar test event copy, OpenRouter headers, escalation SMS fallback host.
- [x] **Estimate-page mock-data leak fix** — public `/e/:id` no longer falls back to fixture data on a network error; clean error state with retry. (Blocker #8.)
- [x] **AI model auto-provisioned on tenant creation** — `ensureTenantSettings` writes `ai_model` from `AI_DEFAULT_MODEL` so the onboarding "AI check" step works for every new tenant.

### Confirmed already fixed (audit doc was stale)
- [x] Webhook idempotency — Stripe + Clerk use durable PG repo (PR #457).
- [x] AI proposal approval in web — uses `apiFetch` with auth header.

---

## In flight (this session)

- [ ] **Pack auto-seed on activation** — agent running. Will seed job types and default templates when a tenant picks HVAC or plumbing in onboarding.
- [ ] **FORCE ROW LEVEL SECURITY on tenant tables** — agent running. Closes the silent tenant-isolation bypass on single-role Postgres deploys.

---

## Open before launch

### Critical (must land before public switch)
- [ ] **Transaction rollback on error** — `middleware/tenant-context.ts:138-140` commits even on 5xx. Risk of partial multi-write corruption.
- [ ] **Voice-quality Layer 1 gate** — record cassettes locally (needs `ANTHROPIC_API_KEY` on a trusted machine) and sign off. See `docs/superpowers/runbooks/voice-quality-launch-gate.md`.
- [ ] **Production tsc green** on the launch commit.

### Important (fix soon after launch if not before)
- [ ] **Payment audit events** — `recordPayment` emits no audit. Compliance-relevant.
- [ ] **Double-booking exclusion constraint** — race condition under concurrent bookings.
- [ ] **In-process cron sweeps** — fine for single instance; constraint until leader-lock lands.

### Ops (founder)
- [ ] Domain decision (`fieldly.app` recommended)
- [ ] DNS + TLS for `fieldly.app`, `api.fieldly.app`, `app.fieldly.app`
- [ ] Clerk application URLs &amp; allowed origins updated for new domain
- [ ] Stripe product + recurring price ($297/mo, 14-day trial)
- [ ] Production env vars set on Railway (full list in
      `2026-06-03-fieldly-launch-day-runbook.md` §Day 2)
- [ ] Sentry alerting to founder phone wired
- [ ] Warm contact list of 20 ready for Day 3 cold-email push

---

## Commit log (this session)

```
4da9df8 chore(rebrand): finish ServiceOS→Fieldly cleanup pass
dd7eae5 docs(launch): launch-day operational runbook
08c2707 fix(onboarding): seed default AI model on tenant creation
fd5e6a3 docs(launch): launch-day posts (X/LinkedIn/Reddit/email) + README rebrand
934045e feat(launch): public landing page, GTM brief, rebrand to Fieldly
83b50e7 fix(web): remove mock-data fallback from public estimate page
```

All on branch `claude/gallant-hypatia-D6GAv`. Not yet pushed.

---

## How to verify what's done

```bash
# Build gate (must be exit 0 before push)
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/web && npx vite build

# Test suites for the surfaces we touched
cd packages/api && npx vitest run \
  test/settings \
  test/webhooks \
  test/ai/agents/customer-calling/escalation-summary-builder.test.ts

# Visual smoke test (requires VITE_CLERK_PUBLISHABLE_KEY in env.js)
cd packages/web && npm run dev
# Open http://localhost:5173 in a browser; you should see the
# Fieldly landing page when signed out, the dashboard when signed in.
```
