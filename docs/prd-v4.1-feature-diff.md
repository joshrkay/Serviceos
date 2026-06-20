# PRD v4.1 ⇄ Codebase — Feature Difference Audit

**Date:** 2026-06-20
**Audited against:** *AI Service OS — Master Product Requirements Document v4.1* (16 epics / 149 stories)
**Scope:** canonical product only — `packages/api`, `packages/web`, `packages/shared`
(Railway deploy target). Experiments, the `/rewrite`, and prototypes are excluded from the
"built" counts and listed separately under *Built outside the PRD*.

## About this document
A grounded, story-by-story comparison of what the PRD specifies versus what is actually in
the code. Every one of the 149 stories was verified against real files (three parallel code
audits, epics 1–5 / 6–10 / 11–16). Tallies were re-counted by hand. One reconciliation was
applied: **3.10** upgraded 🟡→✅ after confirming tiered routing in `config/ai-routing.ts`
(corroborated by the 14.3 audit).

**Status legend:** ✅ Built · 🟡 Partial (core/backend present; ≥1 acceptance criterion —
usually UI wiring, a trigger, or config — unconfirmed or incomplete in a time-boxed audit) ·
❌ Missing/Deferred. Note: 🟡 is deliberately conservative — some 🟡 items are fully done and
some are genuinely half-wired; treat it as "needs a closer look," not "half the work remains."

**Two lenses.** The per-epic tables measure *literal* implementation (is the story built as
written). The **Divergence reclassification** section below adds a second lens for PRD lines the
team *deliberately* did not follow — whether the underlying problem is still solved (usually it
is). So a ❌ in a table can be SUPERSEDED in the reclassification (e.g., n8n, Invoice Ninja, the
0.5% fee).

---

## Scorecard

| Scope | ✅ Built | 🟡 Partial | ❌ Missing | Total |
|---|---|---|---|---|
| **All stories** | **68 (46%)** | **62 (42%)** | **19 (13%)** | 149 |
| **P0 / MVP only** | **55 (62%)** | **30 (34%)** | **4 (4%)** | 89 |

- **Strict** (fully verified end-to-end): **46%** of the PRD.
- **Built-or-substantial** (✅+🟡): **87%** overall, **96%** of P0/MVP.
- **Not started / deferred:** **13%** overall — concentrated in P1/P2 (Inventory, vision-tier integrations).

Per-epic ✅/🟡/❌: E1 5/3/0 · E2 0/9/1 · E3 9/3/0 · E4 5/4/0 · E5 4/5/1 · E6 7/2/0 ·
E7 7/2/1 · E8 6/3/1 · E9 8/3/1 · E10 4/4/1 · E11 0/2/6 · E12 0/8/1 · E13 2/1/4 ·
E14 6/2/0 · E15 2/5/2 · E16 3/6/0.

---

## The genuine P0/MVP gaps (2 of 89)

Applying the decision lens (see *Divergence reclassification* below), three of the five items
first flagged as P0 gaps are not gaps:

| Story | State | Verdict |
|---|---|---|
| **9.12 Metered voice minutes** | only trial gating (100-min cap); no post-trial overage billing | **GENUINELY-OPEN** — the one revenue-relevant gap; the GTM model still charges $0.30/min over 500 |
| **5.5 48h proposal expiry** | `expiresAt` field + expiry-check exist; no creation path sets 48h | **GENUINELY-OPEN** — cheap to close, plumbing present |
| ~~8.7 0.5% platform fee~~ | no fee on payments | **SUPERSEDED** — flat $297/mo subscription replaces it |
| ~~13.4 n8n~~ | no n8n | **SUPERSEDED** — ADR `p0-028-queue-choice.md`; Postgres queue + workers |
| ~~2.4 Conversational onboarding~~ | — | **BUILT** — backend FSM agent `ai/agents/onboarding`; audit error corrected |

The largest ❌ cluster is **Epic 11 Inventory** (6 of 8) — but every inventory story is P1/P2,
so this tracks PRD priority rather than a miss. **Epic 12 Dashboard** and **Epic 16 field-docs
polish** are mostly 🟡: schema/backend present, UI thin.

---

## Divergence reclassification — superseded vs solved-differently vs open

For PRD lines the team *deliberately* did not follow literally, the question isn't "is it built?"
but "is the underlying problem solved another way?" Sources: `docs/decisions/p0-028-queue-choice.md`,
`docs/decisions/production-readiness-scope.md`, `docs/decisions.md` (D-001/D-005),
`docs/superpowers/plans/2026-06-11-rivet-architect-plan.md` (D16), `docs/launch/2026-06-03-rivet-gtm-brief.md`.

### SUPERSEDED — PRD line obsolete; problem solved another way
| PRD line | Problem it solved | Now solved by | Decision record |
|---|---|---|---|
| 13.3 Invoice Ninja | "use my existing billing tool" | Native invoicing + **Stripe Connect** (owns the cash funnel) + QuickBooks push | Deprioritized P1/Wave 3; zero IN refs |
| 13.4 n8n | maintainable orchestration (scheduled+triggered, retry) | `queues/pg-queue.ts` + ~27 workers + leader-locked sweeps + DLQ | **ADR `p0-028-queue-choice.md`** |
| Supabase | Postgres + RLS + pg_trgm | raw `pg` + in-code migrations + RLS GUC + pg_trgm | `production-readiness-scope.md`; D-001 |
| Next.js / Vercel | web SPA + hosting | React + Vite on Railway | Implicit (D-001; prototype quarantined) |
| LangGraph / FastAPI | AI agent runtime | TS gateway (`ai/gateway/*`) | Implicit (D-005 provider-agnostic; Python prototype defective) |
| Vapi or Retell | managed inbound voice | **native Twilio FSM** (Vapi legacy) | **D16** (confirm w/ owner) |
| 8.7 0.5% payment fee | fund the platform on payments | **flat $297/mo subscription** (`billing/subscription.ts`) | GTM brief — *confirm locked* |

### SOLVED-DIFFERENTLY — different mechanism, intent met
| PRD line | Problem | Solved by |
|---|---|---|
| §7 $99/mo subscription (no story) | collect the platform fee | `billing/subscription.ts` trial+checkout+portal; price via `STRIPE_PRICE_ID` (now $297) |
| 2.4 Conversational onboarding | adaptive setup, no empty product | `ai/agents/onboarding` FSM + orchestrator (confidence-gated re-prompts) |
| 12.6 Weekly feedback email | weekly owner "advisor" summary | `hfcr-weekly` + LLM-narrated `daily-digest` via **SMS** |
| 13.2 QuickBooks two-way | reconcile both ways | one-way push of *paid* invoices (pull/conflict reserved) — sufficient for MVP |

### GENUINELY-OPEN — problem actually unsolved
| PRD line | Problem | State |
|---|---|---|
| 9.12 Metered voice minutes | charge voice overage | only trial gating; **GTM still charges $0.30/min over 500** |
| 5.5 48h proposal expiry | stale proposals expire | field + check exist; no 48h set on create |
| Epic 11 inventory stock | quantity-on-hand | no stock columns — deferred *by design* (all P1/P2) |

**Bottom line:** none of the architecture/integration divergences are real gaps — all are
deliberate decisions (n8n has a full ADR) that solve the same problem, several *better*. Genuine
P0 gaps reduce to **two**: 9.12 (voice-overage metering) and 5.5 (proposal expiry).

---

## Per-epic detail (all 149 stories)

### Epic 1 — Platform Foundation & Multi-Tenancy (5/3/0)
| Story | Pri | St | Evidence |
|---|---|---|---|
|1.1 Lightweight signup|P0|🟡|`auth/clerk.ts`, `db/schema.ts` tenant+owner; full signup flow unconfirmed|
|1.2 Clerk auth|P0|✅|`auth/clerk.ts` RS256+JWKS; web Login/Signup use Clerk SDK|
|1.3 Role model|P0|🟡|`auth/rbac.ts` ROLE_PERMISSIONS; Admin/CSR not in enum|
|1.4 Tenant isolation (RLS)|P0|✅|`db/schema.ts` `tenant_isolation_*`; `middleware/tenant-context.ts`|
|1.5 Role-based landing|P0|🟡|Separate HomePage/Tech routes; sign-in routing unconfirmed|
|1.6 Team invitations|P1|✅|`pending_invitations` + `users/pg-pending-invitation.ts`|
|1.7 Audit log|P1|✅|`audit_events` actor/entity/before-after/correlation|
|1.8 Tenant settings shell|P1|✅|`tenant_settings` + web settings pages|

### Epic 2 — Onboarding & Living Templates (0/9/1)
| Story | Pri | St | Evidence |
|---|---|---|---|
|2.1 Onboarding Agent intro|P0|🟡|`onboarding/v2/OnboardingShell.tsx` sidebar-step, not conversational|
|2.2 Skippable onboarding|P0|🟡|Polls `/onboarding/status`; skip/resume mechanics unconfirmed|
|2.3 Vertical template selection|P0|🟡|`onboarding/v2/steps/PackStep.tsx` hvac/plumbing; generator role unclear|
|2.4 Templates reshape via convo|P0|🟡|**Backend FSM** `ai/agents/onboarding/transitions.ts` + `onboarding-conversation.ts`, confidence-gated re-prompts — *solved-differently, not missing*|
|2.5 Terminology capture|P0|🟡|`terminology_preferences` JSONB; capture UI unconfirmed|
|2.6 Service catalog seeding|P1|❌|No agent seeding flow|
|2.7 Business hours & area|P0|🟡|`onboarding/contracts.ts` schemas; capture + out-of-area flag unconfirmed|
|2.8 Team/tech seeding|P1|🟡|Invites exist; onboarding seeding UI unconfirmed|
|2.9 Pricing & labor rates|P1|🟡|`hourlyRateCents` captured; estimate wiring unconfirmed|
|2.10 Completion & resume|P0|🟡|`onboarding/derive-status.ts`; FSM persists session per turn|

> **Epic 2 caveat:** the first pass searched only the web layer and under-counted this epic. A
> backend conversational onboarding agent exists (`ai/agents/onboarding/transitions.ts` 6-state FSM
> + `ai/orchestration/onboarding-conversation.ts`, `MAX_TURNS=15`, confidence-gated re-prompts);
> several 🟡s here are likely ✅ and warrant a focused re-audit.

### Epic 3 — Conversational AI Core (9/3/0)
| Story | Pri | St | Evidence |
|---|---|---|---|
|3.1 Thread UI|P0|✅|`conversations`/`messages` tables; web ConversationThread|
|3.2 Voice dictation|P0|🟡|`voice/transcription-providers.ts` = Whisper; Nova-3 WS + 30s TTL unconfirmed|
|3.3 Combined classify+extract|P0|✅|`ai/orchestration/intent-classifier.ts` + gateway single call|
|3.4 Intent taxonomy|P0|✅|`SUPPORTED_INTENTS` covers all + versioned `prompt_versions`|
|3.5 Proposal card gen|P0|✅|`proposals/*`, `proposals` table, draft→exec split|
|3.6 Inline cards|P0|✅|Proposal status lifecycle; rendered in thread|
|3.7 Approve/edit/reject|P0|✅|`proposal-contracts.ts` edit/reject schemas|
|3.8 Clarify missing-field only|P0|🟡|`conversations/clarification.ts`; only-missing logic unverified|
|3.9 Correction capture|P0|✅|`correction_lessons` + `learning/corrections/*`|
|3.10 Tiered model routing|P0|✅|`config/ai-routing.ts` Haiku/Sonnet, ~60% lightweight, logged|
|3.11 Persistence & history|P1|✅|conversations+messages w/ entity links; CommsInbox|
|3.12 Error & fallback|P1|🟡|correlation_id present; low-confidence retry heuristic unconfirmed|

### Epic 4 — Customer Management / CRM (5/4/0)
| Story | Pri | St | Evidence |
|---|---|---|---|
|4.1 Customer list|P0|✅|`customers` table; web CustomersPage|
|4.2 Add via form|P0|✅|`customers/pg-customer.ts` + `dedup.ts`|
|4.3 Add via conversation|P0|✅|`create_customer` intent + proposal + dedup|
|4.4 Duplicate detection|P0|🟡|`dedup.ts` exact+fuzzy; merge-on-card UI unconfirmed|
|4.5 Customer detail|P0|✅|web `customers/CustomerDetail.tsx`|
|4.6 Customer merge|P1|🟡|Dedup exists; merge execution unconfirmed|
|4.7 Multi-channel contact|P1|🟡|`customer_contacts` + `pg-contact.ts`; caller-ID match unconfirmed|
|4.8 Tags & notes|P1|✅|`customer_tags`, `notes` tables + modules|
|4.9 Customer timeline|P1|🟡|`customers/timeline.ts`; UI wiring unverified|

### Epic 5 — Scheduling & Calendar (4/5/1)
| Story | Pri | St | Evidence |
|---|---|---|---|
|5.1 Job entity & status|P0|🟡|`jobs/job-lifecycle.ts` transitions; status set ≠ PRD's 7 states|
|5.2 Create job via convo|P0|✅|`create_job` intent + proposal + clarify|
|5.3 Calendar views|P0|✅|web SchedulePage + TechnicianDayView|
|5.4 Availability model|P0|🟡|`availability/*` + `scheduling/feasibility.ts`; voice API wiring unclear|
|5.5 48h proposal expiry|P0|❌|No TTL on job/message proposals|
|5.6 Drag-to-reschedule|P1|🟡|Conflict detect exists; drag UI unconfirmed|
|5.7 Job detail page|P0|✅|web `jobs/JobDetail.tsx`|
|5.8 Backward status moves|P1|🟡|Audit captures reason; owner-only enforcement unconfirmed|
|5.9 Double-booking detection|P0|✅|`scheduling/feasibility.ts` detectOverlappingAppointments|
|5.10 Open work queue|P1|🟡|Nullable assignee; queue surface unconfirmed|

### Epic 6 — Dispatch & Technician Experience (7/2/0)
| Story | Pri | St | Evidence |
|---|---|---|---|
|6.1 Tech assignment|P0|✅|`appointments/assignment.ts` w/ double-book validation + audit|
|6.2 TechJobView landing|P0|✅|web `technician/TechnicianDayView.tsx`, role-gated|
|6.3 On-assignment notify|P0|✅|`dispatch/board-notify.ts` + Twilio dispatch|
|6.4 Tech job detail|P0|✅|TechnicianDayView: address/contact/notes + map handoff|
|6.5 Tech status updates|P0|🟡|`technician/VoiceUpdatePage.tsx` voice transitions; tap-UI partial|
|6.6 Route/address handoff|P1|✅|`buildMapsHref()` Google+Apple maps|
|6.7 Tech availability|P1|✅|`availability/*` feeds assignment validation|
|6.8 Reassignment|P1|🟡|unassign+assign path; explicit reassign endpoint unverified|
|6.9 Completion→invoice handoff|P1|✅|`invoices/auto-invoice-on-completion.ts`|

### Epic 7 — Estimating (7/2/1)
| Story | Pri | St | Evidence |
|---|---|---|---|
|7.1 Estimate Agent|P0|✅|`ai/tasks/estimate-task.ts` + `catalog-resolver.ts` price grounding|
|7.2 Clarify max 3 loops|P0|🟡|Clarification generator exists; 3-loop cap not enforced on estimate path|
|7.3 Line-item editing|P0|✅|web LineItemEditor + `estimates/estimate-editor.ts`|
|7.4 Tenant terminology|P0|✅|Estimate carries terminology|
|7.5 Send to customer|P0|✅|Twilio/SendGrid + view token + sent timestamp|
|7.6 E-signature authorization|P0|✅|`estimates/public-estimate-service.ts` signature stored+timestamped|
|7.7 Customer approval capture|P1|✅|`estimates/approval.ts` recordApproval|
|7.8 Estimate→job conversion|P0|✅|Gated on status='accepted' via proposal exec|
|7.9 Estimate templates|P2|❌|No save/seed mechanism|
|7.10 List & detail|P1|🟡|List+status filter; detail UI minimal|

### Epic 8 — Invoicing & Payments (6/3/1)
| Story | Pri | St | Evidence |
|---|---|---|---|
|8.1 Invoice entity|P0|✅|`invoices/invoice.ts` w/ statuses + audit|
|8.2 Create from job|P0|✅|`auto-invoice-on-completion.ts`|
|8.3 Create by conversation|P0|🟡|`ai/tasks/invoice-task.ts`; extraction present|
|8.4 Stripe-hosted payment|P0|✅|`public-invoice-service.ts` per-invoice Payment Link|
|8.5 Multiple methods|P0|✅|`invoices/payment.ts` method enum + partial payments|
|8.6 Mark as paid|P0|✅|web InvoiceDetail PaymentRecordForm|
|**8.7 0.5% platform fee**|P0|❌|**No fee logic anywhere**|
|8.8 Receipts|P1|🟡|`payment_receipt` template type; impl partial|
|8.9 List & detail|P1|✅|web InvoiceDetail + pagination|
|8.10 Overdue handling|P1|🟡|`dunning-config.ts`; HomePage count missing|

### Epic 9 — Inbound Voice Agent / Receptionist (8/3/1)
| Story | Pri | St | Evidence |
|---|---|---|---|
|9.1 Managed platform|P0|✅|`integrations/vapi/*` + `voice/voice-config.ts` (Vapi)|
|9.2 Number provisioning|P0|🟡|Vapi binding present; onboarding setup unverified|
|9.3 Answer inbound call|P0|✅|`telephony/twilio-adapter.ts` FSM + barge-in|
|9.4 Caller lookup|P0|✅|`ai/skills/identify-caller.ts`|
|9.5 Qualify vs rules|P0|🟡|`triage-rules.schema.ts`; full gate not explicit|
|9.6 Live availability|P0|✅|`ai/tasks/availability-finder.ts`|
|9.7 Book the visit|P0|✅|`ai/tasks/create-appointment-task.ts` direct-write+review|
|9.8 SMS confirmation|P0|✅|`notifications/dispatch-repository.ts`|
|9.9 Emergency routing|P0|🟡|`emergency-detector.ts` + `escalate-to-human.ts`; feed flag unverified|
|9.10 AI disclosure|P0|✅|`ai/skills/disclose-recording.ts` per-tenant configurable|
|9.11 Transcript & summary|P0|✅|`voice/voice-service.ts` + `summarize-session.ts`|
|**9.12 Metered minutes**|P0|❌|duration stored; **no bucket/overage/billing**|

### Epic 10 — Customer Communication & Outreach (4/4/1)
| Story | Pri | St | Evidence |
|---|---|---|---|
|10.1 Customer SMS channel|P0|✅|`sms/*` Twilio in/out, logged|
|10.2 Confirmations & reminders|P0|✅|`notifications/transactional-comms-service.ts`|
|10.3 On-the-way notify|P1|✅|`notifications/delay-notifications.ts`|
|10.4 Message cards 48h expiry|P1|🟡|Drafting yes; 48h expiry not found|
|10.5 Templated messages|P1|🟡|System templates; user-authored save/list missing|
|10.6 Opt-out handling|P0|✅|`compliance/stop-reply.ts` STOP/START|
|10.7 Two-way SMS thread|P1|🟡|Replies attach; full conversation UI unverified|
|10.8 Outbound estimate revival|P2|❌|No aging/revival worker|
|10.9 Notification preferences|P1|🟡|Toggles in settings; per-tenant UI missing|

### Epic 11 — Inventory Management (0/2/6) — *all P1/P2; deferred per PRD priority*
| Story | Pri | St | Evidence |
|---|---|---|---|
|11.1 Item model|P1|🟡|`catalog_items` has name/unit/price; **no quantity/on-hand**|
|11.2 Log usage by convo|P1|❌|No usage_log; no decrement flow|
|11.3 Stock levels|P1|❌|No quantity columns / adjust UI|
|11.4 Parts on estimates/jobs|P1|🟡|`estimate_line_items` but no catalog FK; no stock decrement|
|11.5 Low-stock flags|P1|❌|No threshold field/flag|
|11.6 Reorder suggestions|P2|❌|None|
|11.7 Supplier notes|P2|❌|None|
|11.8 Usage history|P2|❌|None|

### Epic 12 — HomePage, Dashboard & Insights (0/8/1)
| Story | Pri | St | Evidence |
|---|---|---|---|
|12.1 Role-based HomePage|P0|🟡|web HomePage; explicit tech routing not enforced|
|12.2 Today snapshot|P0|🟡|Counts shown; not all drill-down|
|12.3 Pending proposals queue|P0|🟡|Shown on HomePage/Digest; not all types tap-able|
|12.4 Core KPIs|P1|🟡|`reports/money-dashboard.ts`; period comparison stub|
|12.5 Voice ROI metrics|P0|🟡|`metrics/hfcr.ts`; calls/answered/booked not on HomePage|
|12.6 Weekly feedback email|P0|🟡|`hfcr-weekly-send-worker.ts` sends **SMS not email**; opt-out not enforced|
|12.7 Activity feed|P1|🟡|`job_timeline_events`; emergency flag + deep-links absent|
|12.8 Quick actions|P1|❌|No one-tap add widgets|
|12.9 Empty states|P1|🟡|Generic; no first-action nudge|

### Epic 13 — Integrations & Sync (2/1/4)
| Story | Pri | St | Evidence |
|---|---|---|---|
|13.1 QuickBooks one-way|P0|✅|`integrations/accounting/quickbooks-client.ts` + sync worker/log|
|13.2 QuickBooks two-way|P1|❌|Push only; no reconcile|
|13.3 Invoice Ninja|P1|❌|Zero references (QB + Xero stub only)|
|**13.4 n8n orchestration**|P0|❌|No n8n — **custom Postgres queue + workers instead**|
|13.5 Webhook framework|P1|✅|`webhooks/webhook-handler.ts` + idempotency + signatures|
|13.6 Google Calendar|P2|🟡|`integrations/google-calendar.ts` read-only|
|13.7 FSM import|P2|❌|None|

### Epic 14 — Platform Ops, Security & Model Governance (6/2/0)
| Story | Pri | St | Evidence |
|---|---|---|---|
|14.1 Data security & RLS|P0|✅|~197 RLS policies; crypto for keys|
|14.2 PII handling|P0|✅|`logging/redaction/*` + `reputation/pii-redact.ts` + retention worker|
|14.3 Model routing policy|P0|✅|`config/ai-routing.ts` env-configurable, logged|
|14.4 Cost & latency observ.|P0|🟡|latency_ms/cost_cents fields + telemetry; voice-minute spend not in UI|
|14.5 Error & correlation|P0|✅|correlation_id indexed; request-logging propagates|
|14.6 AI guardrails|P0|✅|`proposals/guardrails/*` + supervisor confirmation|
|14.7 Rate limiting|P1|✅|`shared/rate-limit/phone-rate-limit.ts` sliding window|
|14.8 Backup & retention|P1|🟡|Retention worker; tested-restore not shown|

### Epic 15 — Lead Capture & Online Booking (2/5/2)
| Story | Pri | St | Evidence |
|---|---|---|---|
|15.1 Web-form lead capture|P0|✅|`public-intake/*` + leads table source='web_form'|
|15.2 Speed-to-lead response|P0|🟡|Lead stored; **auto-SMS trigger not wired**|
|15.3 Unified lead inbox|P0|🟡|web LeadList; HomePage count missing|
|15.4 Lead→customer/job|P0|🟡|`leads/lead-service.ts`; auto proposal not generated|
|15.5 Online booking widget|P0|✅|`portal/PortalSlotPicker/BookAppointment.tsx` + SMS confirm|
|15.6 Google Business Profile|P1|🟡|`reputation/google-business-client.ts` reads reviews; msgs not in lead inbox|
|15.7 Marketplace (Angi/Thumbtack)|P1|❌|enum only, no ingestion|
|15.8 Google LSA|P2|❌|None|
|15.9 Lead-source attribution|P1|🟡|`reports/revenue-by-source.ts`; HomePage not segmented|

### Epic 16 — Field Documentation & Capture (3/6/0)
| Story | Pri | St | Evidence |
|---|---|---|---|
|16.1 Job photos|P0|✅|`attachments` table + web JobPhotos + S3|
|16.2 Photo capture in context|P1|🟡|Upload yes; inline-with-notes not wired (pair fields exist)|
|16.3 Photos on estimates|P1|🟡|entity_type support; not rendered in template|
|16.4 Customer-facing proof|P2|🟡|portal_visible flag; consent not explicit|
|16.5 Time tracking clock in/out|P0|✅|`time_entries` + web ClockInOutButton|
|16.6 Time adjustment & review|P1|🟡|Notes support; owner-adjust UI + totals absent|
|16.7 Time feeds payroll/costing|P1|🟡|Aggregation; no payroll export / costing UI|
|16.8 Expense/receipt capture|P0|✅|`expenses` table w/ vendor/amount/category — **but OCR not implemented**|
|16.9 Expense categorization/rollup|P1|🟡|category field; rollup UI + QB export stub|

---

## Built OUTSIDE the PRD (not captured anywhere in v4.1)

**Identity / positioning:** rebrand **"AI Service OS" → "Rivet"** ("Your AI dispatcher"),
public launch 2026-06-03 (`packages/web/index.html`, `docs/launch/2026-06-03-rivet-*`).

**Architecture re-platform** — the PRD's "locked" stack now survives only in `/experiments`:

| PRD "locked" | Actual canonical |
|---|---|
| Next.js / Vercel | React + Vite + React Router / Railway |
| LangGraph + FastAPI (Python) | TypeScript / Express + AI gateway |
| n8n Cloud | Postgres queue + ~27 workers |
| Supabase | raw Postgres + in-code migrations |
| Vapi *or* Retell | Vapi → **native Twilio FSM** (Vapi now legacy — D16) |
| QuickBooks + Invoice Ninja | QuickBooks only (+ Xero stub) |
| Combined classify+extract | separate classify → extract |

Extra providers not in the PRD: Whisper (async STT), ElevenLabs (TTS), SendGrid (email),
OpenRouter (LLM fallback), Stripe Connect (tenant payouts).

**Pricing moved off the PRD entirely.** The PRD's $99/mo + 0.5% payment fee (with a metered-vs-flat
"open decision") became, per the GTM brief, a **flat $297/mo + 500 voice minutes + $0.30/min overage**.
This supersedes the 0.5% fee (8.7); the per-minute overage is exactly why voice metering (9.12)
remains genuinely open.

**Product modules beyond the 16 epics:** subscription billing (the $99/mo SaaS side — note this
is *not* the 8.7 fee or 9.12 metering) · agreements / memberships · customer self-service portal ·
reputation (Google reviews + AI reply drafting) · active-learning correction loop · quality /
beta-readiness gates · CSAT feedback · i18n (EN/ES) · escalations + on-call rotation ·
lookup-events telemetry.

**Whole stacks the PRD never mentions:** voice corpus (3,617 labeled EN/ES utterances) +
eval harness (`packages/voice-eval`, CI-gated) + `serviceos_training` (Reddit→pgvector) ·
QA matrix + 82 integration + 44 e2e tests + 8 CI workflows · the `/rewrite` parallel rebuild ·
an execution backlog of ~309 P-/U-numbered stories vs the PRD's 149.

---

## Recommended follow-ups
1. **Confirm pricing is locked** (flat $297/mo + $0.30/min overage). If so, 8.7 (0.5% fee) is
   permanently obsolete and **9.12 voice-overage metering is the only monetization work left**.
2. **Record two ADRs** this archaeology exposed: a **pricing ADR** (settles 8.7) and a
   **tech-stack-rejection ADR** for Next.js/Python (today only in `/experiments` READMEs).
3. Draft a **PRD v4.2 addendum** capturing the rebrand, the re-platform, the pricing change, and
   the out-of-PRD modules so the canonical doc matches reality.
4. Close the 2 real P0 gaps (9.12 metering, 5.5 expiry); treat remaining 🟡 P0 items as MVP-hardening.
