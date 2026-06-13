# AI Service OS — Verified Current-State Map

**Audit date:** 2026-06-13
**HEAD:** `db0dc31707dd4502510a366f6abc1f347951b995` ("docs: add detailed v1 launch PRD (AI front office)")
**Scope:** canonical product only — `packages/api`, `packages/web`, `packages/shared`.
**Method:** every line re-opened on current HEAD. Tags: **[WIRED]** = traced end-to-end, reachable in prod · **[EXISTS-UNVERIFIED]** = exists, wiring unconfirmed · **[STUB]** = placeholder / mock / dead code (defined but unreachable).

---

## 1. Build gate

```
cd /home/user/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

**Result: PASS (exit 0, no errors).** The production tsconfig compiles clean.

---

## 2. Current-state map

### Interaction / approval

- **Web approval — single + batch ≤50 — [WIRED].** Single: `packages/api/src/routes/proposals.ts:211-232` (`POST /:id/approve` → `approveProposal`). Batch: `routes/proposals.ts:187-209` (`POST /approve-batch`, body capped `.max(50)` at `:36`). Backed by `proposals/actions.ts` (`approveProposal` / `approveProposalsBatch`). Frontend calls these from `packages/web/src/components/inbox/InboxPage.tsx` (client-side 3+ "APPROVE ALL" gate). End-to-end reachable.
- **Voice approval ("say approve") for capture-class — [STUB] (DOWNGRADED from EXISTS-UNVERIFIED).** The operator proposal-approval readback + classifier exists: `packages/api/src/ai/tts/readback.ts` — `isVoiceApprovable` (`:19-21`), `buildReadbackScript` (`:53`, capture-class gets "Say approve or cancel.", money/comms/irreversible get "Tap to confirm on screen."), `classifyVoiceApproval` (`:144-156`). **But these three exports are referenced ONLY by their unit test** (`packages/api/test/ai/tts/readback.test.ts:10-14`) — no runtime voice/SMS/webhook handler imports them. Corroborated by `ai/agents/customer-calling/inapp-adapter.ts:494` ("confirmation later when readback is wired into the UI"). The *in-call caller-facing* readback is a different, wired module (`ai/skills/confirm-intent.ts` via i18n key `confirm.readback`); operator voice-approval is not wired.
- **NO SMS reply-to-approve handler — [CONFIRMED ABSENT].** Inbound SMS dispatcher `packages/api/src/sms/inbound-dispatch.ts:94` routes only the first token to a registered keyword handler; no APPROVE keyword is registered and no AI/default fallback exists. All approval is in-app HTTP (`proposals/actions.ts:35,67`). "APPROVE ALL" mentions (e.g. `sms/tech-status/handler.ts:35`) describe the in-app button.
- **Registered inbound-SMS keyword handlers — only STOP/START. Tech-status OUT/SICK is BUILT BUT NOT REGISTERED — [STUB] (CHANGE/REGRESSION vs prior).**
  - STOP/START — [WIRED]: `app.ts:661-662` (`registerKeywordHandler(buildStopKeywordHandler...)` / `...Start...`); keyword sets in `compliance/stop-reply.ts:9,12`; mutate DNC list.
  - Tech-status OUT/SICK/UNAVAILABLE — [STUB]: handler class `sms/tech-status/keyword-router.ts:20-21` (keywords from `packages/shared/src/contracts/tech-status-event.ts:70`); registration helper `sms/tech-status/index.ts:29` (`registerTechStatusKeywords`). **`registerTechStatusKeywords` has NO production caller** — `app.ts` registers only STOP/START. So OUT/SICK is never wired into the live dispatcher. *Prior audit claimed it was registered; it is not on current HEAD.*
  - Inbound SMS route: `webhooks/routes.ts:1952` (`POST /twilio/sms/:tenantId`), dispatch at `:1881-1891`.
- **Proactive owner SMS — both paths defined-but-not-sending — [STUB] (DOWNGRADED).**
  - `queue_and_sms` routing — [STUB]: the setting/enum/schema/`/me`-read all exist (`db/schema.ts:1831-1832`, `settings/settings.ts:64-69`, `shared/contracts.ts:301`, `app.ts:2620,2628`, `routes/me.ts:46`). Unsupervised auto-approvable capture proposals are routed to `ready_for_review` (`proposals/proposal.ts:399`). **But no code reads `unsupervised_proposal_routing` to send an SMS** — the "routing worker notifies the owner" promised in comments (`proposal.ts:359-360`, `auto-approve.ts:68-69`) does not exist. (Prior cite app.ts:2558 → drifted to 2620/2628.)
  - Vulnerability / owner-cell-patch — [STUB]: a real owner-SMS send exists at `voice/triage/owner-cell-patch.ts:150` (`deps.sendSms(...)`), with orchestrators `patchToOwnerCell` (`:166`) / `handleOwnerDialResult` (`:223`), **but no production caller** — the `patch_owner` triage decision is only referenced in a doc comment (`ai/agents/customer-calling/state-machine.ts:55`).
- **Screen-gating policy — [WIRED] (as a pure function).** `actionClassForProposalType` (`proposals/proposal.ts:225-322`) is an exhaustive switch: capture is voice/text-approvable; comms/money/irreversible force screen-tap (mirrored in `readback.ts` cue logic). The classification is wired into `decideInitialStatus`; the *voice-approval UI* that would consume it is not (see above).

### Autonomy engine — [WIRED]

- **38 proposal types — [WIRED].** `proposals/proposal.ts:24` (`ProposalType` union) and `:26-65` (`VALID_PROPOSAL_TYPES`), exactly 38 entries. Classes capture/comms/money/irreversible via exhaustive switch `actionClassForProposalType` (`:225-322`).
- **Auto-approve gate — [WIRED].** `decideInitialStatus` (`proposal.ts:339-408`) auto-approves ONLY when: no missing fields (`:375`), `sourceTrustTier === 'autonomous'` (`:377,384`), class `capture` (`:384`), and `shouldAutoApprove(confidence, threshold)` (`:402`). Thresholds mode-aware: supervisor 0.90 / both 0.92 / tech 0.95 (`auto-approve.ts:21-25`), tenant-overridable, legacy default 0.90 (`:32`). **`supervisorPresent === false` → threshold `null` → categorically blocked → `ready_for_review`** (`auto-approve.ts:82`, `proposal.ts:393-399`). comms/money/irreversible NEVER auto-approve. Live callsite: `createProposal` threads all gating signals (`proposal.ts:515-528`), invoked by AI tasks (`ai/tasks/estimate-task.ts`, `invoice-task.ts`, `voice-extended-tasks.ts`).
- **5s undo window + advisory-lock idempotency — [WIRED].** `UNDO_WINDOW_MS = 5000` (`proposals/lifecycle.ts:40`); executor refuses to run inside the window (`proposals/execution/executor.ts:88-97`); auto-approved proposals stamp `approvedAt` at creation (`proposal.ts:534`). Idempotency: `PgIdempotencyLockProvider` uses `pg_advisory_lock` keyed by sha256(tenant\0key) (`proposals/execution/idempotency-lock.ts:31`); marker written inside the lock (`executor.ts:164-175`).
- **~30 execution handlers; onboarding_*/voice_clarification no-op by design — [WIRED].** Registry `createExecutionHandlerRegistry` (`proposals/execution/handlers.ts:413`) builds ~27 base handlers (`:472-536`) + 3 conditional (update_invoice/issue_invoice when `invoiceRepo` present, update_estimate when `estimateRepo` present, `:541-552`) ≈ 30 registered. `onboarding_*` and `voice_clarification` are intentionally absent from the registry (no handler → would throw HANDLER_NOT_FOUND if executed; handled out-of-band) — consistent with "no-op by design".
- **proposal_executions stores AS-EXECUTED payload — [WIRED].** Written in prod at `executor.ts:165` and `:259` (`recordExecution({ executedPayload })`); `PgProposalExecutionRepository` instantiated `app.ts:901`, passed as `executionRepo` to the executor (`app.ts:1218`). NOTE: source comment in `proposals/proposal-execution.ts:22-24` ("No caller in main writes this surface yet") is STALE — it IS written; v1 mirrors `proposal.payload` until dispatcher pre-execution edits land.
- **ProposalOutcome analytics in-memory only — [STUB] (DOWNGRADED).** `InMemoryProposalAnalyticsRepository` exists (`proposals/analytics.ts:35`); there is **no PG implementation and no wiring into `app.ts`** (the only `analyticsRepo` wired in prod is `PgDispatchAnalyticsRepository` for dispatch, `app.ts:1105-1107` — unrelated). Proposal-outcome analytics is effectively unreachable in prod.

### Money loop

- **Estimate AI-draft auto-approve ≥0.9 — [WIRED] (with mode-aware caveat).** Same gate as autonomy engine; `ai/tasks/estimate-task.ts:116` sets `sourceTrustTier: 'autonomous'` and estimate-draft is capture-class. Caveat: threshold is mode-aware (0.90/0.92/0.95) and hard-blocked when unsupervised — "≥0.9 auto-approves" is true only in supervised mode.
- **Auto-invoice-on-completion (P20-001) — [WIRED] (auto-DRAFTS a proposal, does not auto-create/send an invoice).** Hook `invoices/auto-invoice-on-completion.ts:55` (`maybeAutoInvoiceOnCompletion`), triggered on job `status==='completed'` at `routes/jobs.ts:343-362`, deps wired into `createJobRouter` at `app.ts:2411-2419`. Gated behind opt-in `autoInvoiceOnCompletion`; raises a `draft_invoice` **proposal** requiring owner approval (`auto-invoice-on-completion.ts:120-135`).
- **Stripe pay — [WIRED].** PaymentIntent: `payments/stripe-payment-intent.ts:56-103` (real POST to Stripe at `:85`); route `routes/public-payments.ts:106`, mounted `app.ts:1652`. Payment-link path also present (`payments/stripe-payment-link.ts`).
- **Reconciliation — split: webhook path [WIRED], named reconciler [STUB] (CORRECTION).** Real reconciliation runs via the Stripe webhook `webhooks/routes.ts` (`POST /webhooks/stripe`, `:718`): `checkout.session.completed`→`recordPayment` (`:927`), `payment_intent.succeeded`→`recordPayment` (`:1030`), + failure/refund/dispute reversals (`:1075,:1504,:1637`); router wired `app.ts:696`, raw-body mount `app.ts:436`. **The file literally named `payments/invoice-payment-reconciler.ts:12` (`reconcilePayment`) is DEAD CODE — zero callers.** (Prior tagged reconciliation EXISTS-UNVERIFIED; reality is the behavior is WIRED via webhook, while the "reconciler" file is a stub.)
- **Collections = ONE overdue nudge only — [WIRED] (CONFIRMED).** `workers/overdue-invoice-worker.ts:110` (`notifyInvoiceOverdue`), fired only on the transition into `overdue` (guard `:92`); never re-fires. Driver: hourly sweep `runOverdueInvoiceSweep` (`app.ts:2927-2939`).
- **Multi-step dunning `selectDueReminderSteps()` — [STUB] / DEAD CODE (CONFIRMED).** Defined `invoices/dunning-schedule.ts:35`; zero callers across `packages/api/src` (excluding tests).
- **Late-fee math — [STUB] (DOWNGRADED from EXISTS-UNVERIFIED).** `invoices/late-fee.ts:47` (`computeLateFeeCents`) + `:34` (`daysPastDue`); math correct via shared billing engine. **Zero non-test callers** — not wired to any worker or route despite a docstring claiming the overdue sweep calls it. `daysPastDue` is reused only by the (also-dead) `dunning-schedule.ts`.

### Voice in-call — [WIRED]

- **12 lookup skills — [WIRED].** 12 `lookup-*.ts` in `ai/skills/` (account-summary, agreements, appointments, availability, balance, catalog, customer, estimates, invoices, jobs, leads, revenue); imported `telephony/twilio-adapter.ts:28-39`, dispatched via `runLookupSkill` switch `:1457-1660`, live turn gate `:1263-1282`. Adapter wired `app.ts:1796` with all repos.
- **Mutation skills in-call (book / draft estimate / draft invoice / record payment / add note) — [WIRED] as approval-gated proposals.** FSM path `ai/voice-turn/create-voice-turn-processor.ts:143-180` (`intentToProposalType`) + `:423-484` (`handleCreateProposal`); transcription-worker path `workers/voice-action-router.ts:203-229` + `buildHandlers` `:304-347`. Correctly queued as proposals requiring approval (`holdIfUnsupervised`, voice-action-router.ts:776), never auto-executed in-call.
- **Emergency escalation — [WIRED].** `ai/skills/escalate-to-human.ts`, invoked from `create-voice-turn-processor.ts:542` (`handleNotifyOncall`); wired `app.ts:1802-1814`.
- **Dropped-call SMS recovery — [WIRED] (durability caveat).** `telephony/dropped-call-recovery.ts:25` (`scheduleDroppedCallRecovery`), fired from `create-voice-turn-processor.ts:808-824`; resolver/provider wired `twilio-adapter.ts:524`, `app.ts:1807-1814`. Caveat: in-process `setTimeout` (60s), not durable across restart (file header `:3`).
- **Lead auto-create — [WIRED].** `ai/skills/find-or-create-lead.ts:33` (real repo write, idempotent on `23505`), called from adapter `twilio-adapter.ts:747,1032`; `leadRepo` wired `app.ts:1815`.

### Data flywheel — [WIRED]

- **audit_events — [WIRED].** Table `db/schema.ts:60-78` (migration 003, RLS); writes via `auditRepo.create` (e.g. `create-voice-turn-processor.ts:404-414`).
- **Voice transcripts via pg-voice-audit.ts — [WIRED].** `voice/pg-voice-audit.ts:126` (`PgVoiceAuditRepository`) → `voice_transcription_attempts` (`:136`), `voice_transcript_versions` (`:208`), `voice_command_runs` (`:271`). Per-turn transcript also in `call_transcript_turns` (schema.ts:1519) and stamped onto `voice_sessions` (`create-voice-turn-processor.ts:770-772`).
- **proposal_executions as-executed payload — [WIRED].** See Autonomy engine above (`executor.ts:165,259`; table `db/schema.ts:1541-1565`).

### Stubs / bugs

- **QuickBooks pure mock — [STUB] (CONFIRMED).** `packages/web/src/components/settings/QuickBooksModal.tsx:23-26` — `handleConnect` is `setTimeout(()=>setStep('connected'),1800)`; "Connected" / QBO #8821 / sync rows are hardcoded literals (`:143,:190-192`). No OAuth, no network.
- **Language/voice overrides placeholder — [STUB] (CONFIRMED).** `packages/web/src/pages/settings/LanguageSettings.tsx:5-6` (header: voice overrides + Spanish dispatcher UID are placeholders). The page does persist `defaultLanguage`/`autoDetectLanguage`; the voice-override portion is a placeholder.
- **review-response Google reply — [STUB] (conditional no-op).** `ReviewResponseExecutionHandler` wired with optional `googleReplyResolver` (`proposals/execution/handlers.ts:530-535`). `executePublicResponse` returns `{ok:true}` WITHOUT posting when the resolver is absent (`proposals/execution/review-response-handler.ts:201-206`, logs a "TODO wire at composition root"). The resolver is not constructed in `app.ts`, so in practice the Google public reply is a silent no-op; private-message + service-credit paths do run.
- **Calendar sync one-way only — [WIRED] one-way (CONFIRMED).** `integrations/calendar-sync.ts:11-16` — push-only (`pushForTechnician`/`pushForTechnicians`, `:109,:204`); no inbound/pull/watch path. App → Google only.
- **"Good morning, Mike" hardcoded — [STUB] (CONFIRMED).** `packages/web/src/components/home/HomePage.tsx:323` — `<h1>Good morning, Mike ☀️</h1>`, hardcoded name + time-of-day.
- **InvoicesPage drops cents via toLocaleString — [BUG] (CONFIRMED, 9 sites).** `packages/web/src/components/invoices/InvoicesPage.tsx` lines 256, 257, 275, 376, 552, 723, 735, 744, 868 use `.toLocaleString()` on cents-derived values (no `minimumFractionDigits`), dropping/rounding cents. Edit path uses `.toFixed(2)` correctly (`:247`), confirming the display calls are the inconsistent ones.
- **DB health returns 'degraded' not 503 — [WIRED] by design (line drift 523→530).** `app.ts:530` returns `{status:'degraded'}`; `/health` always 200 (`health/health.ts:45`, deliberate for Railway liveness). `/ready` (`:60`) can 503 on `down`, but the DB check only ever emits `degraded` (never `down`), so even `/ready` won't 503 on a DB blip.

### Reliability

- **RLS — [WIRED]: 75 distinct tables, BOTH ENABLE + FORCE, perfect parity (prior "75/75" HOLDS).** `db/schema.ts`: 75 distinct tables have `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and the same 75 have `… FORCE ROW LEVEL SECURITY`; `comm`/`diff` of the distinct-table sets shows ZERO mismatch (no ENABLE-without-FORCE). Raw line counts are higher (≈79 ENABLE / ≈78 FORCE) due to duplicate `ALTER` statements across migration history — these are NOT distinct-table gaps. (The parallel agent's reported "1-table gap" was a raw-line-count artifact; distinct-table reality is 75/75.)
- **Webhook idempotency fail-closed — [WIRED].** `webhooks/routes.ts:187-194` — throws at boot in prod/production when `webhookRepo` (durable dedup) is absent. (Prior cite :182 → :187-194.)
- **/metrics auth-gated — [WIRED].** `app.ts:560-585` via `checkMetricsAuth`; `bootstrap/metrics-auth.ts`: prod/staging with no `METRICS_TOKEN` → 503, token set → `timingSafeEqual` bearer → 401 on mismatch; dev/test open. (Prior :406,553 → :560-571, import :408.)
- **Transcripts AES-256-GCM — [WIRED].** `integrations/crypto.ts:15-22` (real `aes-256-gcm`, 12-byte IV, auth tag, 32-byte key); called from `workers/transcription.ts:86`, keyed from `TRANSCRIPT_ENCRYPTION_KEY` (`:251`); no plaintext retained if key unset.
- **DNC consent gate built but NO outbound calling — [WIRED] (CONFIRMED).** `grep 'calls.create'` across `packages/api/src` → no matches. No Twilio/Vapi call origination; Vapi webhook (`webhooks/routes.ts:1955`) is inbound-only. Consent/DNC gating exists with nothing to gate.

### Onboarding

- **Self-serve onboarding — [WIRED], but 7 steps not 6 (CORRECTION).** `onboarding/contracts.ts:64` (`OnboardingStepIdSchema = signup, identity, pack, phone, billing, ai_check, test_call`; response requires exactly 7 steps `:84`) and `onboarding/derive-status.ts:68` (same order). The prior "6-step" claim omits the leading `signup` step (`signup: tenantExists`, derive-status.ts:59); the 6 named steps (identity → pack → phone → billing → ai_check → test_call) are all present and correctly ordered after it.
- **NO concierge path — [CONFIRMED ABSENT].** `routes/onboarding.ts` exposes only self-serve endpoints; no `concierge`/`manual`/`assisted` step in the enum and no manual-provisioning route. Status is purely derived (`deriveOnboardingStatus`).

---

## 3. Changes since prior audit

| # | Claim (prior) | Prior tag | Current | What changed |
|---|---------------|-----------|---------|--------------|
| 1 | Voice approval "say approve" via readback.ts | EXISTS-UNVERIFIED | **[STUB]** | `readback.ts` exports are referenced only by their unit test — never imported by any runtime handler. Operator voice-approval is built+unit-tested but not wired. (Cite shifted 19-51 → 19-21/53/144-156.) |
| 2 | Tech-status OUT/SICK keyword handler registered | (implied wired) | **[STUB]** | **Regression:** `registerTechStatusKeywords` (`sms/tech-status/index.ts:29`) has no production caller. `app.ts:661-662` registers only STOP/START. OUT/SICK never reaches the live dispatcher. |
| 3 | Proactive owner SMS via `queue_and_sms` | (path exists) | **[STUB]** | No code reads `unsupervised_proposal_routing` to send an SMS; the "routing worker" promised in comments does not exist. Owner-cell-patch send (`owner-cell-patch.ts:150`) also has no production caller. (Cite app.ts:2558 → 2620/2628.) |
| 4 | ProposalOutcome analytics in-memory | EXISTS-UNVERIFIED | **[STUB]** | No PG repo, and `InMemoryProposalAnalyticsRepository` is not wired into `app.ts` at all — referenced only in tests. Unreachable in prod. |
| 5 | Stripe reconciliation | EXISTS-UNVERIFIED | **split: webhook [WIRED] / `invoice-payment-reconciler.ts` [STUB]** | Real reconciliation is the Stripe webhook → `recordPayment` (wired). The file named like a reconciler is dead code (zero callers). |
| 6 | Late-fee math | EXISTS-UNVERIFIED | **[STUB]** | `computeLateFeeCents` has zero non-test callers; not wired to any worker/route. |
| 7 | Auto-invoice-on-completion (P20-001) | WIRED | **[WIRED] (clarified)** | Confirmed wired, but it auto-DRAFTS a `draft_invoice` proposal requiring approval — it does not auto-create or auto-send an invoice. |
| 8 | Onboarding 6-step | (6 steps) | **[WIRED], 7 steps** | Enum is 7 steps (`signup` + the 6 named). No concierge path — confirmed. |
| 9 | RLS 75/75 FORCE | verified | **[WIRED], holds** | Distinct-table parity is still 75 ENABLE + 75 FORCE with zero mismatch. (Raw line counts are higher due to duplicate ALTERs across migrations — not a real gap.) |
| 10 | proposal_executions as-executed payload | WIRED | **[WIRED], holds** | Confirmed written (`executor.ts:165,259`). NOTE: a stale in-file comment (`proposal-execution.ts:22-24`) wrongly claims "no caller writes this yet". |
| — | Line drifts (no behavior change) | — | — | DB health degraded 523→530; webhook idempotency 182→187-194; /metrics 406/553→560-571; SMS route ~654-655→1952; queue_and_sms 2558→2620/2628. |

**Net brutal-honesty headline:** the build is green and the autonomy/approval *core* (proposal classification, mode-aware auto-approve gate, unsupervised hard-block, 5s undo, advisory-lock idempotency, execution + as-executed capture) is genuinely [WIRED] and reachable. The drift since the prior audit is uniformly in the **degrade direction**: several "exists" surfaces are now confirmed dead/unwired — operator voice-approval (readback), tech-status OUT/SICK SMS (regressed to unregistered), the entire proactive owner-SMS notification path (`queue_and_sms` has no sender), proposal-outcome analytics, multi-step dunning, late-fee math, and the named Stripe reconciler. Money still moves (Stripe pay + webhook reconciliation are wired); the collection/dunning/late-fee tail is not.
