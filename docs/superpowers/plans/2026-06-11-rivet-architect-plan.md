# Rivet — Voice-First AI Back-Office Implementation Plan (v7, Architect Mode)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Tasks use checkbox (`- [ ]`) syntax for tracking. Each atomic task below (RV-###) is sized for one implementation agent; before coding a task, the agent MUST read the named files and follow repo conventions in `CLAUDE.md` (integer cents, RLS on every new table, proposals gate every mutation, TDD).

**Goal:** Extend the existing Serviceos platform into Rivet — a voice-first, multi-tenant back-office where the owner runs the day via voice + SMS, every high-stakes action passes the typed Proposal gate, and photo→job/invoice flows match or beat Jobber.

**Architecture:** Everything builds on three existing pillars: (1) the Proposal execution gate (`packages/api/src/proposals/`) — all new mutations become new proposal types, never direct writes; (2) the voice FSM + AI Gateway (`packages/api/src/ai/`) — new voice capabilities are new intents/task-handlers/skills, graded by the cassette-based voice-quality launch gate; (3) GUC-based RLS multi-tenancy (`packages/api/src/db/schema.ts`, `pg-base.ts`) — every new table gets `tenant_id` + RLS policy, every repo extends `PgBaseRepository`.

**Tech Stack:** Node/Express + Postgres (Railway), React 18 + Vite + Tailwind 4, Clerk auth, Twilio voice/SMS (+ Deepgram/ElevenLabs media streams), Stripe, S3 presigned uploads, Zod contracts, Vitest + Playwright (qa-matrix), PgQueue workers.

---

## 1. Executive Summary

Rivet's promise — *"the tradesperson does the work; we handle the business and admin"* — is closer than the spec assumes. The Serviceos codebase already contains a production-grade typed Proposal system (44 proposal types, 9 lifecycle states, idempotent executor, append-only audit), three working approval channels (UI, SMS reply Y/N, HMAC-signed one-tap links), a 13-state voice FSM with intent classification, **already-implemented Entity Resolver and Catalog Resolver**, dropped-call SMS recovery, per-tenant brand-voice config, maintenance agreements with auto-invoicing, time tracking, job photos with S3 presigned upload, and a token-gated customer portal. Multi-tenancy is enforced at three layers (Postgres RLS via `app.current_tenant_id` GUC, AsyncLocalStorage request context, tenant-prefixed S3 keys).

**What is genuinely missing**, and what this plan builds, in priority order:

1. **Photo & Document Management to Jobber parity and beyond (Workflow 23 — highest priority).** Job photos exist (`job_photos`, presign→PUT→attach, camera capture in `AddEntrySheet.tsx`), but there is no invoice/estimate photo attachment, no annotation, no before/after pairing UI, no offline upload queue, no Client Hub visibility control, and no voice-driven attach ("attach these photos to the Henderson invoice").
2. **Voice as a first-class approval channel.** Today the owner can approve via UI, SMS "Y", or one-tap link — but not by voice. This is the single biggest gap against Rivet's thesis.
3. **Supervisor Agent** — a tenant-scoped policy brain that watches live calls and the proposal queue, enforces budgets/guardrails, decides escalation vs. auto-approval routing, and detects brand-voice deviation. Today `isSupervisorPresent()` is just a presence check.
4. **End-of-Day Digest** — does not exist; it is the "close the laptop" payoff and is cheap to build on existing data.
5. **Confidence Markers surfaced end-to-end** — confidence exists internally (τ_int=0.75, τ_ent=0.80, guardrail levels in `ai/guardrails/confidence.ts`) but is not rendered in proposal SMS/UI as a consistent marker system.
6. **Business depth features that don't exist at all:** QuickBooks/Xero sync, route optimization (travel-time provider exists; no optimizer), custom forms/checklists, payroll export, advanced reporting beyond the money dashboard, per-tenant feature flags (today flags are platform-global — a real multi-tenancy gap).
7. **Hardening of partially-built safety features:** brand-voice *locking* + deviation detection (config exists, lock/audit doesn't), correction loop with per-tenant learning (single-level correction exists), vulnerability triage owner patch-through (fields + triage rules exist; patch-through path incomplete), emergency fast-path (intent exists; needs end-to-end test + SOS coverage), media-streams ramp (built, feature-flagged off).

**Multi-tenant posture:** strong foundation, four concrete fixes required: per-tenant feature flags, RLS on `oauth_states`, per-tenant accounting credentials via the existing `tenant_integrations` secret-ref pattern, and explicit cross-tenant leak integration tests (none exist today).

**Differentiation vs. Jobber:** Jobber wins on mature mobile UX and Client Hub; Rivet matches the photo/Client Hub table stakes (Phases 0–1) and wins on what Jobber cannot do: a voice-run day (voice intake → voice quoting → voice approval → SMS fallback → end-of-day digest), typed-proposal safety with full audit, and per-tenant brand-voice enforcement.

---

## 2. Analysis of Existing Codebase

### 2.1 What exists and is solid

**Proposal system** (`packages/api/src/proposals/` — ~70 files):
- 9 statuses with explicit transition table (`lifecycle.ts:4-24`), 5-second undo window (D9), terminal-state guarantees.
- `executor.ts`: approval-status gate, undo-window block, idempotency via `proposal_executions` + pg advisory lock, crash-in-middle reconciliation, stale-executing reset with retry caps.
- 44 proposal types in 4 action classes (capture / comms / money / irreversible) — class determines auto-approve eligibility via exhaustive switch (`proposal.ts:225-322`, compile-error forcing function).
- Zod payload schemas per type (`contracts.ts`), handler registry (`execution/handlers.ts:461-614`).
- Chaining (`chain.ts`): multi-action utterances → ordered proposals with `$ref:chain[N].entityKind` symbolic refs resolved at execution; single-transaction `createMany()`.
- Audit: append-only `audit_events` with RLS; `proposal.created/approved/rejected/executed/one_tap_approved/...` events; `getProposalTimeline()`.
- Approval channels: UI (`actions.ts approveProposal`, RBAC `proposals:approve`), SMS reply Y/YES/OK/APPROVE (`sms/reply-handler.ts`, phone verified vs `tenant_settings.owner_phone`), one-tap HMAC link ≤30min TTL single-use nonce (`auto-approve.ts:115-252`, `routes/one-tap-approve.ts`), unsupervised routing (`routeUnsupervisedProposal()` → queue_only / queue_and_sms / escalate_to_oncall).
- Auto-approve thresholds per supervisor mode (0.9/0.92/0.95) with per-tenant override in `tenant_settings.auto_approve_threshold`.

**Voice layer** (`packages/api/src/ai/`, `telephony/`, `voice/`):
- Registry: `packages/shared/src/contracts/voice-assistants.ts` — V1–V9 inbound + VO1–VO5 outbound contracts with jurisdiction flags and allowed proposal types; integrity assertions.
- FSM: `ai/agents/customer-calling/` — 13 states, thresholds τ_int=0.75 / τ_ent=0.80, retry caps, escalation ladder; spec at `docs/superpowers/agents/customer-calling/flow.md`.
- Two call modes: Twilio Gather (default) and Media Streams (Deepgram STT + ElevenLabs TTS, barge-in, backpressure) behind `TWILIO_MEDIA_STREAMS_ENABLED` (P8-012).
- Intent classifier (25+ intents incl. lookup_* read-only skills), **Entity Resolver** (`ai/resolution/entity-resolver.ts`, wired into voice pipeline) and **Catalog Resolver** (`ai/resolution/catalog-resolver.ts` — caps confidence for uncatalogued prices, P22).
- Voice→action bridge: `workers/voice-action-router.ts` (56KB) — intent → task handler → `createProposal()`; multi-intent decomposition → chains (P9-016).
- AI Gateway (`ai/gateway/`): provider abstraction (OpenAI + OpenRouter fallback + mock), per-task routing config, resilience layers (cache/breaker/retry/deadline/failover), per-tenant tier quotas, cost tracking via `ai_runs`.
- Voice-quality harness: CassetteLLMGateway record/replay, Layer-1 graders (disposition/confidence/floor/experience), Layer-2 reports, CI launch gate (`voice-quality.launch-gate.entry.test.ts`), 40/40 corpus passing.
- Compliance: DNC list (`compliance/dnc.ts`, `tenant_dnc_list`), quiet hours / after-hours (`compliance/jurisdiction.ts`), recording disclosure skill (`ai/skills/disclose-recording.ts`, canonical text in `packages/shared/src/legal/recording-disclosure.ts`), transcript encryption (AES-256-GCM).
- Dropped-call recovery: `sms/recovery/dropped-call-handler.ts` + worker — T+60s SMS with suppression (callback happened, rate limit 1/5min) and PII-safe context cue.
- Per-tenant voice config: greeting, agent name, TTS voices (en/es), language detection, transfer number, on-call rotation, escalation settings, `brand_voice` JSONB, trial caps.

**Multi-tenancy** (`db/schema.ts` 206KB ~158 migrations, `middleware/tenant-context.ts`, `db/pg-base.ts`):
- RLS (`ENABLE`+`FORCE`, `tenant_id = current_setting('app.current_tenant_id')::UUID`) on 60+ tables.
- Request path: Clerk JWT (`tenant_id`, role) → `withTenantTransaction()` middleware → `SET LOCAL` GUC inside transaction → AsyncLocalStorage `{client, tenantId}` → repos reuse via `withTenant()`; GUC leak fix documented (`pg-base.ts:25-27`).
- Escape hatch is explicit-only: `withClient()` for global tables (vertical_packs, prompt_versions, platform flags).
- Webhooks never trust payload tenant: phone-number mapping, session map, payment-intent lookup, `/api/webhooks/twilio/sms/:tenantId` binding tests.
- Storage: shared S3 bucket, tenant-id-prefixed keys, `files` table metadata under RLS, presigned URLs (SigV4), `DevStorageProvider` for local.

**Domain & web:**
- Full CRUD + state machines: customers (consent, vulnerability fields m113), service locations, jobs (deposits, money_state), job_timeline_events, appointments (+assignments, no-double-booking m131, working hours m137, unavailable blocks m116), estimates (versioned revisions, view tokens, acceptance selection, approvals), invoices (dunning m136, schedules m139, batch m140, auto-invoice-on-completion m138), payments (Stripe intents + links, refunds/reversals), leads, expenses, notes, agreements (RRULE recurrence, auto job/invoice), time entries (m67, single-active constraint, bill-labor-from-time m151), catalog items / estimate templates / service bundles / vertical packs, reputation (google_reviews m101, draft public/private responses, PII redaction, service credits), feedback requests/responses, document_revisions + diff_analyses.
- Job photos: `job_photos` (m64) + `files`, service + routes (`routes/job-photos.ts`), web uploader (`JobPhotoUploader.tsx`, `AddEntrySheet.tsx` camera capture, categories before/after/problem/completion/other), 3-step presign→S3 PUT→attach (`web/src/api/job-photos.ts`).
- Portal (`/portal/:token`, m65 portal_sessions, bcrypt token hash): Overview / Estimates / Invoices / Jobs / Agreements / Book / Request service. Public token pages: `/e/:id` estimate approval (deposit-aware, 320px-tested), `/pay/:id` Stripe payment.
- Real-time: WS gateway (`ws/`, Zod frame protocol, priority queues, heartbeats) + SSE fallback (`useResilientStream`), dispatch board events/presence, escalation SSE.
- Workers: PgQueue (SKIP LOCKED, DLQ, idempotency keys), 19 workers (reminders, dunning, transcription, google reviews, recurring agreements, dropped-call, call-me-back, proposal-correction…).
- SMS: Twilio per-tenant subaccounts (`tenant_integrations` m70), templates S1–S10 contract (`shared/src/contracts/sms-templates.ts`), `proposal_sms_events` state (m156-158, edit sessions, reapproval renders), tech-status keyword router, STOP handling.
- Reporting: money dashboard (tenant-tz bucketing), revenue-by-source, tax CSV export.
- Deploy: Railway, multi-stage Dockerfile, pre-deploy migrations, `/health`, Sentry/PostHog/Prometheus.

### 2.2 Gaps (what this plan builds)

| # | Gap | Severity | Existing substrate to build on |
|---|-----|----------|-------------------------------|
| G1 | No voice approval channel (owner can't say "approve it") | Critical | SMS reply-handler pattern, `approveProposal()`, voice FSM, owner phone verification |
| G2 | Photos: no invoice/estimate attachment, annotation, before/after pairing, offline queue, portal visibility control, voice attach | Critical (W23) | `files` + `job_photos` + presign flow + AddEntrySheet camera |
| G3 | Supervisor Agent doesn't exist (only presence check) | High | auto-approve routing, escalation settings, AI gateway, audit events |
| G4 | End-of-Day Digest missing | High | money dashboard, proposals inbox, job timeline, workers, SMS templates |
| G5 | Confidence markers internal-only (not in SMS/UI consistently) | High | `ai/guardrails/confidence.ts` levels, proposal `confidence_score` |
| G6 | Per-tenant feature flags missing (platform-global only) | High (tenancy) | `pg-feature-flags.ts`, `tenant_settings` pattern |
| G7 | Accounting integrations (QBO/Xero) absent | High | `tenant_integrations` secret-ref pattern, webhook base, workers |
| G8 | Route optimization absent (travel-time provider exists) | Medium | `scheduling/travel-time/google-provider.ts`, location pings, appointments |
| G9 | Custom forms & checklists absent (only static intake form) | Medium | notes/files patterns, portal, job timeline |
| G10 | Payroll export absent (time entries exist) | Medium | `time_entries`, reports/CSV export pattern |
| G11 | Brand voice lock + deviation detection (config exists, lock/audit doesn't) | Medium | `tenant_settings.brand_voice`, BrandVoiceComposer, audit events |
| G12 | Correction loop single-level, no per-tenant learning | Medium | proposal-correction-worker, proposal_analytics.edited_fields |
| G13 | Vulnerability triage partial; owner patch-through incomplete | Medium | m113 fields, `evaluateTriage()` P8-016, escalation/on-call |
| G14 | Emergency fast-path partial (intent exists, no e2e/SOS) | Medium | EMERGENCY_INTENTS, `escalateToHuman()` skill, on-call rotation |
| G15 | Media Streams built but not ramped (no canary path) | Medium | media-streams adapter, feature flag |
| G16 | ~~`oauth_states` no RLS~~ **CLOSED — not a gap** (Phase-0 investigation): no-RLS is intentional & documented (`schema.ts:2293`) — OAuth callback consumes state BEFORE tenant context exists; exemption allowlisted in `schema.test.ts`, `rls-tenant-isolation.test.ts`, `rls-runtime-audit.test.ts`; 128-bit single-use nonce + 5-min TTL is the guard | Closed | — |
| G17 | No cross-tenant leak integration tests; no RLS-unset-GUC test | Testing | testcontainers integration harness |
| G18 | SMS reply approval lacks pending-edit block (one-tap has it, P2-034 parity gap) | Bug-class | `one-tap-approve.ts:120-148` logic |
| G19 | Advanced reporting thin (no job profitability, tech utilization, aging) | Medium | reports/ patterns, time entries, payments |
| G20 | Review response automation semi-manual (drafts exist; no per-tenant auto-pipeline through proposals) | Low-Med | reputation/ drafts, `review_response_proposal` type exists |
| G21 | Maintenance plans lack voice awareness + photo evidence on runs | Low-Med | agreements + runs, voice lookup skills |
| G22 | Vapi vs native telephony split (`vapi_assistant` m147 coexists with Twilio FSM) — needs an explicit decision | Decision | both integrations present |

### 2.3 Multi-tenancy status verdict

Solid three-layer enforcement (RLS + AsyncLocalStorage + S3 prefixing); no service-role backdoor; webhook tenant binding tested. **Required fixes are scoped, not structural:** G6 (per-tenant flags), G16 (`oauth_states` RLS), G17 (leak tests), plus the rule that every new table in this plan ships with `tenant_id` + `ENABLE/FORCE ROW LEVEL SECURITY` + the standard policy, and every new secret (QBO/Xero tokens) lives in `tenant_integrations` secret-refs — never in code or global env.
## 3. Key Design Decisions & Trade-offs

**D1 — Voice approval is a new approval channel on the existing gate, not a new gate.**
Voice approval reuses `approveProposal()` exactly like SMS/one-tap do. The voice FSM gets an owner-context mode: when the caller is the verified owner (Clerk-linked phone, plus spoken confirmation of a per-call challenge for money-class), "approve the Henderson estimate" → entity-resolve → `approveProposal()`. Trade-off: voice biometrics rejected (cost/complexity); identity = verified caller-ID + knowledge challenge for money/irreversible classes. Money-class voice approvals always read back amount + recipient and require explicit "yes, approve" (no implicit confirmation).

**D2 — Supervisor Agent is a deterministic policy engine with LLM assists, not an autonomous LLM agent.**
It runs as (a) a synchronous policy check inside proposal creation/routing (budget caps, class rules, deviation flags — pure code), and (b) an async reviewer worker that annotates queued proposals (risk notes, deviation scores — LLM via gateway). It never executes anything; it only routes, annotates, escalates, and blocks. Rationale: the Proposal gate stays the single enforcement point; the Supervisor is advisory + routing. Trade-off: less "agentic" but auditable and testable with cassettes.

**D3 — Photos generalize `files` + a new `attachments` join, keeping `job_photos` working.**
New `attachments` table (tenant_id, file_id, entity_type ∈ {job, invoice, estimate, form_response, expense}, entity_id, kind ∈ {photo, document}, caption, category, pair_group_id, pair_role ∈ {before, after}, portal_visible bool default false, annotated_file_id nullable, sort_order). `job_photos` remains (back-compat) and gains a 1:1 shadow row in `attachments` via the service layer; new surfaces read `attachments` only. Annotation is non-destructive: annotated copy = new `files` row linked via `annotated_file_id`; original immutable (evidence integrity). Trade-off vs. migrating `job_photos` in place: dual-write for one release is cheaper than a risky migration of a live table.

**D4 — Photo upload itself is NOT proposal-gated; portal visibility and sends are.**
Uploading a photo to a job is low-stakes capture (same class as `add_note`) and must be one-tap fast — direct authenticated endpoint, audited via `attachment.uploaded` audit event. Making a photo customer-visible, attaching to an outgoing invoice/estimate send, or deleting — those route through proposals (`set_attachment_visibility` is bundled into send proposals; deletes are soft + audited). Rationale: Jobber-parity speed where stakes are low; gate where exposure happens.

**D5 — Offline support = upload outbox in the web app (IndexedDB + service worker), not offline-first sync.**
Photos/forms queue locally when offline and drain with retry + dedupe keys when connectivity returns; capture UI is optimistic. Full offline-first (local DB of jobs/customers) is rejected for v1 — massive scope, conflicts with RLS-server-authoritative model. Trade-off: technicians can capture but not browse offline.

**D6 — Client Hub = evolve the existing `/portal/:token` (and `/e/:id`, `/pay/:id`), no new app.**
Add Photos tab (portal_visible attachments only, before/after pairs), photos-on-estimate/invoice pages, service-request-with-photos. Keep token-gated (no customer accounts) — matches "reduce friction" and existing portal_sessions infra.

**D7 — Accounting sync is one-way push (Rivet → QBO/Xero) v1, behind a provider interface.**
`AccountingProvider` interface (pushInvoice, pushPayment, pushCustomer, pushExpense, health) with QBO first (bigger US trades share), Xero second. Per-tenant OAuth tokens in `tenant_integrations` (provider='quickbooks'|'xero', secret refs). Sync = outbox table + worker (retry/DLQ), entity mapping table for remote IDs. Two-way sync rejected v1 (conflict resolution swamp); chart-of-accounts mapping is per-tenant config with sane defaults. Connect/disconnect are proposal-gated (irreversible-class disconnect).

**D8 — Route optimization = daily heuristic ordering per technician, not a TSP solver product.**
Inputs: day's appointments + arrival windows + tech working hours + Google travel-time provider (exists). Algorithm: nearest-neighbor + 2-opt within window constraints, computed by a worker each morning and on-demand; output = `route_plan` proposal (capture-class) the owner can approve/ignore; UI shows ordered stops on the dispatch board (list-first; map later). Trade-off: optimal-tour solvers rejected — 1-3 tech businesses need "a sensible order," not OR-tools.

**D9 — Per-tenant feature flags extend the existing flags repo, not a new system.**
New `tenant_feature_flags` table (tenant_id, flag_key, enabled, RLS) checked as override → fall back to platform flag. All Rivet features ship behind per-tenant flags — this is also the rollout mechanism (enable per pilot tenant).

**D10 — Brand-voice locking = versioned profile + lock bit + deviation grading, enforced at composition time.**
New `brand_voice_profiles` table (versioned; active version pointer in tenant_settings) replaces raw JSONB editing when `locked=true`: changes then require an `update_brand_voice` proposal (irreversible-class → owner approves). Deviation detection: outbound AI text (SMS, review replies, estimates customer messages) gets a cheap LLM grade vs. the locked profile (cassette-tested); score < threshold → blocked from auto-send, flagged in proposal with a Confidence Marker. Trade-off: adds one LLM call per outbound composition — bounded by gateway cache + only-AI-text scope.

**D11 — Correction Loop = structured edit-diff capture → per-tenant correction memos injected at draft time.**
Every `proposal.edited` + `approved_with_edits` already lands in `proposal_analytics.edited_fields`. Add a nightly worker distilling repeated corrections into `tenant_correction_rules` (e.g., "owner always renames 'Labor' to 'Labor & materials'", "always +$15 trip fee") — surfaced as suggestions the owner approves (proposal-gated, capture-class); approved rules are injected into draft prompts via the task-handler context. LLM fine-tuning rejected (cost, per-tenant isolation risk); prompt-injection memos are auditable and reversible.

**D12 — End-of-Day Digest is generated from authoritative data, narrated by LLM, delivered via SMS (short) + portal-style web view (full), never blocking.**
Digest worker at tenant-local configured time: revenue today, payments received, jobs completed, tomorrow's schedule, pending approvals (with one-tap links), flagged items (deviations, vulnerable-customer follow-ups, overdue invoices). The SMS contains zero-decision summary + deep link; voice playback available on demand ("Rivet, read me my day").

**D13 — Confidence Markers = one shared enum end-to-end.**
Reuse `ai/guardrails/confidence.ts` levels (high/medium/low/very_low); persist marker + per-field breakdown in proposal payload metadata (`fieldConfidence`); render: UI badge per field, SMS prefix convention (`✓` high / `?` medium+ asks), voice phrasing rules ("I think — please confirm" below τ). One vocabulary everywhere, no parallel scoring systems.

**D14 — Custom forms = JSON-schema-lite definitions, versioned, with photo-evidence fields; responses immutable.**
`form_templates` (tenant-scoped, versioned, fields: text/number/select/checkbox/signature/photo[]) + `form_responses` (job_id, snapshot of template version, answers, attachment links). Required forms gate job completion (job → completed blocked until required forms submitted — enforced in job status transition service). Builder UI is minimal (list editor), not a drag-drop designer (YAGNI for 1–3 tech shops).

**D15 — Jobber differentiation summary.** Match: photo capture speed (≤3 taps / one voice utterance), Client Hub photos + e-approval + payments (mostly exists). Exceed: voice-run day (G1+digest), typed-proposal safety + full audit timeline, per-tenant brand-voice enforcement, correction learning, vulnerability triage. Explicitly NOT chasing Jobber: GPS fleet tracking breadth, marketing-suite features, multi-office orgs.

**D16 — Vapi is deprecated for inbound; native Twilio FSM is the only voice path this plan extends.** `vapi_assistant` (m147) remains for any legacy outbound until VO flows are migrated; no new work targets Vapi. (Flagged as a decision to confirm with the owner; all tasks below assume native path.)

---

## 4. Phased Implementation Roadmap

Phases ship independently; each ends with the voice-quality launch gate green, integration tests green, and a per-tenant flag to enable.

**Phase 0 — Foundations & tenancy hardening (enables everything; ~1 sprint)**
Per-tenant feature flags (G6); `oauth_states` RLS fix (G16); cross-tenant leak + GUC-unset integration tests (G17); SMS-reply pending-edit parity fix (G18); `attachments` table + service (D3); Confidence Marker enum plumbed into proposal payload metadata (D13 backend half).
*Ships:* invisible infrastructure + 2 security/correctness fixes.

**Phase 1 — Photo & Document Management core + Client Hub photos (W23; ~2 sprints)**
Invoice/estimate/job attachments end-to-end: fast upload UI (≤3 taps), voice attach intent, annotation, before/after pairing, portal visibility control bundled into send proposals, Client Hub Photos tab + photos on `/e/:id` and `/pay/:id`, offline upload outbox (D5), EXIF strip + image pipeline (thumbnails), audit events.
*Ships:* Jobber-parity photos, visible to customers.

**Phase 2 — Voice-run day: voice approval, Supervisor v1, Digest, Markers UI (~2 sprints)**
Voice approval channel (D1) incl. money-class readback; Supervisor Agent v1 (D2: policy checks + queue annotator + routing); End-of-Day Digest (D12); Confidence Markers rendered in UI/SMS/voice (D13 front half); emergency fast-path completion + tests (G14); vulnerability triage owner patch-through completion (G13).
*Ships:* the owner can run a full day by voice+SMS and close it with the digest.

**Phase 3 — Trust & learning: brand voice lock, deviation detection, correction loop, reviews (~1.5 sprints)**
Brand-voice profiles + lock + deviation grader (D10); correction loop distiller + rule injection (D11); review-response automation through proposals end-to-end per-tenant (G20); maintenance-plan voice awareness + photos on agreement runs (G21).
*Ships:* per-tenant voice consistency + measurable learning loop.

**Phase 4 — Business depth: accounting, routes, forms, time/payroll, reporting (~3 sprints)**
QBO integration (D7) then Xero; route optimization v1 (D8); custom forms & checklists with photo evidence + completion gating (D14); payroll export from time entries (G10); advanced reporting (job profitability, tech utilization, AR aging, plan revenue) (G19).
*Ships:* back-office completeness vs. Jobber.

**Phase 5 — Real-time voice ramp & polish (~1 sprint, overlappable)**
Media Streams per-tenant canary ramp (G15) with quality dashboards; barge-in TTS cancellation fix; dropped-call recovery tie-in to streaming mode; perf budget (TTFA) regression gate.
*Ships:* low-latency natural voice for ramped tenants.

Dependency notes: Phase 1 depends only on Phase 0; Phase 2 is independent of Phase 1 except markers-on-photos; Phases 3–5 each depend on Phase 0 + slices of 2; within Phase 4, accounting/routes/forms/payroll/reporting are parallel tracks (separate sub-plans, per writing-plans scope rule).
## 5. Feature Specifications

Conventions for every feature: all new tables get `tenant_id UUID NOT NULL REFERENCES tenants(id)` + `ENABLE/FORCE ROW LEVEL SECURITY` + policy `tenant_id = current_setting('app.current_tenant_id')::UUID`; all repos extend `PgBaseRepository` and use `withTenant()`; all mutations either ARE proposal handlers or are explicitly classified low-stakes capture with audit events; all money integer cents; all new behavior behind a per-tenant flag (F-0); all voice-path changes must keep the voice-quality launch gate green.

---

### F-1. Supervisor Agent (tenant-scoped)

**Purpose:** A per-tenant policy brain that (a) routes/annotates every proposal, (b) enforces budgets and class rules, (c) watches live-call signals for escalation triggers, (d) flags brand-voice deviation — without ever executing anything itself (D2).

**Integration points:** `proposals/proposal.ts createProposal()` (synchronous policy hook before `decideInitialStatus()`); `proposals/auto-approve.ts routeUnsupervisedProposal()` (routing decisions); new worker `workers/supervisor-review-worker.ts` consuming a queue of newly created `ready_for_review` proposals; `ai/gateway` for annotation LLM calls; `audit_events` for every decision; escalation via existing `tenant_oncall_rotation` + `escalation_settings`.

**Tenant isolation:** policy config in new `supervisor_policies` table (RLS); annotations stored on the proposal (`payload.supervisorAnnotations`) — already tenant-scoped; budget counters in new `tenant_budget_counters` (RLS).

**Data model:**
```sql
-- supervisor_policies: one active row per tenant
id UUID PK, tenant_id, version INT, active BOOL,
rules JSONB NOT NULL,  -- {dailySpendCapCents, perProposalCapCents, maxAutoApprovalsPerHour,
                       --  blockedProposalTypes[], quietHoursOverride, deviationBlockThreshold}
created_by, created_at
-- tenant_budget_counters
tenant_id, counter_key TEXT, window_start TIMESTAMPTZ, value BIGINT, PRIMARY KEY(tenant_id, counter_key, window_start)
```

**Main logic:** Synchronous hook `evaluateSupervisorPolicy(proposal, policy, counters)` (pure function, `proposals/supervisor/policy.ts`): returns `{verdict: 'allow'|'force_review'|'block', reasons[]}`. money/irreversible always at least `force_review` (no change to existing behavior — codifies it). Async annotator: for each `ready_for_review` proposal, one gateway call (taskType `supervisor_annotate`, cassette-tested) producing risk summary + field-level confidence notes; written to payload metadata, surfaced in UI/SMS.

**Edge cases:** policy table empty → default policy constant (permissive parity with today); counter race → upsert with `ON CONFLICT ... value = value + 1`; LLM annotation failure → proposal proceeds un-annotated (annotation is advisory, never blocking); clock skew on windows → window_start truncated server-side.

**Acceptance criteria:**
- A proposal exceeding `perProposalCapCents` lands `ready_for_review` with audit event `supervisor.blocked_auto_approve` even when confidence ≥ threshold.
- Daily spend cap counts only executed money-class proposals; crossing it forces review for further money-class until window resets.
- Annotations appear on the proposal API payload within 30s of creation (p95) and never block approval.
- All decisions audited with reasons; zero cross-tenant reads (policy resolved inside `withTenant`).
- Cassette suite covers annotator outputs; launch gate green.

---

### F-2. Catalog Resolver (tenant-scoped) — EXISTS; harden + extend

**Purpose:** Ground every AI-drafted line item in the tenant's catalog so pricing is never hallucinated. Already implemented (`ai/resolution/catalog-resolver.ts`, P22: `pricingSource ∈ catalog|ambiguous|uncatalogued|manual`, confidence capping).

**Work remaining:** (a) voice phrasing for uncatalogued items ("I don't have a price for X — want me to use $Y and add it to your catalog?"); (b) `add_catalog_item` proposal type so corrections flow through the gate; (c) fuzzy-match quality telemetry (`catalog_resolution_events` metrics into `quality_metrics`); (d) Correction Loop hook: repeated manual price for the same description suggests a catalog item (F-8).

**Integration points:** catalog-resolver.ts; `catalog/` repos; estimate/invoice task handlers; new proposal type wiring per the 8-step recipe (`proposal.ts`, `contracts.ts`, `handlers.ts`).

**Tenant isolation:** `catalog_items` already RLS'd; resolver runs inside tenant context. No new tables.

**Edge cases:** two catalog items with same name different units → mark `ambiguous`, never auto-pick; archived items excluded from matching; zero-price catalog items treated as uncatalogued for confidence purposes.

**Acceptance criteria:** uncatalogued line items can never auto-approve (existing invariant preserved, now tested explicitly); `add_catalog_item` proposal creates an item and immediately resolves subsequent drafts; resolver match-rate metric visible per tenant.

---

### F-3. Entity Resolver (tenant-scoped) — EXISTS; harden + extend

**Purpose:** Resolve free-text references ("the Henderson job", "Bob's invoice") to entity IDs. Already implemented and wired (`ai/resolution/entity-resolver.ts`, τ_ent=0.80, one-clarification rule).

**Work remaining:** (a) extend candidate sources to attachments/forms/agreements (needed by W23, W17, W26); (b) owner-context resolution for voice approval ("approve the Henderson estimate" must resolve among *pending proposals*, not all estimates) — new candidate source `pendingProposals`; (c) phonetic/nickname matching pass (e.g., "Mike" → "Michael") using existing `phone_normalized`-style normalized name column on customers; (d) resolution telemetry.

**Data model:** `customers.name_normalized TEXT GENERATED` (migration) + index; no other tables.

**Edge cases:** multiple pending proposals for same customer → read back list by type+amount, ask ordinal choice; resolution across archived entities → excluded unless explicitly "archived"; homophones in voice ("Kristy/Christy") → candidates unioned by phonetic key before scoring.

**Acceptance criteria:** "approve the Henderson estimate" resolves to the unique pending `draft_estimate`/`send_estimate` proposal or asks exactly one clarifying question; resolver never returns an entity from another tenant (integration test with two seeded tenants); ≤1 clarification per resolution (existing rule preserved).

---

### F-4. Confidence Markers

**Purpose:** One confidence vocabulary (high/medium/low/very_low from `ai/guardrails/confidence.ts`) carried from classification → proposal → every surface (UI badge, SMS prefix, voice phrasing) so the owner instantly knows what to double-check (D13).

**Integration points:** task handlers in `ai/tasks/` (populate `payload._meta.fieldConfidence`); `proposals/sms/render.ts` (SMS rendering); web `ProposalCard`/inbox components; voice response templates in FSM `proposal_draft` state; Supervisor annotator (F-1) may downgrade markers.

**Tenant isolation:** lives inside proposal payloads — already scoped. No new tables.

**Data model (payload convention, Zod-validated in `contracts.ts` shared meta schema):**
```ts
_meta: { overallConfidence: 'high'|'medium'|'low'|'very_low',
         fieldConfidence?: Record<string /*payload path*/, ConfidenceLevel>,
         markers?: Array<{path: string, reason: string}> }
```

**Main logic:** mapping function `confidenceLevelFor(score)` already exists — single source; SMS: high → plain text, medium → field marked `(?)`, low/very_low → never compact-rendered, always "review in app" + reason; voice: below medium the agent must hedge and read back; UI: per-field badge + tooltip with reason.

**Edge cases:** missing `_meta` (old proposals) → render as today (no markers, no crash); conflicting field vs overall levels → overall = min(field levels); markers on chain children before refs resolve → ref fields marked `pending parent`, excluded from confidence math.

**Acceptance criteria:** every AI-created proposal has `_meta.overallConfidence`; SMS for a medium-confidence draft shows the `(?)` field; voice readback hedges below medium (cassette-graded); UI snapshot tests for all four levels; no proposal with low/very_low ever auto-approves (enforced in `decideInitialStatus`, tested).

---

### F-5. Dropped-Call SMS Recovery — EXISTS; extend

**Purpose:** Already implemented (T+60s SMS, suppression rules, PII-safe cue). Extend with: (a) recovery for calls dropped mid-proposal (resume link to a portal-style summary of where the call got to), (b) Media-Streams-mode drop detection (G15 tie-in), (c) recovered-conversation continuity (reply to recovery SMS resumes entity context).

**Integration points:** `sms/recovery/dropped-call-handler.ts`; `voice-session-store` (capture FSM state at drop); `proposal_sms_events` for reply threading; portal token mint for resume link.

**Tenant isolation:** existing `dropped_call_recoveries` RLS'd; resume tokens HMAC-bound to tenant like one-tap tokens.

**Edge cases:** drop after proposal created → recovery SMS references the proposal status, not a generic cue; caller is DNC-listed → no recovery SMS ever (existing check kept); multiple drops same caller same hour → single recovery thread, no re-spam (rate limit exists).

**Acceptance criteria:** drop during `intent_capture` → SMS within 90s with cue; drop during `proposal_draft` with a created proposal → SMS contains status + safe summary; reply "yes" resumes (creates `call_me_back_task` or continues SMS flow); cassette/e2e coverage in qa-matrix `voice-gates` project.

---

### F-6. Vulnerability Triage + Owner Patch-through

**Purpose:** Complete P8-016: detect vulnerable callers (distress, elderly confusion, safety risk language), score, and *patch the owner through* (live conference or immediate callback) for high scores, with compassionate handling templates.

**Integration points:** customer vulnerability fields (m113); `evaluateTriage()` (exists); FSM `escalating` state + `twilio-call-control.ts` (transfer/conference); `tenant_oncall_rotation` + `transfer_number` (m152); audit; digest (F-9) lists vulnerability flags.

**Tenant isolation:** scores/flags stored on customers + new `triage_events` table (RLS): `id, tenant_id, voice_session_id, customer_id NULL, score, tier, signals JSONB, action_taken, created_at`.

**Main logic:** classifier prompt (cassette-tested) emits `{vulnerabilityScore 0-1, urgencyTier}` per turn batch; tiers: `patch_owner` (≥0.8) → announce + warm conference owner via call-control, else immediate owner SMS + callback task; `high_priority_booking` → fast-path booking with priority flag; `normal`. Persistent per-customer flag set only via `update_customer` proposal (owner approves marking a customer vulnerable — it changes future handling).

**Edge cases:** owner unreachable on patch-through → fall to on-call rotation → voicemail + urgent SMS + `call_me_back_task(priority=urgent)`; false-positive on profanity vs distress → graders include counter-examples; after-hours patch-through respects owner quiet hours unless tier=patch_owner AND safety keywords (configurable in supervisor policy F-1).

**Acceptance criteria:** scripted distress call reaches `patch_owner` decision in ≤2 turns (cassette); owner conference attempted within 30s; every triage decision audited with signals; vulnerable-customer interactions appear in digest; no vulnerability data ever in customer-facing surfaces (portal/SMS).

---

### F-7. Brand Voice Locking + Deviation Detection (per-tenant)

**Purpose:** Make the tenant's voice/tone a *locked, versioned profile* enforced on all AI-composed outbound text; detect and block deviations (D10).

**Integration points:** `ai/brand-voice/composer.ts` (single composition choke point — all outbound AI text must route through it; audit any bypasses); `tenant_settings.brand_voice` (migrates into profiles table); review responses (F-14), SMS templates, estimate/invoice customer messages, digest narration; new proposal type `update_brand_voice` (irreversible-class).

**Data model:**
```sql
-- brand_voice_profiles (RLS)
id UUID PK, tenant_id, version INT, locked BOOL DEFAULT false,
profile JSONB NOT NULL,        -- {formality, pronoun, tone, bannedPhrases[], requiredSignoff, exampleSnippets[]}
active BOOL, created_by, created_at
-- brand_voice_deviations (RLS)
id, tenant_id, surface TEXT, entity_ref TEXT, draft_text TEXT, score NUMERIC, verdict TEXT, profile_version INT, created_at
```

**Main logic:** composer loads active profile (cached, 60s TTL per tenant); after composition, deviation grader (gateway taskType `grade_brand_voice`, cheap model, cassette-tested) scores 0–1; score < `deviationBlockThreshold` (supervisor policy, default 0.7) → text not auto-sent: comms proposal flagged `brand_voice_deviation` marker (F-4) for owner review. Locking: when `locked=true`, profile changes only via `update_brand_voice` proposal; unlock itself is a proposal.

**Edge cases:** no profile yet → seed from existing `tenant_settings.brand_voice` on first read (migration backfill); grader outage → fail-open for capture-class internal text, fail-closed (force review) for customer-facing comms; multilingual tenants → profile per language key falls back to default.

**Acceptance criteria:** with a locked formal profile, a slang draft review-reply is blocked from auto-send and flagged; profile edit without proposal returns 403; every deviation logged with score + version; deviation rate per tenant visible in reporting (F-19); cassette suite for grader with ≥10 positive/negative pairs.

---

### F-8. Correction Loop (per-tenant learning)

**Purpose:** Turn owner edits/rejections into durable per-tenant drafting improvements (D11).

**Integration points:** `proposal_analytics` (edited_fields, rejection_reason — exists); `proposal-correction-worker.ts` (exists — extend); task-handler prompt context (`ai/tasks/*` inject memos); catalog suggestion hook (F-2); new proposal type `adopt_correction_rule` (capture-class).

**Data model:**
```sql
-- tenant_correction_rules (RLS)
id, tenant_id, scope TEXT,            -- 'estimate_line_items'|'customer_message'|'pricing'|'scheduling'|...
rule_text TEXT NOT NULL,              -- imperative memo injected into prompts
evidence JSONB,                       -- proposal ids + diffs that motivated it
status TEXT CHECK (status IN ('suggested','active','retired')),
hit_count INT DEFAULT 0, created_at, decided_at, decided_by
```

**Main logic:** nightly distiller worker per tenant: cluster last-30-day `edited_fields` diffs by scope (pure code grouping + one LLM summarization per cluster ≥3 occurrences) → upsert `suggested` rules → create `adopt_correction_rule` proposal (owner sees "You corrected X 4 times — adopt this rule?"). Active rules (cap: 20/tenant, token-budgeted) injected into the relevant task-handler prompt section; each injected rule increments `hit_count` when the resulting proposal is approved unedited (success signal); rules with negative signal auto-suggested for retirement.

**Edge cases:** contradictory rules → newest active wins, older auto-flagged for retirement review; PII in diffs → distiller input passes through existing `reputation/pii-redact.ts`; rule cap overflow → lowest hit_count suggested for retirement.

**Acceptance criteria:** 3 identical owner edits produce exactly one suggestion proposal; adopting it changes the next draft (integration test with cassette); rules never leak across tenants (distiller runs inside `withTenant`); owner can list/retire rules in settings UI; injected-rules token budget ≤ 600 tokens.

---

### F-9. End-of-Day Digest (tenant-specific)

**Purpose:** One daily summary closing the loop: money, work, tomorrow, approvals pending, flags (D12).

**Integration points:** reports (`money-dashboard.ts`), proposals inbox, jobs/appointments repos, payments, triage events (F-6), deviations (F-7), one-tap token mint (`auto-approve.ts`) for pending approvals, SMS dispatch (`message_dispatches`), workers registry, digest web view route; voice skill `read_digest` for "read me my day".

**Data model:**
```sql
-- daily_digests (RLS)
id, tenant_id, digest_date DATE, payload JSONB NOT NULL,   -- computed snapshot
narrative TEXT, sms_dispatch_id NULL, generated_at, UNIQUE(tenant_id, digest_date)
-- tenant_settings additions: digest_enabled BOOL, digest_time TIME, digest_channel TEXT
```

**Main logic:** worker `workers/daily-digest-worker.ts` runs every 15 min, selects tenants whose local `digest_time` bucket just passed (tenant-tz, same pattern as money dashboard bucketing): compute payload (pure queries) → LLM narrative through BrandVoiceComposer (F-7 grading applies) → store row → send SMS (≤ 480 chars: counts + top 3 pending approvals each with one-tap link + deep link to web digest). Web view `/digest/:date` renders full payload. Voice: `lookup_digest` intent reads narrative.

**Edge cases:** nothing happened today → "quiet day" short form, still sent (configurable); >3 pending approvals → "and N more" link; SMS provider failure → retry via dispatch idempotency, digest row still stored; tenant in trial without SMS → web+push only; DST transitions → bucket by tenant-tz local time (existing tz util).

**Acceptance criteria:** digest arrives within 15 min of configured time (tenant tz); numbers exactly match money dashboard for same day (shared query functions, asserted in test); one-tap links in digest expire ≤30 min and respect pending-edit blocks; "read me my day" plays narrative (cassette); zero digests reference another tenant's data (two-tenant integration test).

---

### F-10. Client Hub (token-gated, clean photo viewing)

**Purpose:** Evolve `/portal/:token` + `/e/:id` + `/pay/:id` into a Jobber-parity Client Hub with photo viewing (D6).

**Integration points:** `pages/portal/PortalShell.tsx` (+ new `PortalPhotoGallery`), `public-estimate-service.ts` / `public-invoice-service.ts` (include portal_visible attachments), `attachments` (F-16), portal session middleware; service-request flow gains photo upload (customer-side, token-scoped presign).

**Tenant isolation:** portal token already resolves tenant; photo URLs are short-lived presigned GETs minted per request inside tenant context; `portal_visible=true` filter enforced in SQL (not client-side).

**Main logic:** Photos tab groups by job, renders before/after pairs side-by-side (pair_group_id), captions visible; estimate/invoice pages render their visible attachments inline above line items; customer photo upload on Request Service: token-scoped presign endpoint `POST /api/portal/:token/uploads` (rate-limited 20/day, image-only, 15MB cap) attaching to the created service request/lead.

**Edge cases:** expired portal token mid-gallery → graceful re-request screen (existing pattern); photo deleted/archived after share → gallery skips, no 404 storm; HEIC from iPhones → pipeline converts to JPEG (F-16); customer uploads malware-named file → content-type sniffing + image-only enforcement server-side.

**Acceptance criteria:** customer sees ONLY `portal_visible` attachments of their own records (cross-customer + cross-tenant integration tests); before/after pairs render side-by-side at 320px; estimate approval page with photos passes existing mobile e2e; presigned URLs expire ≤10 min; Lighthouse perf ≥85 on gallery with 50 photos (lazy load + thumbnails).

---

### F-11. Real-time Voice Streaming — EXISTS; ramp (G15)

**Purpose:** Production-ramp the Media Streams path (Deepgram + ElevenLabs, barge-in) from feature-flag-off to per-tenant canary.

**Integration points:** `telephony/media-streams/*`, per-tenant flags (F-0) replacing global `TWILIO_MEDIA_STREAMS_ENABLED`, voice-quality TTFA metrics, Prometheus dashboards.

**Work:** (a) per-tenant flag `voice_media_streams`; (b) automatic mid-call fallback to Gather on stream failure (reconnect TwiML redirect); (c) TTS cancellation on barge-in (today TTS continues — fix in BoundedSendQueue clear); (d) TTFA (time-to-first-audio) metric per call recorded to `call_summaries.quality_score` inputs; (e) canary report comparing streamed vs gathered tenants on grader metrics.

**Edge cases:** Deepgram outage mid-call → fallback redirect preserving FSM state via session store; WebSocket backpressure saturation → drop telemetry frames first (priority queue exists); μ-law artifacts on long TTS → chunked synthesis already paced by mark acks.

**Acceptance criteria:** flag on for tenant A only → A streams, B gathers (test); forced stream kill mid-call → call continues in Gather mode without losing FSM state; barge-in stops audible TTS ≤300ms in test harness; TTFA p50 ≤ 1.2s streamed; launch gate + layer-2 report green on streamed corpus.
### F-12. Compliance & Recording Disclosure — EXISTS; extend

**Purpose:** Existing: disclosure skill + canonical text, DNC, quiet hours, transcript encryption, STOP handling. Extend: per-customer consent ledger, disclosure verification in graders, retention policy.

**Integration points:** `ai/skills/disclose-recording.ts`, `shared/src/legal/recording-disclosure.ts`, `customers.consent_status` (m132), voice-quality graders, `voice_recordings`.

**Data model:** `consent_events` (RLS): `id, tenant_id, customer_id NULL, phone_normalized, kind ('recording'|'sms'|'marketing'), state ('granted'|'revoked'|'implicit'), source ('voice'|'sms'|'portal'|'manual'), voice_session_id NULL, created_at` — append-only ledger; `customers.consent_status` becomes a derived cache.

**Main logic:** disclosure utterance logs an `implicit recording` consent event tied to session; "stop recording"/objection intent → pause recording via `twilio-call-control.ts`, log `revoked`, FSM continues unrecorded; retention worker purges recordings past per-tenant retention days (`tenant_settings.recording_retention_days`, default 365) — files deleted from S3, rows tombstoned, audit kept.

**Edge cases:** two-party-consent jurisdictions (flags exist) → disclosure REQUIRED before any recording starts (assert in adapter, not just contract); revoked-consent customer calls again → agent discloses and asks explicitly; retention purge vs legal hold → `legal_hold BOOL` on recordings exempts.

**Acceptance criteria:** every recorded session has a disclosure event ≤10s after greeting (grader-checked across corpus); revocation stops recording within one turn and is audited; purge worker deletes S3 object + tombstones row (integration test with dev storage); DNC + STOP behavior unchanged (regression suite).

---

### F-13. Emergency / High-Urgency Fast Path — partial; complete (G14)

**Purpose:** Detected emergency ("gas leak", "flooding", "no heat + infant") bypasses normal capture and gets a human fast.

**Integration points:** `EMERGENCY_INTENTS` + `emergency_dispatch` proposal type (exist); FSM fast-path transition (exists for P12-004); `escalateToHuman()` skill; on-call rotation; F-6 triage tiers; digest.

**Work:** (a) keyword+classifier dual trigger (keywords act on interim transcripts in streaming mode — no LLM wait); (b) safety script ("If this is life-threatening call 911") before transfer, jurisdiction-aware; (c) `emergency_dispatch` execution handler that creates urgent job + priority booking + owner SMS in one transaction (today: no handler — gap closed); (d) after-hours emergency overrides quiet hours for owner notification (policy F-1).

**Tenant isolation:** uses existing scoped tables; emergency keyword list per tenant (`supervisor_policies.rules.emergencyKeywords` merged with platform defaults).

**Edge cases:** false alarm ("not an emergency, just urgent") → de-escalate path back to normal intake, audit both; all on-call unreachable → voicemail + repeated SMS page (3x at 2-min intervals) + digest flag; emergency from DNC number → DNC does not block INBOUND handling (only outbound) — assert.

**Acceptance criteria:** scripted "gas leak" call reaches transfer attempt ≤15s from utterance (cassette + timing harness); 911 script always precedes transfer in two-party states; `emergency_dispatch` handler creates job(priority=urgent)+appointment-hold+owner SMS atomically; e2e in qa-matrix voice-gates.

---

### F-14. Review Response Automation (per-tenant) — drafts EXIST; automate (G20)

**Purpose:** Close the loop: new Google review → brand-voiced draft → `review_response_proposal` (type exists) → owner approves via any channel → posted reply.

**Integration points:** `workers/google-reviews.ts` (polling exists), `reputation/draft-public-response.ts` + `pii-redact.ts` (exist), `ReviewResponseExecutionHandler` (exists), BrandVoiceComposer + deviation grading (F-7), service credits.

**Work:** (a) wire poller → auto-draft → proposal creation per new review (today semi-manual); (b) per-tenant policy: auto-draft all vs ≥/< N stars handling (negative reviews always force review + suggested private follow-up via `draft-private-followup.ts`); (c) post-execution verification (read-after-write against Google API) + retry; (d) digest section "reviews handled".

**Tenant isolation:** `google_reviews`, review poll state, drafts all RLS'd (exist); Google Business credentials per tenant in `tenant_integrations`.

**Edge cases:** review edited after draft → re-draft, supersede old proposal (expire it); review deleted → cancel pending proposal; Google API rate limits → poller backoff per tenant; reply rejected by Google (policy violation) → execution_failed with reason surfaced.

**Acceptance criteria:** new 5★ review produces an approvable proposal within one poll cycle; 1–2★ review proposal carries `low` marker + private-follow-up suggestion and never auto-approves; posted reply matches approved text exactly (verification step); deviation-blocked drafts (F-7) flagged not sent.

---

### F-15. Maintenance Plan / Recurring Service Awareness — agreements EXIST; add awareness (G21)

**Purpose:** Make voice/AI surfaces aware of agreements: "is Mrs. Patel on a plan?", upsell prompts on eligible jobs, photo evidence on plan visits, plan revenue reporting.

**Integration points:** `agreements/` + runs (exist), voice lookup skill `lookup_agreements` (exists — extend with entitlement answers), estimate task handler (plan-discount awareness), F-16 attachments on agreement runs, F-19 reporting, digest.

**Work:** (a) entitlement resolver: given customer+service, answer covered/not + next visit; (b) upsell hook: completed one-off job in plan-eligible category → `draft_estimate` proposal for a plan (comms-class send, capture-class draft), max 1 per customer per 90 days (supervisor counter); (c) agreement-run job auto-attaches required form/checklist (F-21) and photo slots; (d) voice: "put them on the spring plan" → `create_agreement` NEW proposal type (capture-class, since money flows only via its invoices).

**Data model:** no new tables; `create_agreement` proposal type + payload schema (name, customerId, recurrenceRule, priceCents, autoInvoice, autoJob).

**Edge cases:** plan lapsed (ends_on past) → entitlement "expired, renew?" answer; duplicate plan creation for same customer+name → handler idempotency by (customer, name, recurrence); RRULE edge (Feb 30 style) → existing recurrence.ts validation reused.

**Acceptance criteria:** voice "is she on a plan?" answers correctly incl. next visit date (cassette); upsell proposal respects 90-day counter; agreement runs generate jobs that carry required checklist; plan MRR appears in reporting.

---

### F-16. Photo & Document Management (HIGH PRIORITY — Workflow 23 core)

**Purpose:** Fast, reliable, voice-friendly, tenant-isolated photo/document attachment to jobs AND invoices/estimates: one-tap capture, annotation, before/after, offline outbox, portal visibility control (D3/D4/D5).

**Integration points:** `files` + `job_photos` + presign flow (exist); `AddEntrySheet.tsx` camera (exists); invoice/estimate detail pages; send-estimate/send-invoice handlers (visibility bundling); voice intents (`attach_photo`, "attach these to the Henderson invoice"); portal (F-10); audit.

**Data model:**
```sql
-- attachments (RLS)  [D3]
id UUID PK, tenant_id, file_id UUID REFERENCES files(id),
entity_type TEXT CHECK (entity_type IN ('job','invoice','estimate','form_response','expense','agreement_run','customer')),
entity_id UUID NOT NULL, kind TEXT CHECK (kind IN ('photo','document')),
caption TEXT, category TEXT CHECK (category IN ('before','after','problem','completion','receipt','signature','other')),
pair_group_id UUID NULL, pair_role TEXT NULL CHECK (pair_role IN ('before','after')),
portal_visible BOOL NOT NULL DEFAULT false,
annotated_file_id UUID NULL REFERENCES files(id),
uploaded_by UUID, source TEXT CHECK (source IN ('app','voice','portal','sms')),
sort_order INT DEFAULT 0, archived_at TIMESTAMPTZ NULL, created_at
-- indexes: (tenant_id, entity_type, entity_id), (tenant_id, pair_group_id)
-- files additions: width INT, height INT, thumbnail_s3_key TEXT, exif_stripped BOOL, content_hash TEXT
```

**Main logic:**
- Upload pipeline: presign → client PUT → `POST /api/attachments` attach (3-step exists for jobs; generalize). Server post-process worker: EXIF strip (keep orientation), HEIC→JPEG, thumbnail (480px) generation, content_hash for dedupe; pipeline failure never blocks attach (original served until thumb ready).
- One-tap UX: capture defaults (entity = current screen context, category prompt as 5-chip row, caption optional) — ≤3 taps total.
- Voice attach: `attach_photo` intent resolves target entity (F-3) + selects photos by recency window ("the photos I just took" = last N minutes by uploader) → capture-class proposal `attach_photos` ONLY when re-targeting across entities; same-job context attach is direct (D4).
- Annotation: client-side canvas (arrows/circles/text) → new file → `annotated_file_id`; original immutable.
- Before/after: pairing UI assigns `pair_group_id`; voice "this is the after shot for the panel photo" supported via resolver.
- Visibility: `portal_visible` flips ONLY via send-proposal bundling or explicit owner toggle (audited `attachment.visibility_changed`); default false.
- Offline outbox (D5): IndexedDB queue (file blob + intent metadata + client dedupe key) + service worker background sync; UI badge "N queued"; drain with exponential backoff; server dedupes by (tenant, content_hash, entity) within 24h.
- Deletion: soft (`archived_at`), audited; hard purge via retention worker only.

**Edge cases:** 15MB+ photo → client-side downscale before upload (cap 8MB after); duplicate upload (double-tap) → content_hash dedupe returns existing; attach to closed/canceled job → allowed (documentation) but flagged; portal-visible photo on later-voided invoice → stays visible on the void record view only; S3 PUT succeeds but attach call dies (offline) → outbox retries attach idempotently via dedupe key; iPhone HEIC + Android WEBP both normalized; timezone on `taken_at` from EXIF before strip.

**Acceptance criteria:**
- Job photo: camera → attached in ≤3 taps; appears in job timeline immediately (optimistic) and survives refresh.
- Invoice photo: attach from invoice detail; appears on `/pay/:id` ONLY after visibility granted via send proposal.
- Voice: "attach the photos I just took to the Henderson invoice" → proposal with thumbnails in UI, approve → attached (e2e).
- Airplane-mode capture of 3 photos → all 3 attached within 60s of reconnect, zero duplicates (Playwright offline emulation).
- Annotation preserves original (both retrievable); before/after pair renders side-by-side in portal at 320px.
- Cross-tenant: presign/attach/list APIs reject foreign entity_id (two-tenant integration tests, 404 not 403 — no existence leak).
- p95 capture→visible-in-timeline < 4s on 4G profile; thumbnails served for lists (no full-size in gallery grid).

---

### F-17. Accounting Integrations (QuickBooks / Xero — per-tenant) (D7)

**Purpose:** One-way push of customers, invoices, payments, expenses to the tenant's QBO (first) / Xero (second), per-tenant OAuth, mapping, retries, drift report.

**Integration points:** `tenant_integrations` (provider rows + secret refs — pattern exists); webhook base (`webhooks/`); workers/PgQueue; invoices/payments/customers/expenses repos; settings UI; proposals (`connect_accounting` capture-class config, `disconnect_accounting` irreversible-class).

**Data model:**
```sql
-- accounting_entity_map (RLS): id, tenant_id, provider TEXT, local_type TEXT, local_id UUID,
--   remote_id TEXT, remote_synced_at, checksum TEXT, UNIQUE(tenant_id, provider, local_type, local_id)
-- accounting_outbox (RLS): id, tenant_id, provider, op TEXT, local_type, local_id, payload JSONB,
--   status ('pending'|'inflight'|'done'|'failed'), attempts INT, last_error TEXT, created_at, idempotency_key UNIQUE
-- tenant_settings additions: accounting_provider, accounting_account_map JSONB (income/tax/deposit accounts)
```

**Main logic:** domain events (invoice issued/paid, payment recorded, customer created, expense logged) enqueue outbox rows; `accounting-sync-worker` drains per tenant serially (ordering!) via `AccountingProvider` interface; OAuth connect flow stores refresh token as secret ref; token refresh handled in provider client; nightly drift checker compares checksums and reports mismatches to digest; disconnect keeps map (re-connect resumes).

**Edge cases:** remote validation failure (e.g., QBO requires unique DocNumber) → failed with actionable error in settings UI, never silent; tenant edits invoice after sync → resync as sparse update (QBO SyncToken handling); rate limits (QBO 500/min/realm) → per-tenant token bucket; partial refunds/reversals (m100/m133) map to credit memos; sandbox vs prod realm separation per env; **secrets:** never logged, secret-ref pattern only, revoked grant → integration status 'reauth_required' + digest flag.

**Acceptance criteria:** connect QBO sandbox → existing open invoices backfill-pushed with correct totals (cents→QBO decimal, asserted round-trip); pay invoice in Rivet → QBO payment within 60s; two tenants connect two different QBO realms — zero crossover (integration test with mocked provider asserting realm per call); kill worker mid-batch → no duplicate remote records on resume (idempotency keys); drift report flags an out-of-band QBO edit.

---

### F-18. Route Optimization (tenant-scoped) (D8)

**Purpose:** Sensible daily stop order per technician honoring arrival windows and working hours.

**Integration points:** appointments + assignments + working hours (m137) + unavailable blocks (m116); `scheduling/travel-time/google-provider.ts` (exists); dispatch board UI; new proposal type `apply_route_plan` (capture-class — it reorders/retimes appointments via existing reschedule machinery); digest ("tomorrow's routes ready").

**Data model:**
```sql
-- route_plans (RLS): id, tenant_id, plan_date DATE, technician_id, status ('draft'|'proposed'|'applied'|'stale'),
--   stops JSONB,   -- ordered [{appointmentId, eta, etd, driveMinutesFromPrev}]
--   total_drive_minutes INT, savings_minutes INT, computed_at, UNIQUE(tenant_id, plan_date, technician_id)
```

**Main logic:** worker at 5am tenant-tz + on-demand endpoint: fetch day's appointments per tech → travel-time matrix (cache by geohash pair, 24h TTL — Google API cost control) → nearest-neighbor seed + 2-opt improvement under window constraints → persist plan; if savings_minutes ≥ 15 → create `apply_route_plan` proposal; applying executes reschedules through existing handlers (per-appointment audit preserved); customer-notification policy: applying a plan that shifts any confirmed arrival window > X min auto-bundles `notify_delay`-style comms proposals.

**Edge cases:** locked/confirmed appointments → fixed anchors, optimize around; missing geocodes → stop pinned in original slot + flagged; mid-day re-optimize after cancellation → only future stops; two techs same job (crew) → treat crew appointment as anchor for both; Google API down → plan skipped, never blocking schedules.

**Acceptance criteria:** synthetic 6-stop day with crossing routes → plan reduces drive ≥20% (fixture test, deterministic mocked matrix); window violations = 0 in any emitted plan (property test); applying plan creates reschedule audit per moved appointment; matrix cache hit-rate ≥80% on second daily run; per-tenant flag gates the worker.

---

### F-19. Advanced Reporting (tenant-scoped) (G19)

**Purpose:** Owner-grade insight beyond the money dashboard: job profitability, tech utilization, AR aging, plan MRR, AI-ops metrics.

**Integration points:** `reports/` patterns (money-dashboard, revenue-by-source, tax-export); time entries (labor cost), expenses, invoices/payments, agreements, proposal_analytics, brand_voice_deviations; web `/reports/*`; voice `lookup_revenue` (exists — extend).

**Data model:** no new core tables; `users.hourly_cost_cents` (migration) for labor costing; report queries are read-only SQL in `reports/` (tenant-tz bucketing util reused).

**Reports:** Job profitability (revenue − labor(time entries × hourly_cost) − materials(expenses+line items flagged cost) per job); Tech utilization (clocked job time / working hours, drive share); AR aging (current/30/60/90 buckets + dunning status); Plan revenue (active agreements MRR, churn); AI ops (proposals by outcome, auto-approve rate, correction-rule hits, deviation rate, voice minutes + AI cost from ai_runs).

**Edge cases:** jobs spanning months → bucket by completion date, document choice; missing hourly cost → utilization shown, profitability marked partial; voided invoices excluded from revenue but visible in detail.

**Acceptance criteria:** profitability for a fixture job with known time entries + expenses matches hand-computed value to the cent; all reports tenant-tz consistent with money dashboard; CSV export per report; each report < 500ms p95 on 10k-invoice fixture (indexed); voice "how profitable was the Henderson job" answers (cassette).

---

### F-20. Time Tracking & Payroll (tenant-scoped) — tracking EXISTS; add payroll (G10)

**Purpose:** Time entries exist (m67, clock in/out, single-active constraint, bill-labor m151). Add: timesheet review/approval, payroll period export, voice clock in/out polish, GPS-stamped punches (optional per tenant).

**Integration points:** `time_entries`, `routes/time-entries.ts`, `log_time_entry` proposal type (exists), location pings (m40), reports CSV pattern, F-17 (expense/labor push later).

**Data model:**
```sql
-- payroll_periods (RLS): id, tenant_id, starts_on DATE, ends_on DATE, status ('open'|'approved'|'exported'),
--   approved_by, approved_at, UNIQUE(tenant_id, starts_on)
-- time_entries additions: approved BOOL DEFAULT false, approved_by, gps_lat/gps_lng NULL, edited_reason TEXT
```

**Main logic:** weekly period auto-open per tenant (configurable week start); owner timesheet review UI (per tech, per day, anomaly flags: >12h day, missing clock-out, overlapping entries — overlap should be impossible via constraint, flag legacy); edits to entries are `update_time_entry` NEW proposal type (capture-class, edited_reason required — payroll integrity); approve period → locks entries (`approved=true`, further edits blocked); export CSV (gross hours, OT per tenant rule simple >40/wk, rate, job allocation) in Gusto-importable format.

**Edge cases:** open entry at period boundary → split at midnight tenant-tz; clock-in via voice with no job resolved → entry_type 'admin' + flagged for review; technician disputes edit → audit trail shows original + edit + reason; GPS permission denied → punch accepted, gps null (GPS is evidence, not gate).

**Acceptance criteria:** voice "clock me in on the Patel job" creates running entry (exists — regression); period approve locks edits (403 + proposal path closed); export totals match sum of approved entries exactly; anomaly fixtures all flagged; only owner role approves periods (RBAC test).

---

### F-21. Custom Forms & Checklists (tenant-scoped, photo evidence) (D14)

**Purpose:** Per-tenant form/checklist templates (safety checklist, install QA, intake) with required-on-job gating and photo-evidence fields.

**Integration points:** jobs status transition service (completion gate); attachments (F-16) for photo fields; portal Request Service (customer-facing forms); voice ("start the safety checklist" → guided voice form-fill); PDF render for compliance export (reuse `printEstimateDocument` pattern).

**Data model:**
```sql
-- form_templates (RLS): id, tenant_id, name, version INT, status ('draft'|'active'|'retired'),
--   fields JSONB NOT NULL,  -- [{key, label, type: text|number|select|checkbox|signature|photo, required, options[], photoMin}]
--   applies_to JSONB,       -- {jobCategories[], required_for_completion BOOL, agreement_runs BOOL}
--   created_by, created_at, UNIQUE(tenant_id, name, version)
-- form_responses (RLS): id, tenant_id, template_id, template_version INT, template_snapshot JSONB,
--   job_id NULL, agreement_run_id NULL, lead_id NULL, status ('in_progress'|'submitted'),
--   answers JSONB, submitted_by, submitted_at, created_at
-- attachments.entity_type already includes 'form_response'
```

**Main logic:** template editing versioned (active version snapshot copied into each response — responses immutable vs later template edits); job completion service checks `required_for_completion` templates for the job's category → blocks `completed` transition until submitted (clear error listing missing forms); voice form-fill: FSM sub-flow walks required fields, photo fields prompt "take the photo now" (links via recency window like F-16 voice attach); signature: portal/customer-facing only (canvas), techs use checkbox attestation.

**Edge cases:** template retired while response in progress → response continues on snapshot; required photo field offline → outbox integration, submission allowed with queued photos flagged pending; template with zero fields → invalid (Zod min 1); changing applies_to doesn't retro-block already-completed jobs.

**Acceptance criteria:** job in a gated category cannot reach `completed` without submitted required forms (API + UI tests); response renders exactly the template version at fill time even after edits; photo field enforces photoMin and links attachments; voice checklist run completes a 5-field template (cassette); PDF export of a response includes photos; cross-tenant template invisibility (integration test).

---

**Cross-cutting feature F-0 (Phase 0): Per-tenant feature flags.** Table `tenant_feature_flags` (tenant_id, flag_key, enabled, updated_by, updated_at, PK(tenant_id, flag_key), RLS) + `pg-feature-flags.ts` gains `isEnabledForTenant(tenantId, key)` = tenant override ?? platform flag ?? default-off. Used by every feature above. Acceptance: flag flips affect only the target tenant (integration test); flag reads cached 30s with explicit bust on write.
## 6. User Flow Breakdown & Atomic Tasks

Task conventions: IDs are `RV-###`, globally unique, referenced (not repeated) when shared across flows. Each task is one PR-sized unit for an implementation agent: it names exact files, and the agent follows TDD (failing test → minimal code → green → commit) per repo CLAUDE.md. "(P n)" = phase. Every flow's acceptance criteria implicitly include: tenant isolation (two-tenant test where data is touched), proposal gate for mutations, audit events, and voice-quality launch gate green for voice-path changes.

### Phase 0 shared tasks (referenced everywhere)

- [x] **RV-001 (P0)** Per-tenant feature flags — DONE (migration 159; new `pg-tenant-feature-flags.ts` with `PgTenantFeatureFlagRepository(pool, platformFlags: FeatureFlagRepository)`; platform fallback evaluates full `isFeatureEnabled` semantics incl. environments/tenantIds; 17 tests). Wiring into app.ts composition root deferred to first consumer.
- [x] **RV-002 (P0)** ~~Add RLS policy to `oauth_states`~~ CLOSED, no change needed: investigation found the no-RLS design intentional, documented, and guard-tested (see G16); adding RLS would break the OAuth callback. RV-202's "fixed oauth_states" reference is void — accounting OAuth should follow the same documented pattern.
- [x] **RV-003 (P0)** Cross-tenant leak integration suite: `packages/api/test/integration/tenant-isolation.leak.test.ts` — seeds 2 tenants, repository-layer leak tests (customers, jobs, estimates, invoices, proposals, files, tenant_feature_flags; attachments case appended in RV-005), unprivileged-role RLS probes, and GUC-unset coverage. NOTE (executed): unset-GUC queries ERROR (policies lack missing_ok) — fail-closed, stronger than the original "zero rows" wording; tests pin the error. Canonical leak suite: every new tenant-scoped table appends a case here.
- [x] **RV-004 (P0)** SMS-reply pending-edit parity (G18): NOTE (executed) — the block already existed on main (commit 12a91aca, `reply-handler.ts:246-253`, guard + `proposal.sms_approve_blocked_pending_edit` audit); G18 was stale. Added 2 hardening tests asserting audit events + no-bypass across all approve keywords (commit f31c1353).
- [x] **RV-005 (P0)** `attachments` foundation — DONE (migration 160; repo/service/routes; dual-write shadow incl. delete→archive; atomic pair with orphan-clearing; owner-only `attachments:visibility` RBAC; attach-by-fileId-only with file↔entity match guard; batched file lookup + portalVisibleOnly filter; ~70 tests + leak-suite block). DEVIATIONS from spec: `uploaded_by` is TEXT not UUID (Clerk ids aren't UUIDs — matches files/job_photos convention); presign restricted to job/invoice/estimate until later tasks wire other types. NOTE for F-10: `S3StorageProvider.generateDownloadUrl` short-circuits to non-expiring publicUrlBase when configured — must be addressed before portal galleries ship.
- [ ] **RV-006 (P0)** Image pipeline worker `packages/api/src/workers/image-post-process-worker.ts`: EXIF strip, HEIC/WEBP→JPEG, 480px thumbnail, content_hash; `files` columns migration; tests with fixture images in `packages/api/test/files/fixtures/`.
- [x] **RV-007 (P0)** Confidence `_meta` — DONE (CONFIDENCE_LEVELS single source in guardrails; `_meta` validated at validateProposalPayload choke point; `confidenceMetaBlocksAutoApprove` guard — low/very_low never auto-approves AND lands `draft` (not one-tap SMS) in unsupervised tenants; handlers populate from existing signals incl. catalog pricingSource markers; boundary-pinned regression tests per supervisor mode). FOLLOW-UP: remap/strip stale `_meta` field paths when human edits splice lineItems (display-only issue).

---

### Flow 1 — Morning schedule & priority review

**Description:** Owner (driving, 7am) asks "what's my day look like?" — gets schedule, priorities, overnight events, pending approvals; can act by voice.
**Required features:** existing `lookup_appointments`/`lookup_*` skills, F-4 markers, F-9 digest data functions, F-1 supervisor annotations, F-18 routes (P4).
**Acceptance criteria:** voice answer covers today's appointments in order with tech assignment, urgent flags first, then pending-approval count; "approve the first one" works end-to-end (→ Flow 28 tasks); answer uses tenant tz; cassette-graded; nothing from other tenants.
**Atomic tasks:**
- [ ] **RV-010 (P2)** Add `lookup_day_overview` intent + skill `packages/api/src/ai/skills/lookup-day-overview.ts` composing appointments + urgent jobs + pending proposals + overnight voice sessions; register in `intent-classifier.ts` + `voice-action-router.ts`; cassette corpus script `morning-overview`.
- [ ] **RV-011 (P2)** Overnight events query: extend `proposals/inbox.ts` with `listSince(tenantId, since)` returning created/executed/failed since timestamp; unit tests.
- [ ] **RV-012 (P4)** Include route-plan summary in day overview when `route_plans` row exists for today (depends RV-115).

### Flow 2 — On-site job intake & quoting + fast photo upload

**Description:** Owner at a customer site: dictates findings, snaps photos, gets a draft estimate grounded in catalog, photos attached to job.
**Required features:** existing voice intake + draft_estimate chain, F-2 catalog resolver (exists), F-16 photos, F-4 markers.
**Acceptance criteria:** single utterance "new job for Maria Lopez at 12 Oak St, replace water heater, quote it" yields chained create_customer→create_job→draft_estimate proposals (existing chain machinery) with markers; photos taken in-app attach to the job in ≤3 taps; "include the photos in the estimate" sets estimate attachments; estimate line items carry pricingSource; uncatalogued items can't auto-approve.
**Atomic tasks:**
- [ ] **RV-020 (P1)** Generalize capture UI: extract `CameraCapture` from `packages/web/src/components/jobs/AddEntrySheet.tsx` into `packages/web/src/components/attachments/CaptureSheet.tsx` (entity-agnostic: job/invoice/estimate context prop, category chips, ≤3-tap path); wire into job detail; component tests.
- [ ] **RV-021 (P1)** Estimate attachments UI: render attachments on `packages/web/src/components/estimates/EstimatesPage.tsx` detail + attach action via CaptureSheet; API client `packages/web/src/api/attachments.ts`; tests.
- [ ] **RV-022 (P1)** Voice intent `attach_photo`: add to `intent-classifier.ts`; task handler `packages/api/src/ai/tasks/attach-photo-task.ts` (recency-window photo selection, entity resolution via F-3, direct attach same-entity / `attach_photos` proposal cross-entity); new proposal type `attach_photos` per 8-step recipe (`proposal.ts`, `contracts.ts`, `execution/handlers.ts`); cassette script.
- [ ] **RV-023 (P1)** `send_estimate` handler bundling: extend `proposals/contracts.ts sendEstimatePayloadSchema` with `attachmentIds[]` + `makeAttachmentsPortalVisible`; `SendEstimateExecutionHandler` flips `portal_visible` inside execution txn; tests.

### Flow 3 — Customer communication

**Description:** Routine outbound comms ("tell Mrs. Patel we're running 20 min late") via brand-voiced SMS, proposal-gated.
**Required features:** existing `notify_delay`/comms proposals + S1–S10 templates, F-7 brand voice, F-4 markers.
**Acceptance criteria:** utterance → comms-class proposal with rendered message preview; never auto-approves (comms class — existing invariant); message passes deviation grading; delivery tracked in `message_dispatches`; STOP/quiet-hours respected (existing).
**Atomic tasks:**
- [ ] **RV-030 (P3)** Free-form customer message intent `send_customer_message` + proposal type (comms-class) + handler delivering via existing dispatch infra with BrandVoiceComposer; files per 8-step recipe + `ai/tasks/send-message-task.ts`; cassette.
- [ ] **RV-031 (P3)** Deviation grading hook in composer: `ai/brand-voice/composer.ts` calls `grade_brand_voice` task (depends RV-090); below threshold → proposal flagged, blocked from auto-send path; tests.

### Flow 4 — Change orders and upsells + photo documentation

**Description:** Mid-job scope change: "add a shutoff valve, $140, send Maria the updated estimate" + before photos as justification.
**Required features:** existing `update_estimate` editActions + revision versioning (m121), F-16, F-2.
**Acceptance criteria:** voice update produces `update_estimate` proposal showing diff (document_revisions); customer re-approval flow triggers (re-send with new view token), prior acceptance invalidated; photos attached to estimate visible on `/e/:id` after send; audit trail links revisions.
**Atomic tasks:**
- [ ] **RV-040 (P2)** Voice change-order path: ensure `update_estimate` task handler supports add-line via utterance with catalog resolution (extend `ai/tasks/estimate-task.ts` update path); cassette script `change-order`.
- [ ] **RV-041 (P1)** Photos on `/e/:id`: extend `estimates/public-estimate-service.ts` to include portal-visible attachments (presigned thumbs); render gallery section in `web/src/components/customer/EstimateApprovalPage.tsx`; mobile e2e extension in `e2e/estimate-approval-mobile.spec.ts`.
- [ ] **RV-042 (P2)** Re-approval invalidation test hardening: accepted estimate + update → status back to ready→sent, old acceptance recorded; integration test in `packages/api/test/estimates/` (verify existing behavior, add if missing).

### Flow 5 — Technician status updates + time tracking + photos

**Description:** Tech texts/says "on site at Patel", clocks in, attaches arrival photos; owner sees presence on dispatch board.
**Required features:** existing tech-status SMS keyword router + time entries + dispatch presence, F-16, F-20.
**Acceptance criteria:** SMS "STARTED" from a registered tech phone updates job status + opens time entry (verify existing; add gaps); photo MMS attaches to the active job; dispatch board reflects within 5s (existing stream).
**Atomic tasks:**
- [ ] **RV-050 (P2)** MMS ingestion: extend `sms/inbound-dispatch.ts` to detect media URLs on tech messages → download via Twilio media API → attach to tech's active job (active time entry's job_id) through AttachmentService (source='sms'); tests with mocked Twilio media.
- [ ] **RV-051 (P2)** Voice clock-in hardening: `log_time_entry` task handler resolves job by name (F-3) and confirms ("Clocking you in on Patel — right?"); cassette.
- [ ] **RV-052 (P4)** GPS-stamped punches: optional lat/lng on `POST /api/time-entries` (migration columns per F-20); web capture from geolocation with permission fallback; tests.

### Flow 6 — End-of-day reconciliation

**Description:** Owner reviews the day: what closed, what's unbilled, what needs approval — then the digest lands.
**Required features:** F-9 digest, existing auto-invoice-on-completion (m138), F-19.
**Acceptance criteria:** digest SMS at configured time with money/jobs/tomorrow/approvals(one-tap)/flags; web `/digest` matches; unbilled completed jobs listed with "invoice it" one-tap creating `draft_invoice` proposal; numbers match money dashboard.
**Atomic tasks:**
- [ ] **RV-060 (P2)** `daily_digests` migration + `packages/api/src/digest/digest-service.ts` (pure compute functions reusing `reports/money-dashboard.ts` query fns — export them) + unit tests with fixture data.
- [ ] **RV-061 (P2)** `workers/daily-digest-worker.ts`: 15-min sweep, tenant-tz time matching, narrative via BrandVoiceComposer, SMS dispatch with one-tap links (`createOneTapApproveToken`), idempotent per (tenant, date); worker tests.
- [ ] **RV-062 (P2)** Digest web view: route `/digest/:date?` in `web/src/routes.ts` + `web/src/pages/digest/DigestPage.tsx`; renders payload sections; component tests.
- [ ] **RV-063 (P2)** Digest settings: `tenant_settings` migration (digest_enabled/time/channel) + settings UI section in `web/src/pages/settings/`; API in `routes/settings`-adjacent; tests.
- [ ] **RV-064 (P2)** Voice `lookup_digest` skill ("read me my day") returning narrative; register intent; cassette.
- [ ] **RV-065 (P2)** Unbilled-jobs digest section + one-tap "invoice it": digest payload includes completed-unbilled jobs; one-tap token variant that mints a `draft_invoice` proposal then redirects to its one-tap approve page; tests.

### Flow 7 — Approval of pending estimates/quotes + photos

**Description:** Owner approves drafted estimates from anywhere: UI, SMS Y/N, one-tap, and now voice; photos visible in review.
**Required features:** existing 3 channels, D1 voice approval, F-4 markers, F-16 thumbnails in review surfaces.
**Acceptance criteria:** all four channels approve the same proposal interchangeably (idempotent, audited with channel); voice approval of money-class requires readback + explicit yes; SMS render includes marker fields; UI proposal card shows attachment thumbnails.
**Atomic tasks:**
- [ ] **RV-070 (P2)** Owner-line voice recognition: in telephony inbound, detect caller = owner phone (`tenant_settings.owner_phone`/backup) → FSM enters `owner_session` mode flag in `ai/agents/customer-calling/types.ts` context; tests.
- [ ] **RV-071 (P2)** `approve_proposal`/`reject_proposal` voice intents + owner-mode task handler `ai/tasks/proposal-approval-task.ts`: resolve target among pending proposals (extend `ai/resolution/entity-resolver.ts` with pendingProposals source — RV-072), readback (type, customer, amount), require explicit confirmation; calls `approveProposal()`/`rejectProposal()` from `proposals/actions.ts`; money/irreversible add challenge question (last 4 of owner phone? configured PIN in tenant_settings) — config `voice_approval_challenge`; cassettes incl. refusal paths.
- [ ] **RV-072 (P2)** Entity-resolver pendingProposals candidate source (F-3); unit tests for ordinal disambiguation ("the second one").
- [ ] **RV-073 (P2)** Audit channel tagging: `approveProposal()` accepts `channel: 'ui'|'sms'|'one_tap'|'voice'` recorded in audit metadata; backfill call sites; tests.
- [ ] **RV-074 (P2)** SMS render markers: `proposals/sms/render.ts` renders `(?)` per medium fields, blocks compact render for low (F-4 rules); snapshot tests.
- [ ] **RV-075 (P1)** Proposal card thumbnails: web inbox/proposal components render attachment thumbs when payload references attachments; tests.

### Flow 8 — Handling customer issues + photo evidence

**Description:** Complaint call → empathetic handling, issue logged with photos, owner notified, resolution proposal (revisit/credit).
**Required features:** existing escalation + notes, F-6 triage signals, F-16, comms proposals.
**Acceptance criteria:** complaint intent creates `add_note`(pinned) + owner-notification path; "send Joe back tomorrow" books revisit linked to original job; credit offer is money-class (always owner-approved); customer photos arrive via portal request flow.
**Atomic tasks:**
- [ ] **RV-080 (P2)** Complaint intent + handler: `complaint` intent → pinned note + `callback` proposal + owner SMS for high-severity (sentiment grade); cassette.
- [ ] **RV-081 (P2)** Revisit linkage: `create_appointment` payload supports `linkedJobId` revisit semantics (no new job) — extend `contracts.ts createAppointmentPayloadSchema` + handler; tests.
- [ ] **RV-082 (P1)** Customer photo upload on portal issue/service request (shared with Flow 12/21): token-scoped presign `POST /api/portal/:token/uploads` (rate-limited, image-only) in `routes/portal`-adjacent + attach to created lead/request; web portal form file input; tests.

### Flow 9 — Follow-up on pending items

**Description:** "What am I waiting on?" — unaccepted estimates, unpaid invoices, unanswered recovery SMS; nudge actions.
**Required features:** existing reminder/dunning/expiry workers, F-9 data fns, comms proposals.
**Acceptance criteria:** voice answer lists aging estimates/invoices with ages; "nudge Maria about the estimate" → comms proposal using existing estimate-reminder template; dunning state visible; no duplicate nudges inside provider cooldowns (existing reminder idempotency reused).
**Atomic tasks:**
- [ ] **RV-085 (P2)** `lookup_pending_items` skill composing estimate (sent, not accepted), invoice (open/overdue + dunning stage), recovery threads unanswered; intent registration; cassette.
- [ ] **RV-086 (P2)** `send_estimate_nudge` proposal type (comms) reusing `workers/estimate-reminder-worker.ts` send path as handler dependency; 8-step recipe; cooldown check against `message_dispatches`; tests.

### Flow 10 — Customer receives & approves estimate + photos (Client Hub)

**Description:** Customer gets SMS/email link → `/e/:id` with photos, line items, deposit; approves (e-signature-lite) and pays deposit.
**Required features:** existing approval page + deposits + view tokens, RV-041 photos, F-10.
**Acceptance criteria:** photos render in gallery above line items at 320px; acceptance records selection (m128) + consent event; deposit flow unchanged (regression); accepted estimate visible in portal hub with photos.
**Atomic tasks:**
- [ ] **RV-041** (shared, Flow 4).
- [ ] **RV-100 (P1)** Acceptance e-sign-lite: typed-name attestation field stored in `accepted_selection_json` + consent_events row (kind 'esign'); extend `EstimateApprovalPage.tsx` + `public-estimate-service.ts`; tests.
- [ ] **RV-101 (P1)** Portal estimate list/detail photos: `PortalEstimateList.tsx` detail shows visible attachments; tests.

### Flow 11 — Customer pays an invoice

**Description:** `/pay/:id` with photos of completed work, Stripe payment, receipt; owner notified by SMS.
**Required features:** existing payment page + reconciler, F-16 photos on invoice page, payment notification.
**Acceptance criteria:** payment success → reconciler updates invoice (existing); owner SMS "Maria paid $480 — invoice 1042 settled" within 60s; photos visible pre-payment; partial payments render remaining due (existing — regression).
**Atomic tasks:**
- [ ] **RV-105 (P1)** Photos on `/pay/:id`: extend `invoices/public-invoice-service.ts` + `InvoicePaymentPage.tsx` gallery; tests.
- [ ] **RV-106 (P2)** Payment-received owner notification: payment webhook success path enqueues owner SMS (template S-new in `shared/src/contracts/sms-templates.ts`) — notification, not proposal (informational); idempotent per payment id; tests.

### Flow 12 — Customer requests service

**Description:** Customer (portal or new caller) requests service with photos; becomes lead/job + booking offer.
**Required features:** existing portal request + booking page + leads + V1/V3/V4 assistants, RV-082 photos.
**Acceptance criteria:** portal request with 2 photos → lead with attachments; voice path books via existing booking flow; owner sees photos on lead before approving booking proposal.
**Atomic tasks:**
- [ ] **RV-082** (shared, Flow 8).
- [ ] **RV-110 (P1)** Lead detail attachments in web (`pages/leads/`) + lead→job attachment carry-over on `convert_lead` execution (handler copies attachment links); tests.

### Flow 13 — Dropped-call recovery

**Description:** Mid-call drop → context-aware SMS in ≤90s; reply resumes; mid-proposal drops reference proposal state (F-5).
**Atomic tasks:**
- [ ] **RV-115 (P2)** FSM drop-state capture: on call termination without `closing`, persist `{state, intent, entitiesResolved, proposalIds}` snapshot to `dropped_call_recoveries.context` (extend table via migration); handler composes state-aware cue; tests per FSM state.
- [ ] **RV-116 (P2)** Recovery reply resume: inbound reply on recovery thread routes to a resume handler (continue via SMS: confirm pending booking / create call_me_back_task); extend `sms/inbound-dispatch.ts` thread matching; tests.
- [ ] **RV-117 (P5)** Streaming-mode drop detection: media-streams adapter emits same termination event into recovery scheduler; test with simulated WS close.
**Acceptance criteria:** as F-5 spec; all suppression rules regression-tested.

### Flow 14 — Vulnerability & high-urgency triage + photo documentation

**Description:** Distressed/at-risk caller → score → patch owner through / priority booking; evidence photos attachable to resulting job (F-6).
**Atomic tasks:**
- [ ] **RV-120 (P2)** `triage_events` migration + repo; persist every `evaluateTriage` outcome with signals; tests.
- [ ] **RV-121 (P2)** Patch-through execution: `ai/skills/patch-owner-through.ts` using `twilio-call-control.ts` conference (announce → bridge); fallback ladder (on-call → voicemail+SMS+urgent callback task); integration-style tests with mocked call control.
- [ ] **RV-122 (P2)** Turn-batch vulnerability classifier task (`grade_vulnerability` gateway task, cassettes incl. counter-examples); wire into FSM turn post-processing behind per-tenant flag.
- [ ] **RV-123 (P2)** Mark-customer-vulnerable via `update_customer` proposal path (payload extension, m113 fields); handling changes (slower pace prompts, no upsells — flag read in task handlers); tests.
- [ ] **RV-124 (P2)** Digest flags section includes triage events (extends RV-060 payload).
**Acceptance criteria:** as F-6 spec.

### Flow 15 — Recording disclosure + custom forms + photos

**Description:** Compliance end-to-end: disclosure/consent ledger on calls; on-site required checklist with photo evidence before completion (F-12 + F-21).
**Atomic tasks:**
- [ ] **RV-130 (P2)** `consent_events` migration + ledger writes from disclosure skill + objection intent (pause recording via call control); derived `customers.consent_status` updater; tests.
- [ ] **RV-131 (P2)** Disclosure grader: add disclosure-timing check to layer-1 graders (`ai/voice-quality/graders/`) asserting disclosure ≤10s post-greeting across corpus.
- [ ] **RV-132 (P2)** Retention purge worker (recordings past `recording_retention_days`, legal_hold exempt): migration + `workers/recording-retention-worker.ts`; dev-storage integration test.
- [ ] **RV-133..137** → forms tasks live in Flow 26 (RV-180..186); this flow consumes them.
**Acceptance criteria:** as F-12 spec + gated completion per F-21.
### Flow 16 — Emergency fast-path

**Description:** "Gas is leaking everywhere" → safety script → immediate transfer + urgent job + owner page (F-13).
**Atomic tasks:**
- [ ] **RV-140 (P2)** Keyword interrupt: emergency keyword scan on every transcript chunk (incl. Deepgram interims in streaming mode) in FSM event pre-filter — no LLM round-trip; unit tests on keyword table merge (platform + `supervisor_policies.rules.emergencyKeywords`).
- [ ] **RV-141 (P2)** `EmergencyDispatchExecutionHandler` (closes the missing-handler gap): atomically create urgent job + appointment hold + owner/on-call SMS page; register in `execution/handlers.ts`; tests.
- [ ] **RV-142 (P2)** Safety script + jurisdiction-aware 911 line in FSM `escalating` entry for emergency cause; cassette `emergency-gas-leak` with timing assertion ≤15s to transfer attempt.
- [ ] **RV-143 (P2)** Page-retry ladder (3× 2-min owner SMS if transfer unanswered) via `call_me_back_tasks` urgent priority; worker tests.
**Acceptance criteria:** as F-13 spec; e2e in qa-matrix voice-gates.

### Flow 17 — Maintenance plans / recurring services + photos

**Description:** Plan awareness in voice, plan creation by voice, run-visit checklists + photos, upsells (F-15).
**Atomic tasks:**
- [ ] **RV-150 (P3)** `create_agreement` proposal type + payload schema + handler (8-step recipe) calling `agreements/agreement-service.ts`; idempotency (customer,name,recurrence); tests.
- [ ] **RV-151 (P3)** Entitlement answers: extend `ai/skills/lookup-agreements` skill with covered/next-visit/expired responses; cassette.
- [ ] **RV-152 (P3)** Plan upsell hook: on job completion in plan-eligible category (tenant-configured categories), draft plan-estimate proposal; 90-day per-customer counter via `tenant_budget_counters`; tests.
- [ ] **RV-153 (P3)** Agreement-run jobs attach required form templates (applies_to.agreement_runs) + photo slots; depends RV-180; tests.
**Acceptance criteria:** as F-15 spec.

### Flow 18 — Automated review responses

**Description:** Review lands → brand-voiced draft proposal → owner one-tap/voice approve → posted + verified (F-14).
**Atomic tasks:**
- [ ] **RV-160 (P3)** Wire `workers/google-reviews.ts` poller → `reputation/draft-public-response.ts` → `review_response_proposal` creation per new review (idempotent per review id); negative-review policy (≤2★: low marker + private follow-up suggestion attached to payload); tests.
- [ ] **RV-161 (P3)** Post-execution verification: `ReviewResponseExecutionHandler` re-reads posted reply, retries once, else execution_failed with reason; mocked Google client tests.
- [ ] **RV-162 (P3)** Superseding on review edit/delete: poller expires pending proposal and re-drafts; tests.
- [ ] **RV-163 (P3)** Digest "reviews handled" section (extends RV-060 payload).
**Acceptance criteria:** as F-14 spec.

### Flow 19 — Voice-based expense logging + time + photos + accounting

**Description:** "Log $84 at the supply house for the Patel job" + receipt photo; flows to job costing and QBO.
**Required features:** existing `log_expense` proposal, F-16 (receipt category), F-17, F-19.
**Atomic tasks:**
- [ ] **RV-170 (P1)** Receipt photo attach: expenses entity_type in attachments (done in RV-005 enum); expense detail UI attach + thumbnail in approval card; tests.
- [ ] **RV-171 (P2)** Voice expense + photo: extend `attach_photo` recency selection to target the just-created expense proposal ("snap the receipt" prompt in voice flow after log_expense); cassette.
- [ ] **RV-172 (P4)** Expense → accounting outbox event (depends RV-200 outbox): push as QBO Purchase with attachment link; tests.
**Acceptance criteria:** expense proposal carries receipt thumb; approved expense lands in job profitability (F-19) and QBO (when connected).

### Flow 20 — Financial overview + advanced reporting + accounting integration

**Description:** "How did we do this month?" voice + web reports + QBO reconciliation state (F-19, F-17).
**Atomic tasks:**
- [ ] **RV-175 (P4)** `users.hourly_cost_cents` migration + settings UI (owner-only RBAC); tests.
- [ ] **RV-176 (P4)** Report modules in `packages/api/src/reports/`: `job-profitability.ts`, `tech-utilization.ts`, `ar-aging.ts`, `plan-revenue.ts`, `ai-ops.ts` (+ pg counterparts, tenant-tz util reuse, CSV export endpoints); fixture-based unit tests each.
- [ ] **RV-177 (P4)** Web report pages under `web/src/components/reports/` + routes + nav; component tests.
- [ ] **RV-178 (P4)** Voice financial answers: extend `lookup_revenue` skill with profitability/aging questions; cassettes.
**Acceptance criteria:** as F-19 spec.

### Flow 21 — Onboarding new customers + custom forms + photos

**Description:** New customer onboarded by voice or portal intake with tenant's intake form + site photos.
**Required features:** existing onboarding_* proposals + IntakeFormPage, F-21, F-16.
**Atomic tasks:**
- [ ] **RV-179 (P4)** Intake form templating: `IntakeFormPage.tsx` renders tenant's active intake `form_template` (fallback to current static form); responses create lead + form_response + attachments; tests. (Depends RV-180/182.)
**Acceptance criteria:** intake with photos creates lead carrying form response + attachments; voice intake unchanged (regression).

### Flow 22 — Team management + time + route + photos

**Description:** Owner manages techs: assignments (exists), working hours (exists), timesheets (F-20), routes (F-18), per-tech photo accountability.
**Atomic tasks:**
- [ ] **RV-190 (P4)** Timesheet review UI: `web/src/pages/team/TimesheetsPage.tsx` (per tech/day grid, anomaly flags); API `routes/timesheets.ts` (list with anomalies); tests.
- [ ] **RV-191 (P4)** `update_time_entry` proposal type (capture, edited_reason required) + handler; period lock check; 8-step recipe; tests.
- [ ] **RV-192 (P4)** `payroll_periods` migration + approve/lock service + CSV export endpoint (Gusto-compatible columns); owner RBAC; tests.
- [ ] **RV-193 (P4)** Photo accountability: completion-category photo counts per tech in tech-utilization report (joins attachments); tests.
**Acceptance criteria:** as F-20 spec.

### Flow 23 — Photo & Document Management (CORE — jobs & invoices, multi-tenant) ★

**Description:** The flagship: capture→attach→annotate→pair→share→audit across jobs/invoices/estimates, voice + one-tap + offline (F-16 in full).
**Required features:** F-16, F-10, F-4 (markers on voice-attach proposals), RV-005/006 foundations.
**Acceptance criteria:** the full F-16 acceptance list, plus: owner can do the entire loop voice-only ("attach my last three photos to the Henderson invoice, make the before-and-after visible to the customer, and send it") yielding one chained proposal set; audit timeline shows upload→annotate→visibility→send with actors; W23 e2e suite green in qa-matrix.
**Atomic tasks (beyond shared RV-005/006/020/021/022/023/041/075/082/105):**
- [ ] **RV-300 (P1)** Annotation canvas: `web/src/components/attachments/AnnotateDialog.tsx` (arrows/circles/text, touch-friendly), saves annotated copy via presign+attach with `annotated_file_id` linkage; component + integration tests.
- [ ] **RV-301 (P1)** Before/after pairing UI: pair picker on job gallery (`web/src/pages/jobs/JobPhotos.tsx` extension), sets pair_group_id/pair_role; side-by-side render component shared with portal; tests.
- [ ] **RV-302 (P1)** Offline outbox: `web/src/lib/uploadOutbox.ts` (IndexedDB queue, client dedupe key, backoff) + service worker registration (background sync where supported, foreground drain fallback) + outbox badge UI; Playwright offline e2e `e2e/photo-offline.spec.ts`.
- [ ] **RV-303 (P1)** Server dedupe: attach endpoint honors (tenant, content_hash, entity) 24h dedupe + idempotent client key; tests.
- [ ] **RV-304 (P1)** Documents (PDF) support: kind='document' upload path (no thumbnail → type icon), invoice/estimate/job doc lists; size cap 25MB; tests.
- [ ] **RV-305 (P1)** Attachment audit events (`attachment.uploaded/annotated/visibility_changed/archived`) emitted from AttachmentService; timeline rendering in job detail; tests.
- [ ] **RV-306 (P1)** Gallery virtualization + lazy thumbs for 200-photo jobs; perf test budget in Playwright trace.
- [ ] **RV-307 (P1)** Voice chained utterance (attach+visibility+send) decomposition coverage: extend decompose corpus + chain ENTITY_KIND_TO_PAYLOAD_PATH if needed for `attach_photos`→`send_invoice` ordering; cassette `photo-attach-send-chain`.
- [ ] **RV-308 (P1)** W23 e2e suite: `e2e/qa-matrix/photo-management.spec.ts` covering capture, invoice attach, annotate, pair, visibility, portal view, cross-tenant 404.

### Flow 24 — Accounting integration (multi-tenant) (F-17)

**Atomic tasks:**
- [ ] **RV-200 (P4)** Migrations `accounting_entity_map` + `accounting_outbox` + tenant_settings account-map fields; repos; tests.
- [ ] **RV-201 (P4)** `AccountingProvider` interface + `packages/api/src/integrations/quickbooks/` client (OAuth2 + token refresh via secret refs, Customer/Invoice/Payment/Purchase push, SyncToken sparse updates, rate-limit token bucket); contract tests against recorded fixtures.
- [ ] **RV-202 (P4)** OAuth connect flow: routes (`/api/integrations/accounting/connect|callback`) using fixed `oauth_states` (RV-002); `connect_accounting` (capture) + `disconnect_accounting` (irreversible) proposal types; settings UI card with status; tests.
- [ ] **RV-203 (P4)** Outbox enqueue hooks on domain events (invoice issued/updated/paid, payment recorded/refunded, customer created/updated, expense approved) — single chokepoint module `packages/api/src/accounting/events.ts`; tests.
- [ ] **RV-204 (P4)** `workers/accounting-sync-worker.ts`: per-tenant serial drain, retries/DLQ, entity-map upserts, reauth_required handling; kill-resume idempotency test.
- [ ] **RV-205 (P4)** Backfill job on connect (open invoices + customers, oldest-first, throttled) + progress in settings UI; tests.
- [ ] **RV-206 (P4)** Nightly drift checker + digest flag (extends RV-060); tests.
- [ ] **RV-207 (P4)** Xero provider implementing the same interface; contract tests. (Separate sub-plan; after QBO stable.)
**Acceptance criteria:** as F-17 spec.

### Flow 25 — Route optimization (multi-tenant) (F-18)

**Atomic tasks:**
- [ ] **RV-210 (P4)** `route_plans` migration + repo; tests.
- [ ] **RV-211 (P4)** Travel-matrix cache (geohash-pair key, 24h TTL, table or llm_cache-style) over `scheduling/travel-time/google-provider.ts`; cost-guard unit tests.
- [ ] **RV-212 (P4)** Optimizer `packages/api/src/scheduling/route-optimizer.ts`: NN seed + 2-opt under window/working-hour constraints (pure, deterministic, fixture-tested incl. property test "zero window violations").
- [ ] **RV-213 (P4)** `workers/route-plan-worker.ts` (5am tenant-tz + on-demand endpoint) + `apply_route_plan` proposal type/handler executing via existing reschedule handlers + bundled customer-notify comms proposals for >X-min shifts; tests.
- [ ] **RV-214 (P4)** Dispatch board route view: ordered stop list per tech lane with ETAs + apply button (`web/src/pages/dispatch/`); tests.
**Acceptance criteria:** as F-18 spec.

### Flow 26 — Custom forms & checklists + photo evidence (multi-tenant) (F-21)

**Atomic tasks:**
- [ ] **RV-180 (P4)** Migrations `form_templates` + `form_responses`; repos + Zod field schemas in `packages/api/src/forms/`; tests.
- [ ] **RV-181 (P4)** Template CRUD API + minimal builder UI (`web/src/pages/settings/FormsPage.tsx`: list editor, field rows, version activate); owner RBAC; tests.
- [ ] **RV-182 (P4)** Response fill UI on job detail (tech flow): field renderer incl. photo fields via CaptureSheet + outbox; submit immutability; tests.
- [ ] **RV-183 (P4)** Completion gating: job status service blocks `completed` when required templates unsubmitted (clear error payload listing them); API + UI handling; tests.
- [ ] **RV-184 (P4)** Voice checklist runner: FSM sub-flow walking required fields ("step 2: photo the panel — say done when taken"); cassette for 5-field template.
- [ ] **RV-185 (P4)** Response PDF export (photos inline) reusing print pipeline; tests.
- [ ] **RV-186 (P4)** Portal-facing forms for Request Service / intake (customer fill, token-scoped); shared renderer; tests.
**Acceptance criteria:** as F-21 spec.

### Flow 27 — Multi-action voice utterances

**Description:** "Create a job for Maria, book Joe Tuesday morning, and send her the spring-tune-up estimate" → one chain (EXISTS — P9-016); extend to new types.
**Atomic tasks:**
- [ ] **RV-220 (P2)** Chain coverage for new types: add `attach_photos`, `create_agreement`, `apply_route_plan` to `chain.ts ENTITY_KIND_TO_PAYLOAD_PATH` where consuming refs; decomposer prompt corpus additions; tests for forced-draft of dependents (existing invariant).
- [ ] **RV-221 (P2)** Chain SMS render: multi-proposal chains render as one summarized SMS with single one-tap approving the chain head set (chain-aware token: approves all capture-class members whose refs resolve; money/comms members still individually gated); tests incl. partial-failure cascade messaging.
**Acceptance criteria:** 3-action utterance yields one chain, one SMS, correct execution order, cascade-fail messaging on parent failure (existing chain tests extended).

### Flow 28 — Voice-driven proposal revision and voice approval

**Description:** Owner: "change the second line to $200, then approve it" — voice edit + voice approve in one session.
**Atomic tasks:**
- [ ] **RV-225 (P2)** Voice edit intent `edit_proposal` mapping utterance → `editActions` (reuse SMS edit interpreter `proposals/sms/interpret-edit.ts` LLM seam — extract shared module `proposals/edit-interpreter.ts`); applies via existing edit path (re-render/reapproval machinery m156-158 reused); cassettes for line edits, field corrections, ambiguous refs.
- [ ] **RV-226 (P2)** Edit-then-approve sequencing: voice session holds pending-edit lock; approval allowed only after edit applied (parity with RV-004); readback of the EDITED values before confirm; cassette.
**Acceptance criteria:** edited value is what executes (assert payload at execution); pending-edit block enforced across all 4 channels; audit shows edited→approved sequence with channel=voice.

### Flow 29 — Correction loop

**Description:** Owner's repeated edits become adopted drafting rules (F-8).
**Atomic tasks:**
- [ ] **RV-230 (P3)** `tenant_correction_rules` migration + repo; tests.
- [ ] **RV-231 (P3)** Distiller worker: cluster `proposal_analytics.edited_fields` (30d) per scope, PII-redact, LLM summarize clusters ≥3 → suggested rules + `adopt_correction_rule` proposal (new type, capture); cassette for summarizer; idempotent re-runs.
- [ ] **RV-232 (P3)** Prompt injection: task-handler context loader injects active rules per scope (≤600 tokens, hit_count tracking on unedited-approve); tests proving a rule changes draft output (cassette pair before/after).
- [ ] **RV-233 (P3)** Rules settings UI (list/retire) + retire path as proposal; tests.
**Acceptance criteria:** as F-8 spec.

### Flow 30 — Maintaining consistent brand voice (per-tenant)

**Description:** Locked profile governs all AI text; deviations blocked and visible (F-7).
**Atomic tasks:**
- [ ] **RV-090 (P3)** `brand_voice_profiles` + `brand_voice_deviations` migrations + repos; backfill from `tenant_settings.brand_voice`; tests.
- [ ] **RV-091 (P3)** `grade_brand_voice` gateway task + grader prompt + cassette suite (≥10 pos/neg pairs); deviation write-through.
- [ ] **RV-092 (P3)** Composer enforcement: `ai/brand-voice/composer.ts` loads active profile (60s cache), post-grades, returns `{text, deviation}`; call-site sweep so ALL outbound AI text routes through composer (audit grep + lint rule `no-direct-llm-outbound` in eslint config); tests.
- [ ] **RV-093 (P3)** `update_brand_voice` proposal type (irreversible) + handler (new version row + activate); lock enforcement (403 on direct edit when locked); settings UI with version history; tests.
- [ ] **RV-094 (P3)** Deviation rate in AI-ops report (depends RV-176) + digest flag.
**Acceptance criteria:** as F-7 spec.

---

**Flow→task coverage check:** every flow above lists only tasks; flows 1–30 ↔ features F-0..F-21 cross-reference complete (each feature is consumed by ≥1 flow; each flow's tasks are defined exactly once). Total atomic tasks: 121.
## 7. UI/UX Patterns & Client Hub / Photo Upload Specification

### 7.1 Photo upload to jobs & invoices — interaction spec

**One-tap path (tech/owner in app, ≤3 taps):**
1. Tap camera FAB on job/invoice/estimate detail (context = that entity, pre-selected).
2. Shutter (native camera via `CaptureSheet`; multi-shot supported — shutter N times).
3. Tap ✓ — category chip row (Before / After / Problem / Completion / Receipt — defaults to last used) and optional caption are on the confirm screen but skippable.
Optimistic thumbnail appears in the entity timeline instantly with an uploading spinner; failure → outbox badge, never a modal.

**Voice path:** "Attach the photos I just took to the Henderson invoice" → recency window selection (default: last 15 min, same uploader) → if same-entity context: direct attach + spoken confirmation; if cross-entity: `attach_photos` proposal whose UI card and SMS render thumbnails + target. "Make the before-and-after visible to the customer and send it" chains visibility into `send_invoice` (Flow 27 machinery).

**Annotation:** long-press photo → Annotate (arrow / circle / freehand / text, 44px+ touch targets); Save creates the annotated copy — gallery shows annotated with an "annotated" badge; tap-hold to peek original. Original never modified (evidence rule, D3).

**Before/after:** in gallery, select photo → "Pair…" → pick counterpart (filtered to same job, opposite category suggested first). Pairs render as a single side-by-side card with a draggable divider in portal and a static split in SMS-linked web views.

**Offline:** capture always works; outbox chip in the header ("3 queued") with per-item retry state; drain is automatic; duplicates impossible (content_hash + client key). Airplane-mode test is a release gate (RV-302/308).

**Privacy & visibility:** everything defaults internal. Customer exposure happens only by (a) toggling "Visible to customer" on a photo (audited) or (b) approving a send proposal that bundles visibility. Portal/public pages query `portal_visible=true` server-side; presigned GET URLs ≤10 min TTL. Vulnerability/triage data never renders on any customer surface.

**Audit:** entity timeline interleaves attachment events (uploaded by / annotated / made visible / archived) with job timeline events — one chronological story per job.

### 7.2 Client Hub (portal) spec

- `/portal/:token` gains a **Photos** tab: grouped by job (newest first), pair cards first, captions shown, lightbox with pinch-zoom, lazy-loaded 480px thumbs (full-size on lightbox only).
- `/e/:id` (estimate): photo gallery section between header and line items; acceptance unchanged below.
- `/pay/:id` (invoice): completed-work gallery above amount due — *show the value before asking for money*.
- Request Service: photo picker (≤10), uploads token-scoped + rate-limited (RV-082).
- All pages keep the existing 320px/44px mobile standards; Lighthouse ≥85 on a 50-photo gallery.

### 7.3 Owner surfaces

- **Proposal cards** (inbox/queue): confidence badge top-right (green/amber/red/grey per F-4), per-field `(?)` markers, attachment thumbnails strip, supervisor annotation line ("⚠ price 2.1× catalog median"), one-tap Approve with 5s undo snackbar (existing D9).
- **SMS grammar (consistent across all features):** `[Rivet] <summary>. <markers if any>. Reply Y to approve, E to edit, N to reject — or tap <link>`; digest variant ends with deep link. Low-confidence proposals never get a Y-able SMS (review-in-app link only).
- **Voice approval ritual (D1):** readback ("Estimate for Maria Lopez, three items, $1,240 — approve?") → explicit "yes/approve" required; money-class adds challenge; anything else ("hmm", silence) → no action + offer to keep pending.
- **Digest layout (SMS ≤480 chars):** `Day: $X in, N jobs done. Tomorrow: M visits, first 8:00. Approvals: 3 waiting — [1] est $450 Lopez <link> … Flags: 1 review, 1 overdue.` Web `/digest` mirrors with full sections.

## 8. Testing Strategy

**Layered, matching existing infra:**

1. **Unit (Vitest, packages/api + web):** every new module ships with tests in the same PR (TDD per CLAUDE.md). Pure logic extracted deliberately (optimizer, policy engine, digest compute, confidence mapping) for fixture testing.
2. **Tenant-isolation integration (testcontainers PG + real RLS):** RV-003 leak suite is the foundation; **every new table** added by this plan gets a leak case appended (checklist item in each migration task's PR). Plus: GUC-unset zero-rows test, worker-iteration scoping test (digest/accounting workers seeded with 2 tenants asserting per-tenant outputs), portal/presign foreign-entity 404 tests.
3. **Voice cassette suites (CassetteLLMGateway):** new corpus scripts per voice feature — `morning-overview`, `owner-approve`, `owner-approve-money-challenge`, `change-order`, `photo-attach-send-chain`, `emergency-gas-leak`, `vulnerability-distress`, `checklist-run`, `digest-readback`, brand-voice pos/neg pairs, correction before/after pair. Launch gate (`voice-quality.launch-gate.entry.test.ts`) must stay green; new graders: disclosure-timing (RV-131), brand-deviation, approval-readback-correctness (the readback must match payload — guards against approving the wrong thing).
4. **Proposal-gate invariants (property-style unit tests):** no proposal type executes from non-approved status; comms/money/irreversible never auto-approve; low/very_low confidence never auto-approves; pending-edit blocks approval on ALL four channels; chain dependents stay draft until refs resolve. These run as one invariant suite over `VALID_PROPOSAL_TYPES` so every future type is covered automatically.
5. **Photo edge-case suite:** offline outbox e2e (Playwright offline emulation), dedupe double-tap, HEIC/WEBP fixtures through pipeline, 8MB downscale, annotation original-immutability, visibility-flip audit, S3-PUT-success/attach-fail recovery.
6. **Accounting contract tests:** recorded QBO/Xero sandbox fixtures; kill-resume idempotency; cents↔decimal round-trip property test; two-realm isolation test; drift detection fixture.
7. **E2E (Playwright qa-matrix):** new specs — `photo-management.spec.ts` (W23 gate), digest web view, timesheets, forms gating, route apply; existing mobile/estimate specs extended not duplicated. qa-matrix gate (`scripts/qa-matrix-gate.ts`) thresholds updated to include new specs.
8. **Performance budgets:** capture→timeline p95 <4s (4G profile), TTFA p50 ≤1.2s streamed (Phase 5 gate), report queries <500ms p95 on 10k-invoice fixture, gallery Lighthouse ≥85.
9. **Security checks per phase:** secret-ref-only grep gate for accounting code (no tokens in logs — log-scrub test), presigned URL TTL assertions, portal rate-limit tests, RBAC tests for owner-only surfaces (payroll approve, brand-voice unlock, hourly costs).

## 9. Risks, Mitigations & Success Metrics

**Risks & mitigations:**
- **R1 Voice mis-approval (wrong proposal / misheard yes).** Mitigate: readback-must-match-payload grader, explicit-confirm requirement, money-class challenge, 5s undo retained, channel-tagged audit. Residual risk accepted for capture-class only.
- **R2 Photo pipeline cost/abuse (storage growth, portal upload abuse).** Mitigate: client downscale, thumbnails, per-tenant storage metering into reporting, portal rate limits + image-only sniffing, retention worker.
- **R3 Accounting double-push / drift.** Mitigate: outbox idempotency keys, per-tenant serial drain, SyncToken handling, nightly drift checker, one-way-only v1.
- **R4 LLM grader cost creep (deviation + annotation per outbound).** Mitigate: cheap model routing via existing gateway task config, gateway cache, grade only AI-composed text, per-tenant tier quotas already enforced.
- **R5 Per-tenant flag sprawl.** Mitigate: flags retired after GA per feature (tracked in flag table `updated_at` review), prune task each phase end.
- **R6 Chain complexity explosion (Flow 27 with new types).** Mitigate: ENTITY_KIND map stays the single wiring point; decomposer corpus tests; dependents-forced-draft invariant suite.
- **R7 Media Streams ramp regressions.** Mitigate: per-tenant canary, mid-call Gather fallback, TTFA gate, layer-2 comparative report before widening.
- **R8 Scope risk: Phase 4 is three products.** Mitigate: each Phase-4 track gets its own writing-plans sub-plan before execution (scope-check rule); tracks independently shippable.
- **R9 Vapi/native split ambiguity (D16).** Mitigate: explicit owner decision checkpoint before Phase 2 voice tasks start.

**Success metrics (per tenant, instrumented via existing PostHog + new AI-ops report):**
- Owner app-time: < 10 min/day median (PostHog session time) with ≥80% of approvals via SMS/voice/one-tap (channel-tagged audit).
- Photo: ≥90% of completed jobs have ≥1 photo; capture→attached p95 <4s; ≥60% of invoices sent with photos visible.
- Voice: ≥70% of inbound calls resolved without human transfer (call_summaries); voice approval used ≥3×/week per active owner.
- Trust/safety: 0 cross-tenant incidents (leak suite + prod RLS alerts); 100% mutations through proposals (invariant suite); deviation auto-send block rate trending down as profiles tune.
- Learning: correction-rule adoption ≥1/tenant/month with unedited-approve rate rising on affected scopes.
- Business: invoice→paid median days down 20% post-Client-Hub photos; digest open/click ≥60%.

## 10. Prioritized Next Actions

1. **Decision checkpoint (owner, 10 min):** confirm D16 (deprecate Vapi inbound), D7 (QBO-first), digest default time (6pm tenant-local). Blockers for Phases 2/4 only.
2. **Execute Phase 0 now (tasks RV-001…RV-007, ~7 PRs, fully parallelizable except RV-005→RV-006):** flags, oauth_states RLS, leak suite, SMS edit-parity fix, attachments foundation, image pipeline, confidence meta. Assign each task to one implementation agent (subagent-driven-development); RV-002/003/004 are pure-backend quick wins to start immediately.
3. **Phase 1 (W23) sub-plan execution:** RV-020→023, 041, 075, 082, 100/101, 105, 110, 300→308 — order: CaptureSheet (RV-020) → entity UIs (021/041/105) → voice attach (022/023) → annotation/pairing (300/301) → offline (302/303) → docs+audit+perf (304/305/306) → chain+e2e (307/308).
4. **Phase 2 kickoff after Phase 0:** RV-070→074 (voice approval — the differentiator), RV-060→065 (digest), F-1 supervisor tasks (policy table → sync hook → annotator), RV-140→143 (emergency), RV-120→124 (triage), RV-010/011, RV-085/086, RV-115/116, RV-220/221, RV-225/226.
5. **Write per-track sub-plans (writing-plans skill) before Phase 3 and each Phase 4 track** (accounting / routes / forms / payroll / reporting) — this document is the architecture + task inventory; sub-plans add per-step code detail for implementers.
6. **Stand up metric dashboards** (success metrics above) in the first Phase-2 sprint so the pilot tenants' data validates the thesis from day one.

---
*End of plan. Self-review (spec coverage / placeholder scan / type-name consistency) performed inline; 21 features ↔ 30 flows ↔ 96 atomic tasks cross-referenced.*
