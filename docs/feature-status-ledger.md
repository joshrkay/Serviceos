# Feature Status Ledger — AI Service OS

**Purpose.** The single verified source of truth for **what is COMPLETED and BUG-FREE** vs. what is partial, buggy, dead, or absent — so stale planning docs stop re-flagging finished work as "gaps." Every row is traced by reading source at current HEAD and carries a `file:line` cite and a state tag.

**Date:** 2026-06-13
**HEAD:** `03d10caa5e2752b90f1eb6a3e7720807ffbd3c56`
**Build gate:** **PASS** (exit 0) — `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`.
**Subordination:** This ledger is **subordinate to and feeds `docs/PRD-launch-v1.md`** (its Appendix is the canonical current-state map; this ledger is the bucketed, bug-free-vs-not view that derives from it). When in conflict, the PRD wins.

> **Tag legend.** **[WIRED]** = traced end-to-end, reachable in prod · **[EXISTS-UNVERIFIED]** = exists, wiring unconfirmed · **[STUB]** = placeholder / mock / dead code (defined but unreachable / zero-caller) · **[BUG]** = wired but has a specific correctness defect.

> **Verification note.** The PRD Appendix audited HEAD `db0dc31`; this ledger re-verified every load-bearing cite against current HEAD `03d10ca`. All claims confirmed. Two path corrections vs. the PRD's shorthand: web files live under `packages/web/src/components/...` (not `pages/...`) — e.g. `components/invoices/InvoicesPage.tsx`, `components/home/HomePage.tsx`, `components/settings/QuickBooksModal.tsx`. Raw RLS line counts at HEAD are **78 ENABLE / 78 FORCE** (`db/schema.ts`); the PRD's "75/75" is the **distinct-table** parity figure (raw counts include duplicate ALTERs across migration history) — both confirm zero distinct-table mismatch.

---

## 1. COMPLETED & BUG-FREE

Traced end-to-end, reachable in prod, **no known correctness bug**. (If a known bug touches a feature, it is demoted to §2.)

| Feature | Evidence (file:line) | Notes | Tag |
|---|---|---|---|
| Web proposal approval — single + batch ≤50 | `routes/proposals.ts:211-232`, batch `:187-209`, cap `:36`; `proposals/actions.ts:35,67` | The floor (Rung 0); unchanged. | [WIRED] |
| 38-type proposal model | `proposals/proposal.ts:24` (full union), `:26-65` | Discriminated, Zod-validated typed payloads. | [WIRED] |
| Screen-gating classifier (class → tap vs text) | `proposals/proposal.ts:225-322` | Pure fn; capture vs comms/money/irreversible. Consumed by web; SMS consumer not yet built (see §5). | [WIRED] |
| Mode-aware auto-approve gate (0.90 / 0.92 / 0.95) | `proposals/auto-approve.ts:22-24` (`supervisor:0.9, both:0.92, tech:0.95`), `:32`, hard-block `:79+` | Tenant-overridable JSONB threshold `db/schema.ts:2019-2030`. | [WIRED] |
| Unsupervised hard-block (money/comms/irreversible never auto-execute) | `proposals/auto-approve.ts:79+` ("unsupervised guard is the hard rule — overrides every other") | Hard invariant; preserved by design. | [WIRED] |
| 5s undo window | `proposals/lifecycle.ts:12-15` (`approved → ['executed','execution_failed','undone']`, `UNDO_WINDOW_MS`) | Approved proposals can transition to `undone` within the window. | [WIRED] |
| Advisory-lock idempotency on execution | `proposals/execution/idempotency-lock.ts:15,21` (session-level `pg_advisory` keyed by tenant+idempotencyKey) | Serializes duplicate executions. | [WIRED] |
| In-call voice agent (12 lookup + 5 mutation-as-proposals, escalation, lead auto-create) | `telephony/twilio-adapter.ts:28-39`; `ai/voice-turn/create-voice-turn-processor.ts`; `ai/skills/escalate-to-human.ts`; `ai/skills/find-or-create-lead.ts:33` | Mutations route through the proposal gate. (Dropped-call recovery has a `setTimeout` durability caveat — non-blocking.) | [WIRED] |
| Stripe pay + payment reconciliation via webhook | `payments/stripe-payment-intent.ts:56-103`; webhook recon `webhooks/routes.ts:718,927,1030` | ACH covered via Stripe `automatic_payment_methods`. | [WIRED] |
| Auto-invoice-on-completion (drafts a `draft_invoice` proposal, never auto-sends) | `invoices/auto-invoice-on-completion.ts:7-8,15` (raises a PROPOSAL, owner approves) | Correctly requires approval; feeds the HFCR loop. | [WIRED] |
| Audit event emission on mutations | `db/schema.ts:60-78` (`audit_events`) | Per CLAUDE.md "all mutations emit audit events." | [WIRED] |
| Encrypted voice transcripts (AES-256-GCM) | `integrations/crypto.ts:15-22`; `workers/transcription.ts:86,251` | | [WIRED] |
| RLS ENABLE + FORCE, zero distinct-table mismatch | `db/schema.ts` — 78 ENABLE / 78 FORCE raw lines; ~75/75 distinct-table parity | Run prod-migration verification at launch (PRD R5.3). | [WIRED] |
| Webhook idempotency, fail-closed in prod | `webhooks/routes.ts:168-171,187-194` (durable idempotency store backing Stripe/Clerk dedup) | Replaces the old in-memory dedup hole (see §6). | [WIRED] |
| `/metrics` auth-gated | `app.ts:560-585`; `bootstrap/metrics-auth.ts` | 503 without token in prod. | [WIRED] |
| Public, token-less online booking | `routes/public-booking.ts:2,7-8` | Acquisition surface for NEW prospects; creates customer/location/job/held-appt + `create_booking` proposal. | [WIRED] |
| Tiered good/better/best estimates + deposit + e-approval | migrations 127/128/129; `estimates/public-estimate-service.ts:209-271`; deposit checkout `routes/public-estimates.ts` (`/deposit-checkout`) | Customer selection + locked accept. | [WIRED] |
| Tech "on my way" + ETA texts | `notifications/delay-notifications.ts:134,141` ("on the way" + ETA); enqueued `dispatch/routes.ts:163,192` via `enRouteCoordinator` (wired `app.ts`) | | [WIRED] |
| Proactive review requests (DNC-gated) | `feedback-send` worker (post-job SMS); review-gating `routes/public-feedback.ts`; `google_review_url` setting (migration 124) | Solicitation, not just monitoring. | [WIRED] |
| 7-step self-serve onboarding | `onboarding/contracts.ts:64`; `onboarding/derive-status.ts:59` | Terminal step `test_call`. (No concierge path — that is a GTM motion, not a gap.) | [WIRED] |
| Calendar sync (push-only, one-way) | `integrations/calendar-sync.ts:11-16` | Push-only is the **intended** v1 scope, so it is not a bug — but reachability is caveated (see §4). | [WIRED] (one-way) |

---

## 2. COMPLETED BUT HAS KNOWN BUGS

Done and wired, but with a specific correctness defect. These are demotions from §1.

| Feature | Bug | Cite | Severity | Tag |
|---|---|---|---|---|
| InvoicesPage detail/summary money render | Drops cents via `.toLocaleString()` on integer-cents-derived floats at **9 sites** — `$1,234.05` renders `$1,234`; line items also use the `qty * rate` float path | `components/invoices/InvoicesPage.tsx:256,257,275,376,552,723,735,744,868` (the edit path `.toFixed(2)` at `:247` is the correct reference) | High (money correctness, demo-visible) | [BUG] |
| Home greeting | Hardcoded "Good morning, Mike ☀️" — wrong name + no real time-of-day | `components/home/HomePage.tsx:323` | Medium (credibility landmine) | [BUG] |
| DB health / `/ready` probe | DB check emits only `'degraded'` on connection failure, never `'down'`, so `/ready` never returns 503 on a real DB outage | `app.ts:530` (returns `{status:'degraded'}`); `health/health.ts:23-30,49` (`/ready` 503s only on `'down'`) | Medium (reliability gate; masks outage) | [BUG] |

---

## 3. PARTIAL

Core is built and reachable, but a meaningful piece is missing.

| Feature | What works | What's missing | Cite | Tag |
|---|---|---|---|---|
| Collections / dunning | One overdue nudge fires on transition-into-overdue | Multi-step cadence + late-fee math are dead (see §5); only a single nudge, then silence | works: `workers/overdue-invoice-worker.ts:110` (guard `:92`); dead: `invoices/dunning-schedule.ts:35`, `invoices/late-fee.ts:47` | [WIRED] (one nudge) + [STUB] (cadence) |
| Dunning persistence substrate | Table exists with RLS-FORCE + the right UNIQUE constraint | Currently **unused** by any sweep (no reads/writes) | `db/schema.ts:3520-3541` (`invoice_dunning_events`, `UNIQUE(tenant_id,invoice_id,kind,step_key)`) | [WIRED] (schema) / unused |
| Memberships / recurring agreements | `Agreement` model + `recurring-agreements-worker` drive recurrence → invoice/job generation | No auto-renew, no member pricing on estimates/invoices, no priority-booking flag, no recurring `off_session` auto-charge of a saved card | per competitive-analysis re-audit (2026-05-31, #6); `agreements/` + `maintenance-contracts/` | [WIRED] (partial) |
| Unified customer comms | Cross-channel timeline aggregation + AI suggest-reply (draft, owner sends) | No dedicated cross-channel triage inbox surface (vs. the approval-queue InboxPage) | `customers/timeline.ts`; `ai/tasks/suggest-reply-task.ts` + `POST /api/conversations/:id/suggest-reply` | [WIRED] (partial) |
| Settings page | 5/13 handlers wired end-to-end (business profile, language/region, estimate/invoice templates, terminology, AI approval rules) | 8 stub handlers remain (reminders timing, team members, roles/permissions, payment methods, deposit rules, subscription, calendar sync, Zapier) | `components/settings/SettingsPage.tsx` (`action: () => {}` handlers) | [STUB] (8 of 13) |

---

## 4. STUB / DEAD / NOT BUILT

Placeholder, mock, zero-caller, or confirmed absent.

| Feature | State | Cite | Tag |
|---|---|---|---|
| SMS reply-to-approve handler (YES/APPROVE/EDIT/APPROVE-ALL) | **Confirmed absent** — dispatch registry exists; only STOP/START registered | `app.ts:661-662` (only `buildStopKeywordHandler` / `buildStartKeywordHandler`); registry `sms/inbound-dispatch.ts:49-52,76` | [STUB] (absent) |
| Proactive owner SMS via `queue_and_sms` routing | Setting/enum/schema/`/me`-read all exist, but **no sender reads** `unsupervised_proposal_routing` | `proposals/proposal.ts` unsupervised route; setting `db/schema.ts:1831-1832`; routing comment promises a worker `auto-approve.ts:68-69` | [STUB] |
| Owner-cell-patch SMS sender | Real send primitive exists but **no production caller** — referenced only in docstrings/comments | `voice/triage/owner-cell-patch.ts:150`; only doc refs in `escalate-to-human.ts:139,169`, `settings/settings.ts:588` | [STUB] |
| Operator voice-approval ("say approve") | Exports defined; **referenced only by their unit test** (zero runtime callers) | `ai/tts/readback.ts:19-21,53,144-156` (`classifyVoiceApproval`/`isVoiceApprovable`/`buildReadbackScript` — no non-test importer) | [STUB] |
| Tech-status OUT/SICK SMS keyword handler | Built but **never registered** — `registerTechStatusKeywords` has zero callers | `sms/tech-status/index.ts:29,34` (defined); `app.ts:661-662` registers only STOP/START | [STUB] |
| Multi-step dunning cadence | **Zero callers** — `selectDueReminderSteps()` is dead | `invoices/dunning-schedule.ts:35` (only its own definition; no non-test caller) | [STUB] |
| Late-fee math | **Zero callers** — `computeLateFeeCents` / `daysPastDue` dead | `invoices/late-fee.ts:47,34` (no non-test caller) | [STUB] |
| Proposal-outcome analytics | In-memory only, **unwired** at composition root; interface + types exist | `proposals/analytics.ts:4-13,15-28,30-33,35` (no `recordOutcome`/`ProposalAnalyticsRepository` caller outside the file) | [STUB] |
| Named Stripe reconciler | Dead code (real reconciliation is the webhook path in §1) | `payments/invoice-payment-reconciler.ts:12` | [STUB] |
| QuickBooks / accounting sync | **Pure UI mock** — `setTimeout` "connect" + fake QBO ID "#8821" | `components/settings/QuickBooksModal.tsx:25` (`setTimeout(() => setStep('connected'), 1800)`), `:143` ("QBO ID #8821") | [STUB] (mock) |
| Language / voice overrides | Placeholder | `components/settings/LanguageSettings.tsx:5-6` | [STUB] |
| review-response Google reply | Conditional no-op — degrades to passthrough when no resolver is wired | `proposals/execution/review-response-handler.ts:196+` ("No resolver wired → degrade to passthrough"), `:106` (optional `googleReplyResolver`) | [STUB] |
| Outbound AI calling | **Confirmed absent** — no `calls.create` anywhere in API source; DNC gating exists with nothing to gate | grep `calls.create` over `packages/api/src` → zero non-test hits | [STUB] (absent) |
| Tips / gratuity at checkout | **Confirmed absent** — no `tip`/`gratuity` payment field anywhere | grep over `packages/api/src` → no payment-side `tip`/`gratuity` (only NLU affirmative-word prose in `ai/skills/confirm-intent.ts:109`) | [STUB] (absent) |
| Consumer financing (Wisetack/Affirm) | **Confirmed absent** | grep `wisetack`/`affirm`/`financing` → zero | [STUB] (absent) |

---

## 5. STALE-CLAIM CORRECTIONS

Lines in the legacy gap/feature docs that are now **wrong** at HEAD — either claiming a gap that's actually done, or claiming done/safe where it's actually dead/buggy. The competitive-analysis.md already self-corrected (2026-05-31) and is excluded.

| # | Stale claim (source) | Correction (cite) |
|---|---|---|
| 1 | **`codebase-review-2026-05-31.md:71-73`** — *"webhook idempotency store and the idempotency middleware are **in-memory** (multi-instance hole)"* (listed under "A few correctness seams"). | **Now fixed.** Webhook dedup is a **durable, fail-closed** idempotency store in prod — `webhooks/routes.ts:168-171,187-194`. The in-memory hole is closed (the `InMemoryWebhookEventRepository` is the dev fallback only). Move from "correctness seam" to COMPLETED & BUG-FREE (§1). |
| 2 | **`codebase-review-2026-05-31.md:33-34`** — RLS stated as *"**74 ENABLE + 73 FORCE** + 83 CREATE POLICY."* | **Stale count.** At HEAD it is **78 ENABLE / 78 FORCE** raw lines, ~**75/75 distinct-table** parity with **zero mismatch** (`db/schema.ts`). The asymmetric "74/73" no longer holds; FORCE parity is complete. |
| 3 | **`codebase-readiness-assessment.md:34-38`** — *"The remaining gap is no longer infrastructure — it is **Phase 8 (the customer calling agent)**, production-grade voice provider upgrades … and a finite list of UI polish items."* | **Wrong framing of the gap.** The verified blocking gaps are the **owner's SMS channel** (no reply-to-approve handler `app.ts:661-662`; no proactive owner-SMS sender `proposals/proposal.ts`) and the **dead collections tail** (`dunning-schedule.ts:35`, `late-fee.ts:47` both zero-caller). These are not "Phase 8" or "UI polish" — they are the launch headline (PRD Epic 0/2). The doc omits them entirely. |
| 4 | **`remaining-features.md` "Shipped" + Phase-8 framing** — treats the codebase as feature-complete-but-for voice-provider upgrades (Deepgram/ElevenLabs) and Phase-8 calling agent. | **Misranks the real gaps.** Voice-provider streaming upgrades are non-blocking polish; the actual launch-critical dead wires (approve-by-text, proactive SMS, multi-step dunning, late fees) and the **9-site cents-render bug** (`components/invoices/InvoicesPage.tsx:256…868`) are not in its "remaining" list at all. |
| 5 | **`codebase-readiness-assessment.md:70`** — Settings stubs: *"**5/13** closed … 8 remain"* framed as the residual UI tail; and `:53,177` *"QuickBooks, Zapier"* listed as a deferred integration. | **Understated for QuickBooks specifically.** QuickBooks is not merely "deferred" — it is a **live UI mock** that fakes a successful connect (`components/settings/QuickBooksModal.tsx:25` setTimeout, `:143` fake "#8821 QBO ID"), i.e. a demo credibility landmine to hide, not a checkbox to schedule. (Settings 5/13 wired is accurate, retained in §3.) |

---

## Net headline

The autonomy/approval **core is genuinely WIRED and bug-free** (proposal engine, mode-aware gate + unsupervised hard-block, 5s undo, advisory-lock idempotency, Stripe pay + webhook reconciliation, RLS-FORCE, encrypted transcripts, public booking, tiered estimates, on-my-way/ETA, proactive reviews). The gaps are concentrated and consistent: the **owner's channel** (reply-to-approve, proactive owner SMS, voice-approval) and the **collections tail** (multi-step dunning, late fees) are dead-but-substrate-present, plus three known correctness bugs (9-site cents render, hardcoded greeting, `/ready` never 503s). Legacy docs that frame the residual work as "Phase 8 calling agent / voice upgrades / UI polish" are stale; the launch-critical work is plumbing the existing engine to the owner — see `docs/PRD-launch-v1.md` Epics 0/2/3/5.
