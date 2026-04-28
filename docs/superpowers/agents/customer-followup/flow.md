# Customer Follow-Up Agent — Flow

**Purpose:** Initiate **outbound** customer contact based on event-driven triggers. Examples: nudge after estimate sent + 3 days, payment reminder when invoice 7/14/30 days overdue, post-job satisfaction check 24h after completion, appointment reminder 24h before scheduled time.

Channels v1: **SMS** (Twilio Programmable Messaging). Channels v2: **email** (SES). Channels v3: **outbound voice** (Twilio Voice with the calling agent's brain in reverse — the agent dials the customer and runs the same orchestration).

**Companion files:** `skills.md`, `test-plan.md`, `implementation-roadmap.md`. **Framework:** `../README.md`.

This agent is **fundamentally different** from the calling agent:
- **Calling agent:** synchronous, one customer at a time, real-time conversation, customer-initiated.
- **Follow-up agent:** asynchronous, batched, scheduled, system-initiated. Runs as a worker.

The follow-up agent is a scheduled job that fires on triggers, picks the right action per recipient, sends, then waits for replies (which feed back into the calling/in-app voice agent or into a passive thread).

## Trigger model

Triggers are declarative rules in `tenant_followup_rules`:

```ts
type FollowupRule = {
  id: string;
  tenantId: string;
  name: string;
  trigger:
    | { kind: 'estimate_sent', delayHours: number }
    | { kind: 'estimate_no_response', daysSinceSent: number }
    | { kind: 'invoice_overdue', daysOverdue: 7 | 14 | 30 | 60 }
    | { kind: 'appointment_reminder', hoursBefore: 24 | 2 }
    | { kind: 'job_completed', delayHours: 24 }
    | { kind: 'voicemail_dropped', delayHours: 1 }
    | { kind: 'callback_scheduled', minutesBefore: 15 }
    | { kind: 'cron', expression: string };  // escape hatch
  channel: 'sms' | 'email' | 'voice';
  templateId: string;
  enabled: boolean;
  quietHours: { start: string /* HH:mm */, end: string /* HH:mm */ };  // tenant timezone
  perRecipientCooldownDays: number;  // default 3
  perDayCap: number;  // tenant-wide max sends per day per rule
};
```

A scheduler scans rules every minute and emits **follow-up tasks** to the queue. Each task targets one (rule, recipient) pair.

## States

The follow-up agent has two distinct state machines:

### A. Scheduling state machine (per rule)

```
       ┌──────────┐
       │  idle    │ ← scheduler tick (every 1 min)
       └────┬─────┘
            │
            ▼
       ┌─────────────────┐
       │ rule_evaluated  │  finds eligible recipients
       └────┬────────────┘
            │
            ▼
       ┌────────────────────┐  per recipient:
       │ recipient_selected │
       └────┬───────────────┘
            │
            ▼
       ┌─────────────────────────┐
       │ task_enqueued           │
       └─────────────────────────┘
```

### B. Send state machine (per task, per recipient)

```
            ┌──────────┐
            │  pending │
            └────┬─────┘
                 │ task_picked_up
                 ▼
        ┌──────────────────────┐  blocked / cancelled
        │ pre_send_validation  │──────────────────┐
        └────┬─────────────────┘                  │
             │ valid                              │
             ▼                                    │
        ┌──────────────────────┐                  │
        │ message_drafted      │                  │
        └────┬─────────────────┘                  │
             │ approved (auto or human)           │
             ▼                                    │
        ┌──────────────────────┐                  │
        │ sending              │                  │
        └────┬─────────────────┘                  │
             │ provider_ack                       │
             ▼                                    │
        ┌──────────────────────┐                  │
        │ sent                 │                  │
        └────┬─────────────────┘                  │
             │ recipient_replied                  │
             ▼                                    │
        ┌──────────────────────┐                  │
        │ replied              │                  │
        └────┬─────────────────┘                  │
             │ resolved or thread continued       │
             ▼                                    │
        ┌──────────────────────┐                  │
        │ closed               │ ◀────────────────┘
        └──────────────────────┘
```

### State definitions

| State | Description | Entry side effects | Exit |
|---|---|---|---|
| `pending` | Task in queue; not yet picked up. | Worker reservation by visibility timeout. | dequeue success |
| `pre_send_validation` | Re-check eligibility at send time (state may have changed). | Run `evaluate_rule` again, check DNC, check cooldown, check quiet hours, check per-day cap. | `valid` → next; `cancelled` (paid, opted out, etc.) → `closed` with reason |
| `message_drafted` | LLM generates personalized message body from template. | Calls AI gateway with template + recipient context. | drafted |
| `approved` (sub-state) | If rule requires human approval, message lands in proposal queue first. Auto-approve allowed for low-risk templates per tenant settings. | proposal queued OR auto-approved | approved → `sending`; rejected → `closed` |
| `sending` | Calls provider (Twilio SMS, SES, etc.). | Provider call with idempotency key = task id. | provider ack or error |
| `sent` | Provider accepted. | Audit `followup.sent`, persist provider message id. | reply received OR final timeout (e.g. 14 days) |
| `replied` | Recipient responded. | Spawn handler: STOP keyword → DNC + `closed`. Question → escalate. Yes/confirmation → mark resolved. | resolved or continued |
| `closed` | Task done. | Final audit. Compute outcome metric (responded? converted?). | — |

### Cancellation reasons (block at `pre_send_validation`)

- Recipient is on tenant DNC list (added since rule fired)
- Recipient invoice/estimate has been resolved (paid, accepted, rejected)
- Quiet hours active in recipient timezone
- Tenant per-day cap exceeded
- Cooldown active for this (rule, recipient) pair
- Recipient marked do-not-contact at customer level
- Channel temporarily disabled (e.g., SES quota hit)

Each cancellation produces an audit row + the task moves to `closed` with the reason.

## Events

**Scheduler-emitted (state machine A):**
- `scheduler_tick(now: Date)` — every 1 minute
- `rule_disabled(ruleId)` — admin disabled it; pull pending tasks
- `rule_updated(ruleId)` — config changed; pending tasks re-validate

**Worker-emitted (state machine B):**
- `task_picked_up(taskId)`
- `validation_passed` / `validation_failed(reason)`
- `message_drafted(content)`
- `approval_required` / `auto_approved` / `human_approved` / `human_rejected`
- `provider_ack(providerMessageId)`
- `provider_error(error, retriable)`
- `recipient_replied(message)`
- `recipient_opted_out` (STOP keyword on SMS, unsubscribe link on email)
- `delivery_receipt(status: 'delivered' | 'failed' | 'undelivered')` (Twilio status callback)
- `bounce` (SES)
- `final_timeout` (no reply within timeout window)

## Transition table (send state machine)

| State \ Event | task_picked_up | validation_passed | validation_failed | drafted | auto_approved / human_approved | human_rejected | provider_ack | provider_error | replied | opted_out | final_timeout |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pending | →pre_send_validation | — | — | — | — | — | — | — | — | — | — |
| pre_send_validation | — | →message_drafted | →closed [cancelled] | — | — | — | — | — | — | — | — |
| message_drafted | — | — | — | →approved | — | — | — | — | — | — | — |
| approved | — | — | — | — | →sending | →closed [rejected] | — | — | — | — | — |
| sending | — | — | — | — | — | — | →sent | →pending [retriable] / →closed [non-retriable] | — | — | — |
| sent | — | — | — | — | — | — | — | — | →replied | →closed [opted_out] | →closed [no_reply] |
| replied | — | — | — | — | — | — | — | — | — | →closed [opted_out] | — |
| closed | — | — | — | — | — | — | — | — | — | — | — |

## Built-in rules (shipped defaults; tenants can edit/disable)

| Name | Trigger | Channel | Template (key) | Cooldown |
|---|---|---|---|---|
| `appointment_reminder_24h` | 24h before scheduled | SMS | `appointment-reminder-24h` | 0 (one-shot) |
| `appointment_reminder_2h` | 2h before scheduled | SMS | `appointment-reminder-2h` | 0 |
| `estimate_nudge_3d` | 3 days after `estimate_sent`, no `estimate_viewed` | SMS | `estimate-nudge-3d` | 5 days |
| `estimate_nudge_7d` | 7 days, no `estimate_responded` | SMS | `estimate-nudge-7d` | 5 days |
| `invoice_reminder_7d` | 7 days overdue | SMS | `invoice-reminder-7d` | 5 days |
| `invoice_reminder_14d` | 14 days overdue | SMS | `invoice-reminder-14d` | 5 days |
| `invoice_reminder_30d` | 30 days overdue | SMS + email | `invoice-reminder-30d` | 7 days |
| `job_satisfaction_24h` | 24h after `job_completed` | SMS | `job-satisfaction-24h` | n/a (one-shot) |
| `voicemail_followup_1h` | 1h after agent dropped voicemail | SMS | `voicemail-followup-1h` | n/a (one-shot) |
| `callback_reminder_15m` | 15m before scheduled callback | SMS to dispatcher | `callback-reminder-15m` | n/a |

Templates live in `packages/shared/src/templates/followup/<key>.ts` and are tenant-overridable via `tenant_followup_templates`.

## Reply handling

When a recipient replies to an SMS or email, the message is logged into the same conversation as the outbound. If the reply contains:

- `STOP` / `STOPALL` / `UNSUBSCRIBE` / `CANCEL` / `END` / `QUIT` (CTIA-mandated SMS keywords): immediately add recipient to tenant DNC list + send "You've been unsubscribed" auto-response (CTIA-mandated). Mark task `closed (opted_out)`.
- `HELP` / `INFO`: send tenant help text (CTIA-mandated). Task stays `sent`.
- A "yes" / "confirm" / payment-ready / appointment-confirm intent: classify via `intent-classifier` → if matched a known follow-up template's positive response, mark task as resolved + create proposal (e.g. "confirm appointment" → `acknowledge_appointment` proposal).
- A free-text question: spawn the calling-agent's `intent_capture` flow against the reply. May escalate if confidence low.

## Cost & rate caps

- Per-tenant per-day SMS budget: 500 messages (free tier), 5000 (paid), unlimited (enterprise).
- Per-recipient per-rule cooldown: configurable, default 3 days.
- Per-recipient lifetime opt-out: enforced strictly across all rules.
- Per-tenant LLM token budget for follow-ups: shared with general LLM budget; rate-limited by gateway.

## Compliance

- **TCPA:** SMS to non-subscribed customers requires prior express written consent. The follow-up agent must check the customer's consent flag before sending. v1 default = trust customer was opted-in at intake; tenant settings can require explicit double opt-in.
- **CTIA short-code rules:** STOP/HELP keyword handling mandatory.
- **CAN-SPAM (email v2):** unsubscribe link in every footer; physical address; honor opt-out within 10 days.
- **State-specific:** California CCPA, Florida FTSA — additional restrictions on automated messages. Defer to tenant counsel; agent supports per-tenant restriction lists.

## Failure-mode → state map

| Failure | Detection | Behavior |
|---|---|---|
| Twilio 5xx (transient) | provider response | retry with backoff up to 3x; then `closed (provider_error)` |
| Twilio 4xx (invalid number, banned content) | provider response | `closed (non_retriable)` + alert |
| SES bounce (hard) | bounce webhook | mark email invalid on customer; `closed (bounced)` |
| LLM timeout during draft | gateway timeout | retry with cheaper model; second failure → fall back to template default text (no personalization) |
| Database error during validation | repo error | task returned to queue with delay |
| DNC list lookup failed | service unavailable | fail closed (skip send) by default, configurable per tenant |

## Open questions

1. **Auto-approve vs human-approve for follow-up sends?** Default: auto-approve for templates whose AI personalization confidence is ≥ 0.9; otherwise queue for human review. Per-tenant override.
2. **How to handle replies to outbound voice (v3)?** v3 inbound voice flows feed into the calling-agent state machine.
3. **Cross-tenant DNC?** v1 = tenant-local. v2 considers a global "do not contact ever" list across all tenants for users who opt out via consumer-facing portal.
4. **Reply-to email address for v2?** Per-tenant inbound parser address (`reply+<tenant-id>+<task-id>@inbound.serviceos.app`) with bounce/forward to dispatcher inbox.
