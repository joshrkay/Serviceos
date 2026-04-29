# Customer Follow-Up Agent — Test Plan

**Goal:** every rule fires correctly, every cancellation reason cancels correctly, every send hits the wire exactly once, every reply is routed correctly. **Compliance is non-negotiable**: STOP / HELP / quiet hours / DNC / consent are all double-tested (positive + negative).

**Test layers** mirror the calling agent's plan with three additions specific to follow-up:
- **Scheduler tests** — clock-controlled tests verifying rules fire at the right time.
- **Idempotency tests** — every send must be exactly-once even under retries and duplicate scheduler ticks.
- **Long-window tests** — cooldown / per-day cap / cross-day boundaries with a fast-forwardable clock.

Coverage targets:
- Scheduler + send state machines: **95% branch**.
- Skills: **90% statement**.
- Compliance skills (`enforce_dnc`, `enforce_consent`, `keyword_router`, `register_optout`): **100% branch** — every CTIA-mandated keyword and every blocking path tested.

---

## A. Happy paths

| ID | Scenario | Expected |
|---|---|---|
| H1 | `appointment_reminder_24h` fires for a scheduled appointment | SMS sent at +24h before; recipient receives templated text; `followup_send_log` row written with `delivered` status. |
| H2 | `estimate_nudge_3d` fires when no response in 3 days | SMS sent; if recipient replies "ok thanks", task closes as resolved. |
| H3 | `invoice_reminder_7d` fires for overdue invoice | SMS sent with payment link; balance + due date personalized. |
| H4 | Recipient replies "yes, confirmed" to appointment reminder | Reply parsed; task closes; proposal `acknowledge_appointment` queued. |
| H5 | Tenant disables a rule mid-flight | Pending tasks for that rule cancel cleanly; no further sends. |
| H6 | Auto-approve tenant with high-confidence draft | Skips proposal queue; sends directly. |
| H7 | Human-approval tenant with low-confidence draft | Lands in proposal queue with full body + recipient context; dispatcher approves; sends. |
| H8 | Multiple rules fire same hour for same recipient | Each rule's per-recipient cooldown enforced; only one send per cooldown window. |
| H9 | Reply received 13 days after send | Still routed to original task (within 14-day reply-association window). |
| H10 | Reply received 15 days after send | Treated as new conversation; not associated with old task. |

---

## B. Scheduler & rule-evaluation edge cases

| ID | Scenario | Expected |
|---|---|---|
| SC1 | Scheduler tick at boundary minute (e.g. 09:00:00 vs 09:01:00) | Each appointment-reminder rule fires exactly once even if scheduler ticks at slight offset. Idempotency via task-id derived from (rule_id, recipient_id, fire_window). |
| SC2 | Tenant's timezone is non-UTC | Quiet hours, business hours, and per-day caps computed in tenant tz. |
| SC3 | Daylight-saving transition | Appointment reminders still fire 24h before despite DST jump. |
| SC4 | Rule references non-existent template | Task fails validation; alert tenant admin; do not retry. |
| SC5 | Rule trigger references entity that no longer exists (estimate deleted) | `pre_send_validation` cancels task with `recipient_state_changed`. |
| SC6 | Estimate viewed event arrives between rule fire and task pickup | `pre_send_validate` re-evaluates `estimate_no_response` — if viewed, cancel. |
| SC7 | Scheduler runs late (DB backup paused worker for 5 min) | Rules with 24h reminders fire late but still fire; missed windows logged. Sub-windows (`appointment_reminder_2h`) may skip if already too late (< 2h to send), audited as `late_skip`. |

---

## C. Compliance — must double-test

| ID | Scenario | Expected |
|---|---|---|
| CMP1 | Recipient on tenant DNC list | Task cancels at `pre_send_validate` with `dnc_listed`. **No send.** |
| CMP2 | Recipient consent flag = false | Task cancels with `no_consent`. No send. |
| CMP3 | STOP keyword in reply | Recipient added to DNC. CTIA-mandated confirmation reply sent. Future sends to that recipient cancelled. |
| CMP4 | START keyword (resubscribe) | Recipient removed from DNC; CTIA confirmation reply. |
| CMP5 | HELP keyword | Tenant help text auto-replied; task stays open (helpful response, not opt-out). |
| CMP6 | Quiet hours active in recipient timezone | Task delays until exit of quiet hours, OR cancels if trigger window elapsed. |
| CMP7 | Per-day cap exceeded | New tasks blocked; backlog audited; tomorrow's tick resumes. |
| CMP8 | Tenant temporarily suspended (billing issue) | All sends blocked at platform layer. |
| CMP9 | Inbound STOP via reply but recipient is on multiple rules | DNC entry blocks all rules (tenant-wide for this recipient). |
| CMP10 | Reply contains STOP and other text ("STOP - this is too many") | STOP keyword wins; opt-out registered; auto-reply confirms. |
| CMP11 | DNC list service is unreachable | Default fail-closed (skip send) unless tenant explicitly configures fail-open. |
| CMP12 | International recipient where SMS not licensed | Cancel with `unsupported_region`. |

Compliance tests run on every CI run. Failure of any blocks merge.

---

## D. Send + provider edge cases

| ID | Scenario | Expected |
|---|---|---|
| SD1 | Twilio returns 5xx | Retry with backoff, max 3. Then close as `provider_error` and alert. |
| SD2 | Twilio returns 4xx (invalid number) | Mark recipient phone invalid; close non-retriable. Alert tenant. |
| SD3 | Idempotency: scheduler enqueues same task twice | Only one send happens (task id deduped at DB constraint). |
| SD4 | Worker crash mid-send (after Twilio API call but before recording log) | On restart, status callback resolves the truth; reconcile. |
| SD5 | Twilio status callback fires for a long-deleted task | Stored as orphan; investigated periodically. |
| SD6 | Status callback `failed` after `delivered` (reordered) | Treat as terminal failed; alert. |
| SD7 | Recipient phone unsubscribed at carrier level | Twilio returns `21610` → mark recipient phone DNC and close. |

---

## E. Reply handling edge cases

| ID | Scenario | Expected |
|---|---|---|
| RP1 | Reply matches `appointment_reminder` rule's positive keywords ("confirmed", "yes", "👍") | Task resolved; proposal queued. |
| RP2 | Reply doesn't match positive keywords; intent classifier says "free-form question" | Conversation escalated to dispatcher; task moves to `replied` then `closed (escalated)`. |
| RP3 | Reply contains profanity | Logged; passed to dispatcher. No automated counter-reply. |
| RP4 | Reply has a delay/cancellation intent ("can't make Friday") | `reschedule_appointment` proposal queued. |
| RP5 | Reply from a phone number that matches no recent send | Treated as a fresh inbound message; routed to general inbound handling (calling agent's inbound-text path). |
| RP6 | Multiple replies in quick succession | All persisted in conversation; intent classified on most recent + recent context. |

---

## F. Tenant isolation

| ID | Scenario | Expected |
|---|---|---|
| TI1 | Tenant A's rule does not see Tenant B's customers | All queries `withTenant()`. |
| TI2 | Tenant A's DNC list does not affect Tenant B's sends | DNC scoped to tenant. |
| TI3 | Tenant A's send-log has no rows from Tenant B | RLS-enforced. |

---

## G. Cost & rate caps

| ID | Scenario | Expected |
|---|---|---|
| CC1 | Tenant per-day SMS budget exceeded | New sends pause; backlog accumulates; resumes next day. |
| CC2 | Per-recipient cooldown active | New tasks for same (rule, recipient) pair cancel as `cooldown_active`. |
| CC3 | LLM token budget exhausted | Drafting falls back to template default body. |
| CC4 | Tenant exceeds Twilio account spend cap | Twilio returns 400; sends blocked; alert tenant. |

---

## H. Long-running scenarios

| ID | Scenario | Expected |
|---|---|---|
| LR1 | Estimate sent → 14 days no reply → run all sequenced reminders | `estimate_nudge_3d` then `estimate_nudge_7d` fire correctly with cooldowns honored. |
| LR2 | Invoice 60 days overdue with no response | Sequenced 7/14/30/60 reminders all fire; per-day cap respected. |
| LR3 | Recipient replies STOP after `estimate_nudge_3d` | Subsequent `estimate_nudge_7d` cancels. |
| LR4 | Recipient pays invoice between rule fire and task pickup | `pre_send_validate` cancels with `invoice_paid`. |

---

## I. Adversarial / abuse

| ID | Scenario | Expected |
|---|---|---|
| AB1 | Hostile tenant trying to dispatch sends to a non-customer phone (mass spam attempt) | Recipient must be in `customers` table with valid `consent_flags`. Outbound to unknown numbers blocked at platform layer. |
| AB2 | Replay attack: replaying old Twilio status callback | Signature verified; replays detected via timestamp + idempotency. |
| AB3 | LLM-generated message contains policy-violating content (rare; prompt was personalized) | Pre-send content guardrail checks for: explicit profanity, hostile threats, payment-information-fishing patterns. Block + audit + fall back to template default. |
| AB4 | Attacker tries SMS pumping (premium-rate forwarding) by signing up + adding their own number | Per-tenant per-day cap + per-recipient cooldown limit damage. Anomaly detection (many recent customer creations + many sends to same number) flags for review. |

---

## J. Idempotency

| ID | Scenario | Expected |
|---|---|---|
| IDP1 | Scheduler ticks twice in same minute (cron drift) | Task id derived from `(rule_id, recipient_id, fire_window_minute)` deduped at DB unique constraint. |
| IDP2 | Worker picks up task, crashes after `propose_send`, restarts | Proposal already exists with `taskId`; second pickup sees existing proposal and proceeds to `sending` once. |
| IDP3 | Twilio receives the same Idempotency-Key twice | Twilio dedupes; we persist same `provider_message_id` once. |
| IDP4 | Concurrent workers grab same task | Postgres `SELECT FOR UPDATE SKIP LOCKED` ensures exactly-one. |

---

## K. State-machine completeness

A test exhaustively walks the send state machine's state-event matrix from `flow.md`:
- Every state × every event has a deterministic transition.
- Cancellation reasons all reachable.
- `replied` → `closed (resolved)` and `replied` → `closed (escalated)` both tested.
- Final-timeout (no reply within 14 days) closes correctly.

---

## L. Performance

- Scheduler tick latency: median < 200ms (queries 50 active rules over 10k customers).
- Send throughput: sustain 500 SMS/min without queueing slowdown.
- Reply ingestion: < 500ms p95 from inbound webhook to reply handler completion.

---

## M. E2E user journeys (Playwright)

| ID | Journey | Asserts |
|---|---|---|
| E2E1 | Operator creates an appointment for tomorrow at 2pm; advances clock 24h-1m; observes SMS sent in test inbox | Body matches template + appointment data. |
| E2E2 | Operator sends estimate; advances clock 3 days; observes nudge sent | Nudge body links to estimate; tenant brand applied. |
| E2E3 | Customer replies STOP; operator tries to manually send another follow-up | Send blocked with "Customer is on DNC list — see consent flags". |
| E2E4 | Tenant disables `estimate_nudge_3d` mid-flight | Pending tasks for that rule cancel within 1 minute. |

---

## N. Pre-launch checklist

Before this agent sends a single real SMS to a real customer:
- [ ] All A–M tests passing in CI.
- [ ] CTIA short-code campaign approved (or 10DLC registration complete).
- [ ] STOP/HELP keywords tested end-to-end against a real Twilio sandbox.
- [ ] DNC list integration confirmed against a real opt-out request.
- [ ] Tenant settings UI: enable/disable per rule, edit templates, set quiet hours, set per-day caps, set per-recipient cooldown.
- [ ] All built-in templates legal-reviewed for tone + accuracy.
- [ ] Bounce / undeliverable handling tested with a real invalid number.
- [ ] Consent UI on customer creation: explicit "I agree to receive SMS" toggle with date stamp.
- [ ] Audit trail: every send + every cancellation produces an `audit_events` row.
- [ ] Rollback procedure: a single env flag pauses all follow-up sends platform-wide.
- [ ] On-call alerting wired for: provider error rate spike, DNC service down, scheduler stalled.

---

## O. Test-data fixtures

`packages/api/test/agents/customer-followup/fixtures/`:

```
rules/
  appointment-reminder-24h.json
  estimate-nudge-3d.json
  invoice-reminder-7d.json
templates/
  appointment-reminder-24h.txt
  estimate-nudge-3d.txt
  invoice-reminder-7d.txt
inbound/
  reply-confirmed.txt
  reply-stop-uppercase.txt
  reply-stop-lowercase.txt
  reply-stop-with-extra.txt
  reply-help.txt
  reply-question.txt
  reply-reschedule.txt
expected-sends/
  appointment-reminder-24h-known-customer.json
  estimate-nudge-with-personalization.json
twilio/
  status-callback-delivered.json
  status-callback-failed.json
  status-callback-undelivered.json
  inbound-sms-stop.json
  inbound-sms-confirm.json
clocks/
  fast-forward-helpers.ts  // helper to advance vitest's fake timer in scheduler tests
```
