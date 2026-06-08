# ServiceOS — Launch-Readiness Report

Branch: `claude/vibrant-pascal-eeyK1` · Base: `0749cfe` · Date: 2026-06-08

This pass adapted a generic launch-readiness directive to the repo's real shape
(npm workspaces — not pnpm; voice lives in `packages/api` — there is no
`packages/voice/`; telephony is Twilio — not Vapi; canonical migrations are
in-code in `packages/api/src/db/schema.ts` — there is no `supabase/migrations/`).
Several "completion conditions" were already satisfied; the rest were built.

## SHIPPED features (commit SHAs)

| # | Feature | What shipped | Commit |
|---|---------|--------------|--------|
| 1 | Inbound call handling | Fixture-driven intent test mapping the classifier onto the launch taxonomy (schedule_appt/request_estimate/check_status/reach_human/unknown) at the 0.6 threshold + low-confidence→human-fallback; `/api/voice/*` auth-posture test (already Clerk-gated; Twilio webhook `/api/telephony` is signature-verified). | `600d9d0` |
| 2 | Voice → slot extraction | New strict Zod `voiceSlotsSchema` + `extractLaunchSlots()` + `planSlotFollowup()` (re-ask cap of 2 → human handoff), driven by 8 transcript fixtures. | `3273071` |
| 3 | Appointment scheduling | Conflict-free per-tech slot-proposal test (busy tech never offered its booked window; free tech is — per-tech isolation; business-hours bounded). | `20b4a63` |
| 4 | Estimate generation | Billing-engine totals test across 4 golden estimate fixtures (subtotal = Σ line items; total = subtotal − discount + tax) + schema-valid draft with sendable view token. | `7eb0029` |
| 5 | Estimate → Job conversion | **NET-NEW** `POST /api/jobs/from-estimate/:estimateId`: reuses the estimate's existing job, assigns a tech by availability (operator override supported), creates appointment + primary assignment, syncs `assignedTechnicianId`, flips estimate→accepted (idempotent), compensating-cancel on failed assign. | `f2222e0` |
| 6 | Job → Invoice generation | **NET-NEW** `recalculateLaborFromTimeEntries()` wired into auto-invoice behind opt-in `tenant_settings.bill_labor_from_time_entries` (migration 146); labor billed from actual logged hours, estimate-as-is when no time tracked; new `findByJob` time-entry finder. | `b156523` |
| 7 | SMS confirmations | **NET-NEW** `PerTenantTwilioDeliveryProvider` routing notification SMS through each tenant's own Twilio subaccount (`getTenantTwilioCreds`), failing closed when a tenant has no creds; email + tenantless SMS delegate to the global provider; wired in `app.ts`. | `2722071` |
| 8 | Multi-tenant RLS | No new tenant table; additive column on already-RLS-protected `tenant_settings`. Static RLS invariants pass (`schema.test.ts`). Migration 146 locked into the immutability snapshot; `test:rls`/`test:voice-fixtures` aliases added. | `c9a5536` |

## DEFERRED features (reason + effort)

- **External calendar sync (Google/Outlook)** for scheduling — out of scope; the
  Postgres `appointments` table is the calendar. *Effort: ~1–2 wk integration.*
- **Multi-labor-line time-entry recalculation** — Feature 6 auto-adjusts only the
  unambiguous single-labor-line case; multiple labor lines are billed as-estimated
  to avoid an opinionated split. *Effort: ~1 d once a split policy is chosen.*
- **Per-tenant SendGrid (email) credentials** — Feature 7 scopes SMS per tenant;
  email stays on the global account. *Effort: ~0.5 d, mirrors the SMS factory.*
- **Live integration/RLS run** — BLOCKED by environment, not deferred by choice
  (see BLOCKED.md). Re-run `npm run test:integration` / `test:rls` on a runner with
  Docker registry access.

## BLOCKED features (diagnosis)

- **`test:rls` / `test:integration`** — testcontainers cannot pull
  `pgvector/pgvector:pg16` or `testcontainers/ryuk:0.14.0` (registry CDN returns
  **403 Forbidden**) in this sandbox. Full diagnosis + clearance steps in
  **BLOCKED.md**. Static RLS + schema-invariant tests pass without a DB.

## Test coverage delta (per package)

| Package | Before | After | Δ |
|---------|--------|-------|---|
| api (unit, `vitest run`) | 5943 passed / 612 files | 5991 passed / 619 files | **+48 tests, +7 files** |
| web | 1050 passed | 1050 passed | 0 (untouched) |
| shared | 49 passed | 49 passed | 0 (untouched) |

New launch tests reference each feature by name: `intent-classifier.launch-fixtures`,
`voice/launch-slots`, `scheduling/appointment-scheduling.launch`,
`estimates/estimate-generation.launch`, `jobs/from-estimate.launch`,
`invoices/invoice-from-time-entries.launch`,
`notifications/per-tenant-twilio-delivery-provider`.

## Voice fixture pass rate (intent classification)

5 of 5 launch transcripts classify to the expected intent ≥ threshold
(`schedule_appt`×2, `request_estimate`, `check_status`, `reach_human`), plus the
low-confidence transcript routes to the human fallback (`unknown`). Slot
extraction validates 8/8 transcript fixtures against the Zod contract.
`npm run test:voice-fixtures` → **13 passed**.

## RLS verification summary

- 79 tables `ENABLE`+`FORCE ROW LEVEL SECURITY`, each with a
  `tenant_isolation_<table>` policy; documented exempt set unchanged (2).
- Static guards (`test/db/schema.test.ts`, 17 tests) and the migration
  immutability snapshot **pass**.
- This pass introduced **no new tenant table**; the one added column sits on the
  already-protected `tenant_settings`, so tenant isolation is unchanged.
- Live cross-tenant isolation test (`rls-tenant-isolation.test.ts`) is
  environment-blocked from running here — see BLOCKED.md.

## Verifier results (this environment)

| Gate | Result |
|------|--------|
| `npm run typecheck` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 |
| `npm run test` | ✅ exit 0 (api+web+shared) |
| `npm run test:voice-fixtures` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 |
| `npm run test:rls` | ⛔ env-blocked (Docker 403) |
| `npm run test:integration` | ⛔ env-blocked (Docker 403) |
| changes vs branch base in-scope only | ✅ (packages/api, fixtures/ai, package.json, reports) |

Note: `git diff main --stat` shows many out-of-scope files, but those are
**pre-existing divergence** on this long-lived feature branch (rebrand, PostHog,
landing page, onboarding, billing) — not part of this pass. `git diff 0749cfe`
(the branch base for this work) shows only in-scope changes.

## Top 3 risks to review before cutting the release

1. **Integration/RLS not exercised here.** Re-run `npm run test:integration` and
   `npm run test:rls` on CI (Docker registry access) before release — especially to
   confirm migration 146 applies and tenant isolation holds end-to-end.
2. **Per-tenant SMS in production.** `getTenantTwilioCreds` throws for a tenant
   with no `tenant_integrations` row in prod; the new provider turns that into a
   fail-closed skip. Verify every live tenant has a provisioned Twilio row, or
   confirmation SMS will be silently skipped (logged, not sent).
3. **Estimate→Job tech assignment depth.** Skill-based narrowing is a no-op until a
   real `SkillMatcher` exists (currently a stub), so auto-pick is "first available
   technician." For skill-critical trades, require the operator `technicianId`
   override until a Pg matcher ships.
