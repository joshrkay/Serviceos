# Customer Follow-Up Agent — Skills

Many of these skills are **shared with the customer-calling agent**. The follow-up agent reuses the orchestration brain (entity resolver, intent classifier, summarize) for handling replies; what's new is the **outbound** half — scheduler, channel adapters, opt-out / DNC enforcement, and template-based message drafting.

## Skill index

| Skill | Used in states | Wraps existing | New code | Shared with calling agent |
|---|---|---|---|---|
| `evaluate_rule` | scheduler tick | settings repo, customer/job/invoice/estimate Pg repos | medium | new |
| `select_recipients` | rule_evaluated | repos | medium | new |
| `enqueue_followup_task` | recipient_selected | queue (PgQueue) | small | new |
| `pre_send_validate` | pre_send_validation | DNC, business hours, cooldown, per-day cap, recipient state | medium | partial — reuses `enforce_compliance` |
| `draft_followup_message` | message_drafted | LLM gateway + template system | medium | new |
| `enforce_quiet_hours` | pre_send_validate | business hours utility | small | shared (`enforce_compliance` extends it) |
| `enforce_dnc` | pre_send_validate | DNC list service | small | shared |
| `enforce_consent` | pre_send_validate | customer.consent_flags | small | new |
| `enforce_cooldown` | pre_send_validate | followup_send_log | small | new |
| `enforce_per_day_cap` | pre_send_validate | followup_send_log + tenant limits | small | new |
| `propose_send` | message_drafted → approved | proposal repo | small | partial — reuses `draft_proposal` for tenants requiring approval |
| `send_sms` | sending | Twilio Messaging API | medium | new |
| `send_email` (v2) | sending | SES | medium | new |
| `dial_outbound_voice` (v3) | sending | Twilio Voice + calling-agent state machine | large | leverages calling agent in reverse |
| `record_send_log` | sent | followup_send_log repo | small | new |
| `handle_reply` | replied | reference-resolver, intent-classifier | medium | reuses calling-agent skills |
| `keyword_router` | replied | static keyword map (STOP/HELP) | small | new |
| `register_optout` | replied (opted_out path) | DNC list write | small | new |
| `handle_delivery_receipt` | sent (background) | followup_send_log update | small | new |
| `enforce_session_caps` | always (background) | session-cost-tracker | small | shared |
| `emit_audit` | every transition | audit repo | small | shared |

## Skill specs

---

### `evaluate_rule` (new — medium)

Periodic scheduler step. For each enabled rule, query the underlying entities and return a list of (rule, recipient, fireAt) triples that should be enqueued.

**Input:** `{ rule: FollowupRule, now: Date }`
**Output:** `Array<{ rule, recipient, fireAt, reason }>`
**Errors:** `RepositoryError`
**Cost ceiling:** `0` (DB only)
**State:** `rule_evaluated`
**New file:** `packages/api/src/agents/customer-followup/rule-evaluator.ts`

**Implementation notes:**
- For `estimate_no_response`: query `estimates WHERE status = 'sent' AND sent_at < now - rule.daysSinceSent AND id NOT IN (SELECT estimate_id FROM followup_send_log WHERE rule_id = $1 AND sent_at > now - cooldown)`.
- For `invoice_overdue`: similar, with `due_date < now - rule.daysOverdue`.
- For `appointment_reminder`: `scheduled_for BETWEEN now + rule.hoursBefore AND now + rule.hoursBefore + 1m` (one-minute window per scheduler tick).
- All queries are tenant-scoped via `withTenant()`.

---

### `select_recipients` (new — medium)

Resolves a rule's recipient pointer (e.g. an estimate id) to a contactable recipient (customer + best phone/email).

**Input:** `{ rule, entityRef: { kind: 'estimate' | 'invoice' | 'appointment' | 'job', id: string } }`
**Output:**
```ts
type Recipient = {
  customerId: string;
  phone?: string;
  email?: string;
  preferredChannel: 'sms' | 'email' | 'voice';
  consentFlags: ConsentFlags;
  timezone: string;
};
```
**Errors:** `RecipientNotFound`, `NoContactInfo`
**State:** `recipient_selected`
**New file:** `packages/api/src/agents/customer-followup/recipient-selector.ts`

---

### `enqueue_followup_task` (new — small)

Persists the task and posts to `PgQueue`.

**Input:** `{ rule, recipient, fireAt, contextSnapshot }`
**Output:** `{ taskId }`
**Errors:** `QueueError`
**State:** `task_enqueued`
**New file:** `packages/api/src/agents/customer-followup/task-queue.ts`

---

### `pre_send_validate` (new — medium, but composes mostly existing skills)

Runs at task pickup time (not at enqueue) because state may have changed. Composes:
- `enforce_dnc(recipient)`
- `enforce_quiet_hours(recipient.timezone, rule.quietHours, now)`
- `enforce_consent(recipient, rule.channel)`
- `enforce_cooldown(rule, recipient)`
- `enforce_per_day_cap(rule.tenantId, rule.id)`
- Re-check entity state — has the invoice been paid? Has the estimate been responded to? Is the appointment cancelled? — and skip if so.

**Input:** `{ task, now }`
**Output:** `{ valid: true } | { valid: false, reason: CancellationReason }`
**State:** `pre_send_validation`
**New file:** `packages/api/src/agents/customer-followup/pre-send-validate.ts`

---

### `draft_followup_message` (new — medium)

Calls LLM gateway with the template + recipient context to produce a personalized message body.

**Input:** `{ template, recipient, contextSnapshot }`
**Output:** `{ body: string, confidence: number, modelUsed: string }`
**Errors:** `LlmTimeout`, `TemplateNotFound`
**Cost ceiling:** `< $0.005 / draft` (use cheap tier; templates are short).
**State:** `message_drafted`
**New file:** `packages/api/src/agents/customer-followup/draft-message.ts`

**Failure handling:** if LLM unavailable, fall back to template default body (no personalization) and log degraded mode.

---

### `enforce_quiet_hours` (small)

Returns true if `now` (in recipient timezone) is within tenant quiet hours.

**Input:** `{ recipientTimezone, quietHours, now }`
**Output:** `{ blocked: boolean }`
**New file:** `packages/api/src/compliance/quiet-hours.ts` (used by both calling and followup agents).

---

### `enforce_dnc` (small)

Returns true if recipient is on tenant or global DNC list.

**Input:** `{ tenantId, recipientPhone | recipientEmail }`
**Output:** `{ blocked: boolean, listId?: string }`
**New file:** `packages/api/src/compliance/dnc.ts` — used by calling agent's `enforce_compliance` and follow-up agent.

---

### `enforce_consent` (small)

Reads `customer.consent_flags` (boolean per channel). For SMS, requires `sms_consent = true`.

**Input:** `{ customerId, channel }`
**Output:** `{ blocked: boolean, reason?: string }`
**New file:** `packages/api/src/compliance/consent.ts`

---

### `enforce_cooldown` (small)

Checks `followup_send_log` for any send to this (rule, recipient) pair within `rule.perRecipientCooldownDays`.

**Input:** `{ ruleId, recipientId, cooldownDays }`
**Output:** `{ blocked: boolean }`
**New file:** `packages/api/src/agents/customer-followup/cooldown-checker.ts`

---

### `enforce_per_day_cap` (small)

Checks total sends today for this rule against `rule.perDayCap` (tenant) and against the tenant's plan-level total cap.

**Input:** `{ tenantId, ruleId, perDayCap }`
**Output:** `{ blocked: boolean }`
**New file:** same module as cooldown checker.

---

### `propose_send` (small — wrap)

For tenants requiring human approval: queues the drafted message as a `send_followup` proposal. For auto-approve tenants/templates: skips this and goes straight to `sending`.

**Input:** `{ tenantId, channel, recipient, body, ruleId, taskId }`
**Output:** `{ proposalId? } | { autoApproved: true }`
**Wraps:** existing proposal engine.

---

### `send_sms` (new — medium)

Twilio Messaging API. Idempotency key = task id.

**Input:** `{ tenantId, fromNumber, toPhone, body, taskId }`
**Output:** `{ providerMessageId }`
**Errors:** `TwilioApiError` (with `retriable: boolean`).
**State:** `sending`
**New file:** `packages/api/src/notifications/sms/twilio-sms-sender.ts`

**Implementation notes:**
- Status callback URL: `/api/telephony/sms-status`
- Idempotency: Twilio SDK supports a `MessagingServiceSid` + an idempotency key in v2026.x; if not, rely on our own dedupe by `taskId`.
- Per-tenant Messaging Service Sid (or fallback to platform default).

---

### `send_email` (new — medium, v2 scope)

SES (or alternative). Out of v1 scope.

---

### `dial_outbound_voice` (large, v3 scope)

Out of v1 scope. The implementation detail when we get there: Twilio outbound call → connect to media stream → run the calling-agent state machine in "outbound" mode (the `greeting` becomes "Hi, this is Bob calling from <tenant>…" and the rest of the flow proceeds).

---

### `record_send_log` (small)

Persists the send: `tenant_id, rule_id, recipient_id, channel, body, sent_at, provider_message_id, status`.

**New file:** `packages/api/src/agents/customer-followup/send-log-repo.ts`

---

### `handle_reply` (medium — reuse + new)

When a recipient replies to a follow-up SMS:

1. Match inbound message to a recent send (by recipient phone + tenant's sending number within 14 days).
2. Run `keyword_router` first — STOP / HELP keywords short-circuit.
3. If non-keyword: feed into reference-resolver + intent-classifier (calling-agent's brain). Classify intent.
4. If intent is a known positive response (e.g. "confirm appointment", "I'll pay tomorrow"), mark task resolved + create the corresponding proposal.
5. If intent is a free-text question, escalate: route to dispatcher inbox or open a web conversation.

**Input:** `{ tenantId, fromPhone, body, providerMessageId, receivedAt }`
**Output:** `{ taskId?, classification: ReplyClassification, proposalId? }`
**State:** `replied`
**Wraps:** reference-resolver, intent-classifier, proposal engine.
**New file:** `packages/api/src/agents/customer-followup/reply-handler.ts`

---

### `keyword_router` (small)

Static keyword detection. Case-insensitive, whole-word match for SMS-mandated keywords:
- `STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT` → register opt-out + auto-reply.
- `HELP / INFO` → tenant help text auto-reply.
- `START / YES / UNSTOP` (resubscribe per CTIA) → remove from DNC + auto-reply confirm.

**Input:** `{ body }`
**Output:** `{ keyword?: 'stop' | 'help' | 'start' }`
**New file:** `packages/api/src/agents/customer-followup/keyword-router.ts`

---

### `register_optout` (small)

Adds recipient to tenant DNC list. Sends CTIA-mandated confirmation auto-reply.

**Input:** `{ tenantId, recipientPhone }`
**Output:** `{ optedOutAt }`
**State:** `replied → closed (opted_out)`
**New file:** module with `dnc.ts`.

---

### `handle_delivery_receipt` (small)

Twilio status callback → update `followup_send_log.status` to `delivered`, `failed`, `undelivered`.

**Input:** `{ providerMessageId, status, errorCode? }`
**Output:** `{ updated: boolean }`
**New file:** `packages/api/src/notifications/sms/status-callback-handler.ts`

---

### `enforce_session_caps` / `emit_audit` (shared with calling agent)

Same skills, no new code. Documented in calling-agent's `skills.md`.

## Build vs reuse summary

| Status | Skills |
|---|---|
| Reuse (shared with calling agent) | `enforce_session_caps`, `emit_audit`, parts of `pre_send_validate` (DNC, business hours wrappers) |
| Wrap existing | `draft_followup_message` (wraps gateway), `propose_send` (wraps proposal engine), `handle_reply` (wraps orchestration) |
| New (small) | `enqueue_followup_task`, `enforce_quiet_hours`, `enforce_dnc`, `enforce_consent`, `enforce_cooldown`, `enforce_per_day_cap`, `record_send_log`, `keyword_router`, `register_optout`, `handle_delivery_receipt` |
| New (medium) | `evaluate_rule`, `select_recipients`, `pre_send_validate`, `send_sms` |
| New (large, v2/v3) | `send_email`, `dial_outbound_voice` |

The implementation roadmap slices these into gap stories.
