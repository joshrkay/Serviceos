# Jobs & Invoicing — Competitive Parity Roadmap (AI-First Idiom)

*Audit + roadmap. Companion to `day-in-the-life.md` and `roadmap-audit.md`. Schema verified to migration 136.*

## Why this exists

We need our jobs and invoicing workflows on par with — ideally better than — Jobber and ServiceTitan. This roadmap is the output of a full audit (current invoicing code, current jobs/scheduling code, and a 2025–2026 competitor breakdown) reconciled against the actual codebase.

**The decision that shapes everything.** Our thesis (`day-in-the-life.md`, PRD) rejects the "open-the-app, manage-a-console" model: *AI runs the back office; the owner approves via SMS in ~30 seconds/day; the end-of-day digest is the dashboard.* So we pursue **AI-first workflow parity** — match competitors' job→invoice→payment *capabilities and money mechanics*, but deliver each through our idiom: a typed **Proposal** the owner one-taps via SMS, a **digest** line, and thin web UI for audit/config — never a standalone admin console.

**Non-obvious finding.** We are closer than the strategy docs imply. Already built: dispatch board with drag-drop→proposals, technician availability/feasibility, tiered e-sign estimates, deposits + deposit-credit, refunds + NSF/chargeback reversals, Stripe links/intents + public pay page, an overdue sweep, and **live recurring service agreements that auto-generate jobs + draft invoices**. Separately, much of the remaining parity surface *already has written gap stories that were never built* (equipment registry P13-002, parts P14, QuickBooks/calendar/refunds P15, geofence-ETA/signature P12-003/004, dispatch drag-drop P6-025..028). So this is part "sequence what's specced," part "write the white-space."

## Current-state matrix (jobs + invoicing)

| | Items |
|---|---|
| **✅ Built — leverage** | lifecycle + per-job `money_state`, dispatch board drag-drop→proposals, availability/feasibility, tiered e-sign estimates + reminder/expiry workers, invoices (partial payments, refunds, **reversals**, deposit credit), Stripe links/intents + public pay page, overdue sweep + single dunning notice, **recurring agreements → auto job + draft invoice (live worker)**, customers + service locations, job photos, time tracking, GPS pings, AI drafting behind the proposal gate, **Stripe Connect** |
| **📝 Specced, not built — sequence** | `P6-025..028` dispatch drag-drop wiring + "I'm out"; `P12-003/004` geofence-ETA + signature; `P13-002` equipment registry; `P15-001/002/003` QuickBooks + calendar sync + refunds/store-credit |
| **🆕 White-space — write new** | auto-invoice on completion; progress/milestone + batch invoicing; late-fee + multi-step dunning cadence; consumer financing; tips/surcharges; tap-to-pay; auto-pay; invoice/estimate PDF; AI dispatch auto-assignment; route optimization; field PWA + multi-visit jobs |

(Out of scope per positioning: full inventory `P14`, multi-stakeholder portal, standalone dashboards, owner-facing route-planning console.)

## Guiding principles (every story)

1. **AI-first delivery** — each capability shows up as a one-tap Proposal (SMS), a digest line, and/or thin audit/config UI. Customer transactional comms (reminders, ETA texts, receipts) are autonomous; anything touching money or scope routes to the owner.
2. **Reuse settled patterns:**
   - **Proposal three-place ritual** — new automated actions become a `ProposalType` added in lockstep to the union + exhaustive `actionClassForProposalType` switch in `proposals/proposal.ts` (omitting classification is a *compile error*), the enum in `shared/src/enums.ts`, and `PROPOSAL_TYPE_SCHEMAS` in `proposals/contracts.ts`. Money/comms/irreversible classes never auto-approve (`decideInitialStatus`).
   - **Workers** — sweeps wired in `app.ts` via `registerInterval` + `runAsLeader(SWEEP_LOCK.x)`; reaction jobs via the `workerRegistry` queue. New sweep lock keys reserve `590007`+.
   - **Idempotency** — the `service_agreement_runs` shape (`(tenant, entity, period) UNIQUE`, swallow `23505`) templates every dedup table.
   - **Webhook base (P0-014)** — external settlement/sync (Wisetack/Affirm, QBO, Stripe Terminal) = a new `router.post('/<source>')` + `event.type` branch in `webhooks/routes.ts`; settlements reuse `invoices/payment.ts recordPayment` + money-state rollup.
   - **Extend, don't add** — Stripe **Connect** (mig. 087) underlies tap-to-pay/financing/auto-pay; the encrypted-OAuth-token pattern (mig. 084/085 + `crypto.ts` + `oauth_states`) underlies QBO; `scheduling/feasibility.ts` + `scheduling/travel-time/` + the `SkillMatcher` interface underlie AI-dispatch and route-opt.
   - **Money/billing** — `shared/billing-engine.ts` (integer cents, tax in bps, tiers); `invoices/deposit-credit.ts` is the seed for progress splitting.
3. **Conventions** — every table `tenant_id` + RLS (`current_setting('app.current_tenant_id')::UUID`) + FORCE RLS; integer cents; UTC stored / tenant-tz rendered; audit on every mutation; AI via the LLM gateway; migrations additive & sequential (next: **135**); build verification **always** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run <tests>`.

## Wave plan (story phases P20–P27)

| Wave | Theme | Clusters → story group |
|---|---|---|
| **0** | Shared leaf | PDF renderer (`P23-004`) — financing/QBO/email all want it |
| **1** | "Cash collects itself" (no external deps) | C1 auto-invoice + dunning (`P20`), C2 progress + batch invoicing (`P21`) |
| **2** | "The truck is the office" | C5 equipment registry (`P24`), C7 field PWA + multi-visit + on-site invoicing (`P26`) |
| **3** | "Every way to get paid" (external, on webhook base) | C3 financing/tips/surcharges/tap-to-pay/auto-pay (`P22`), C4 QuickBooks sync (`P23`) |
| **4** | "Jenna's 90-minutes-saved" | C6 AI dispatch assignment (`P25`), C8 route optimization + GPS ETAs (`P27`) |

Detailed Wave-1 specs: see `docs/stories/phase-20-stories.md`. Clusters 3–8 follow the same story format; the per-cluster framing, data-model sketches, reuse anchors, and external-dependency/risk table are captured in the engineering plan that produced this roadmap.

**Cluster framings (one line each):**
- **C1 (P20):** job→`completed` fires a `draft_invoice`+`send_invoice` proposal; the overdue sweep walks a configurable reminder cadence + accrues late fees; outcomes summarized in the digest.
- **C2 (P21):** *"Bill 50% now, balance on completion? [Yes]"* mints linked milestone invoices; batch is a morning digest nudge fanning out N `draft_invoice` proposals.
- **C3 (P22):** financing offered inside the estimate; tips/surcharges as pay-page toggles; tap-to-pay as a field button; auto-pay as a digest confirmation. All settlement on the webhook base; extends Stripe Connect.
- **C4 (P23):** QBO is invisible plumbing (queue-driven sync worker); the only owner moment is a digest "synced ✓ / 1 failed — Retry?"; PDFs auto-attach to sends.
- **C5 (P24):** equipment captured conversationally (`add_equipment` proposal); next visit the AI says *"the Carrier unit you serviced in May"* — the HVAC differentiator.
- **C6 (P25):** *"Assign Carlos (closest + certified, 2 jobs today)? [Yes][Pick another]"* — a ranked `assign_technician` proposal on top of `checkFeasibility`.
- **C7 (P26):** multi-visit = multiple appointments under one job; a thin offline-capable field PWA with "I'm out" + on-site invoicing/tap-to-pay.
- **C8 (P27):** *"This route saves 90 min — Approve? [Show me]"*; customers get automatic ETA texts from the GPS pings we already store.

## Reconciliation with existing stories
Mark superseded/refined to avoid duplication: `P13-002`→P24, `P15-001`→P23, `P12-003`→P27-003, `P12-004`→P26 (signature), `P6-025..028`→largely built (verify; fold "I'm out" into P26-002). `P15-002` (calendar) and `P15-003` (refunds/store-credit) stay adjacent. `P14` (full inventory) deferred.

## External dependencies & risk
| Dependency | Cluster | Risk | Plug-in |
|---|---|---|---|
| Stripe Connect | C3 | Low — integrated (mig. 087); reader/entitlement is an ops gate | existing Connect + `payment_intent.*` branches |
| Wisetack/Affirm | C3 | Med — merchant onboarding; one provider port | `/wisetack` webhook → `recordPayment` |
| Stripe Terminal | C3 | Med — tokens + reader provisioning | settlement reuses existing branch |
| QBO OAuth2 | C4 | Med-High — Intuit app review, rate limits | mig. 084/085 + `oauth_states` + queue worker |
| Google/Mapbox Directions | C8 | Low — optional; haversine fallback exists | provider swap in `scheduling/travel-time/` |
| PDF render | C4 | Low — server-side, deterministic | new `documents/*` leaf |

## Verification / E2E strategy
Per-story gate (mandatory); proposal-gate classification tests for each new type; idempotency tests for each new dedup table + webhook; money-conservation tests (integer cents); RLS smoke per table; one journey E2E per wave through the SMS/digest surface (snapshotting `fixtures/ai/golden-proposals`); a digest-assembly test so the "dashboard" stays truthful.

*Scope guardrail: every story must move a Mike/Jenna day-in-the-life moment. If it forces the owner into a console for >30s, it's the wrong surface.*
