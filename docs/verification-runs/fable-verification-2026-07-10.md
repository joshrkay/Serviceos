# Fable-Orchestrated Full-App Verification — Results

**Date**: 2026-07-10
**Branch**: `claude/fable-app-verification-rmbfty`
**Orchestrator/Reviewer**: Claude Fable 5
**Executors**: Opus 4.8 (complex/diagnostic + fixes), Sonnet 5 (mechanical UI + suite)
**Plan**: `fable-orchestration-plan-2026-07-10.md`
**Evidence**: `fable-2026-07-10-artifacts/` (72 full-page screenshots) + real-DB assertions

---

## Verdict

**CONDITIONAL GO for the verified workflows.** Every core PRD promise —
AI answers inbound calls, the quoting engine grounds prices to the catalog,
proposals are human-gated and never auto-executed, the money loop runs
lead-to-cash, customer communication and SMS approval work, and tenant
isolation holds — was exercised end-to-end against a **real Postgres**
stack with screenshot + database evidence, not mocks.

Verification found **one P0** (every inbound-voice proposal was silently
dropped on Postgres) plus a cluster of medium/low defects. **8 of them are
fixed, reviewed, tested, and on this branch** (six commits; the T4 frontend
commit carries three). Three items are documented
for owner decision (regulatory + posture) rather than auto-fixed. Two are
PRD-coverage gaps (unbuilt features).

The unit-test baseline (11,041 tests) was green *before* this run — which is
exactly why runtime verification mattered: the P0 lived under that green
baseline because in-memory repositories don't enforce the foreign key that
production Postgres does.

---

## How it was run (model delineation)

Per the plan and CLAUDE.md's orchestrator/executor split (the local Gemma
executor is unreachable in this cloud container, so Anthropic models filled
the executor role):

- **Fable 5 — orchestrator/reviewer.** PRD synthesis, thread design,
  adversarial re-verification of every FAIL (the voice P0 was independently
  confirmed by two Opus threads *and* re-checked against source by Fable
  before a fix was queued), fix-diff review against Core Patterns, and this
  verdict. Fable ran no mechanical steps itself.
- **Opus 4.8 — complex executors + fixers.** Voice-intake (signed Twilio
  webhooks), catalog-grounding assertions, the money loop, SMS approval,
  tenant isolation, and all six bug-fix worktrees.
- **Sonnet 5 — mechanical executors.** CRM/scheduling UI drives, settings,
  and the build+suite baseline.

Delineation rule applied: Fable is *not* the right tool for parallel,
recipe-bound evidence collection — that's Opus/Sonnet work. Fable's
irreplaceable contribution is the plan, the adversarial review, and the fix
reviews.

## Environment (hermetic, this container)

Railway dev is unreachable from the sandbox (`403 Host not in allowlist`),
so the whole run was local: real PostgreSQL 16 + pgvector (231 migrations),
API on real Pg repos, Vite test-auth SPA, a scripted OpenAI-compatible LLM
stub, signed Twilio webhooks against a fake auth token, and Noop delivery
providers (the dispatch/audit row is the contract). Full-page Chromium
screenshots throughout.

---

## Workflow results

| Thread | Workflow | Verdict | Evidence |
|---|---|---|---|
| T0 | Onboarding wizard (identity→pack→phone→billing→ai-check→test-call) | PASS + 1 bug | `t0-*` |
| T1 | AI inbound voice → intent → proposal | **P0 found** (proposals dropped); classify/confirm/safety PASS | `t1-*` |
| T2 | AI quoting + catalog price grounding | PASS (guarantee holds) + 1 medium | `t2-*` |
| T3 | Approval → execution → public approval/pay → paid | PASS (full money loop) + 1 medium | `t3-*` |
| T4 | CRM + scheduling data accuracy + tenant-tz | PASS + 3 bugs | `t4-*` |
| T5 | Comms surfaces + SMS approval transport (N-001) | PASS + 1 low | `t5-*` |
| T6 | Digest, settings, guardrail config | PASS (pack-wipe regression FIXED) + 2 gaps | `t6-*` |
| T7 | Tenant isolation + webhook signatures + RLS posture | Isolation PASS; TCPA gate OPEN; RLS dormant | (API logs) |
| T8 | Prod build + unit/handler suites | PASS (11,041 tests, 0 fail) | logs |

### What the AI actually does on a call (clarifying the premise)
The inbound call **captures intent** (classify → readback → explicit caller
confirmation) and hands a human the priced draft; the **catalog-grounded
quote is built on the operator/assistant side**, where grounding was
verified working (LLM's $9,999 → catalog $8,500; uncatalogued line capped to
0.5/low with a marker; never auto-approved). This trust posture is correct —
no unreviewed LLM price enters via voice — but the priced quote does not
happen *on* the call itself.

---

## Bugs found

### Fixed, reviewed, tested, on this branch

| ID | Sev | Bug | Fix commit |
|---|---|---|---|
| BUG-T1-1 | **P0** | Telephony path fabricated `aiRunId: uuidv4()` → `proposals_ai_run_id_fkey` violation → **every inbound-voice proposal silently dropped on Postgres**; caller escalated with nothing captured. Mocked repos hid it. | `45d7dd7` |
| BUG-T1-3 | Med | `customers.phone_normalized` keeps the leading `1` but the caller-ID lookup strips it → every `+1` E.164 customer invisible to inbound caller-ID. | `5f97649` |
| M1 | Med | `/api/estimates/suggest` built `EstimateTaskHandler` with no catalog repo → AI-suggested prices bypassed catalog grounding on a primary surface. | `5ba87c2` |
| T4-1 | High | `AppointmentEdit` rendered start/end in browser-local tz (wrong time and day) — the known tz-leak bug, still live on this one page. | `7e2cadf` |
| T4-2 | Med | Job "Agreed total" showed a pre-tax subtotal ($353) instead of the estimate's real tax-inclusive total ($381.24). | `7e2cadf` |
| T4-3 | Low | Hardcoded "Est. 2–3 hours" string ignored the real appointment duration. | `7e2cadf` |
| T0-BUG-1 | Med | Onboarding un-completable in any Twilio-less env: provisioning worker skipped silently, so the phone step stayed `current` forever. | `90d0ca2` |
| L2 | Low | `GET /api/interactions/:id` cast a malformed id to uuid in SQL → 500 instead of 400. | `4875e8f` |

Each fix ships with tests in the same commit; the two voice fixes are pinned
by **real-Postgres integration tests** (the mocked-DB blind spot that hid the
P0). `tsc --project tsconfig.build.json --noEmit` is clean on the branch.

### Documented for owner decision (not auto-fixed)

- **TCPA/DNC consent gate — OPEN (HIGH, regulatory).** `checkOutboundConsent()`
  has zero production call sites; the outbound path honors the DNC opt-out
  list but not TCPA express consent. Wiring a compliance gate is a
  product/legal decision, not a mechanical fix.
- **RLS is dormant at runtime (posture).** The app connects as a superuser
  principal with `RLS_RUNTIME_ROLE` off, so DB-level RLS is inert and
  isolation rests entirely on app-layer `tenant_id` filters (which tested
  clean). Matches the prior 2026-06-25 finding; activating `rls_app_runtime`
  is an ops decision.
- **Stripe webhook swallows non-payable status as silent 200 (MEDIUM, money
  path).** A `checkout.session.completed` for a draft invoice would ACK
  success yet leave it unpaid. Not exploitable today (checkout disabled).
  Money-path change — flagged for review per the repo's HELD-FOR-REVIEW
  convention.

### Follow-up fix candidates (confirmed, deferred for scope/safety)

- **BUG-T1-2 (P1):** the `ask_caller` state isn't handled on the Gather/PSTN
  adapter (only the media-streams path), so unknown callers loop forever.
  Deferred because it edits `twilio-adapter.ts` (same file as the P0 fix) and
  is a larger live-FSM change — land after the P0.
### PRD-coverage gaps (unbuilt features, not defects)

- **N-005 digest reflection sections** ("what I wasn't sure about" / "what I
  learned today") and a "quotes sent" field are absent from the digest
  payload shape.
- **N-011 brand voice** exists as a `tenant_settings.brand_voice` DB column
  but has no frontend to capture it.

### Regressions re-checked — all confirmed FIXED
`proposals.claimed_by` type (approve→execute works), batch-approve 400,
AI-estimate NaN totals, appointments-in-browser-tz (fixed on
Schedule/Home/JobDetail), settings-save wiping vertical packs, and the
`GET /api/interactions` 500.

---

## Money & data-accuracy invariants (spot-checked live)
Integer cents everywhere (`999900 → $9,999.00`, `38124 → $381.24`,
`41040 → $410.40`), tenant-tz day bucketing correct under an
Australia/Sydney browser, tenant_id present and isolation enforced,
audit rows emitted on transitions. No float drift, no NaN, no cents-render
bug on the public pay/approve pages.
