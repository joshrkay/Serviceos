# Sprint backlog — 2026-06-11 (1–2 sprints, JTBD-mapped)

Drafted after shipping catalog-grounded AI pricing (P22), entity-resolver
wiring (P8), and mobile estimate-approval hardening on
`claude/tender-hamilton-pjhcbv`. Ordered by owner-impact per engineering
day, with the persona lens applied (glove-on, truck-based, phone/SMS
native, risk-averse): every item must reduce screen time or protect
money/trust, and every human touchpoint must be one tap.

## Shipped 2026-06-14 (this session)

- **P2-034 SMS one-tap approval — INBOUND shipped.** Owner replies
  APPROVE/YES or REJECT/NO (optionally with a short code) and the existing
  approveProposal/rejectProposal lifecycle runs (`src/sms/proposal-approval/`).
  Registered live; reuses webhook signature + MessageSid dedup. 31 tests.
  **Remaining:** (a) auto-notify trigger — decide WHEN to text the owner
  (no `ready_for_review` notifier worker exists yet; the
  `sendProposalApprovalRequest` composer is ready to call); (b) EDIT-over-
  SMS (multi-turn / voice-memo MMS).
- **Voice-transcription robustness for the catalog money path (P3).**
  Squashed-string matching + filler stopwords; new 29-case corpus. Noisy
  Whisper joins/fillers now price correctly; residual hard cases defer to
  one-tap confirm, never silent mispricing.

## Production-safety audit (2026-06-14) — correcting a false alarm

A safety sweep flagged "RLS enabled-but-not-FORCEd on 11-29 tables
(users, audit_events, conversations…)" as a CRITICAL launch blocker.
**This is false.** Ground truth from `db/schema.ts`: 76 tenant-scoped
tables have RLS ENABLEd and all 76 are FORCEd (the cited core tables are
forced in a later batch migration). The earlier count was a duplicate-
line artifact (two tables are defined across two migrations). Webhook
idempotency, Stripe/payment idempotency, and emergency-dispatch gating
are all SOLID. **The one genuine gap:** no DB-level exclusion constraint
on `appointments` (double-booking is prevented in app logic + held-slot
flow, but a concurrent execution race is theoretically possible). Fixing
it = an `EXCLUDE USING gist` constraint over the tech + time range; it
MUST land with the Docker-gated `rls-tenant-isolation`-style integration
test, so it's deferred to a Docker-enabled run (the registry is blocked
in web sessions).

## Sprint 1

1. **P2-034 auto-notify trigger** (JTBD #7) — the remaining half of SMS
   approval: text the owner `sendProposalApprovalRequest` when a proposal
   lands in `ready_for_review` and the tenant opts in
   (`tenant_settings.unsupervised_proposal_routing`), with a non-annoying
   cadence + owner-resolution + dedup. Makes one-tap approval fire end to
   end instead of relying on the "single pending" inbound path.
2. **P2-035 markers — confidence markers on proposal renders** (JTBD #7).
   The `pricingSource: 'uncatalogued' | 'ambiguous'` and
   `catalogResolution` candidates now exist on draft payloads; surface
   them as one-line "what I wasn't sure about" markers on the proposal
   card (and the SMS tail-line once P2-034 lands). Zero new data needed.
3. **Review-UI picker for `ambiguous_entity` clarifications + ambiguous
   catalog lines** (JTBD #2, #5). The backend now emits candidate lists
   (`entityCandidates`, `sourceContext.catalogResolution`); the inbox
   card should render them as one-tap choices that patch the draft and
   move it to ready_for_review. Until then operators resolve by editing
   fields manually.
4. **Estimate entity-kind resolution** (JTBD #2). The entity resolver
   still skips `kind: 'estimate'` (no trigram index on estimates).
   Additive migration + resolver method, mirroring invoices.

## Sprint 2

5. **Voice-quality Layer-2 corpus authoring** (JTBD #1, #2, #5). The two
   `.skip`ed Layer-2 suites are waiting on corpus scripts. Author them,
   including catalog-pricing scenarios ("invoice the Hendersons for a
   condenser coil and two hours labor" → seeded catalog price asserted)
   — the `text-mode-driver` already accepts a `catalogRepo`.
6. **End-of-day digest → SMS** (JTBD #7, #10). Digest worker exists;
   route through the P2-034 transport with one-tap "APPROVE ALL"
   (delegates to the existing batch endpoint).
7. **Capacitor on-device voice spike** (JTBD #12 Field Tech). Time-boxed:
   wrap packages/web, evaluate on-device STT push-to-talk vs. the phone
   dial-in path for techs with gloves.
8. **Settings stub closure, highest-traffic three** (JTBD #7): Reminders,
   Payment methods, Deposit rules — `SettingsPage.tsx` still has
   `action: () => {}` handlers for 8 rows.

## Standing quality gates (every story)
- Dead-code removal in the same PR; no "wired later" stubs.
- `npx tsc --project tsconfig.build.json --noEmit` + unit + integration
  + (UI) Playwright viewport tests green before review.
- JTBD + persona impact stated in the PR description.

## JTBD coverage map (post-2026-06-11 state)
| JTBD | State | Biggest remaining gap |
|---|---|---|
| 1 Intake & Booking | Strong (voice FSM, caller-ID, booking holds) | Streaming STT latency (Phase 8B) |
| 2 Estimating | Strong + catalog-grounded (new) | Ambiguity picker UI; estimate entity resolution |
| 3 Scheduling | Strong (conflict checker, holds, compensation) | Voice ETA updates |
| 4 Job Execution | Partial | Voice checklists, MMS photos |
| 5 Invoicing & Payments | Strong + catalog-grounded (new) | Voice payment reminders |
| 6 Customer Mgmt | Good (AI replies, feedback) | Recurring voice scheduling |
| 7 Admin Reduction | **Weakest high-value area** | SMS one-tap transport (P2-034), digest-to-SMS |
| 8 Accounting | Partial (CSV) | QuickBooks sync (long pole, Wave 3) |
| 9 Marketing & Reviews | Good (Google reviews, drafts) | Campaign approve/send via SMS |
| 10 Reporting | Good (voice lookups) | Voice metric summaries in digest |
| 11 Emergencies | Good (emergency dispatch intent) | Live dial-override drill test |
| 12 Field Tech | Improved (mobile approval fixed) | Capacitor on-device voice |
