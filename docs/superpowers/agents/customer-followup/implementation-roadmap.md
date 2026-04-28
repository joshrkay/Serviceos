# Customer Follow-Up Agent — Implementation Roadmap

**Goal:** turn `flow.md` + `skills.md` + `test-plan.md` into discrete gap stories that fit the existing P-NNN-NNN format and can be dispatched in parallel waves.

**Phase mapping:** Lives alongside the calling agent in **Phase 8 — Customer Voice Agents**. Stories below are P8-015..P8-027.

**Pre-existing dependencies:** the follow-up agent reuses the calling agent's compliance + cost-cap + entity-resolver skills. Don't dispatch follow-up Wave 8D until Wave 8A from the calling agent has merged.

## Story slice overview

| Story | Title | Size | Wave | Depends on |
|---|---|---|---|---|
| P8-015 | Schema: `tenant_followup_rules`, `followup_send_log`, DNC tables, consent flags | M | 8D | P0-024 (RLS) |
| P8-016 | Built-in rule templates + tenant-overridable template store | S | 8D | — |
| P8-017 | Compliance skills: `enforce_dnc`, `enforce_consent`, `enforce_quiet_hours`, `enforce_cooldown`, `enforce_per_day_cap` | M | 8D | P8-015 |
| P8-018 | `keyword_router` + `register_optout` skills | S | 8D | P8-015 |
| P8-019 | `evaluate_rule` + `select_recipients` skills | M | 8D | P8-015 |
| P8-020 | `enqueue_followup_task` + scheduler worker (cron loop) | M | 8E | P8-015..P8-019 |
| P8-021 | `pre_send_validate` skill (composes 8-017 + state checks) | S | 8E | P8-017 |
| P8-022 | `draft_followup_message` skill (LLM + templates) | M | 8E | P8-016 |
| P8-023 | `send_sms` (Twilio Messaging) + idempotency + status callback | M | 8E | P8-015 |
| P8-024 | Send state machine + worker | M | 8F | P8-021..P8-023 |
| P8-025 | Inbound SMS reply handler + `handle_reply` skill | M | 8F | P8-024 |
| P8-026 | Tenant settings UI: enable/disable rules, edit templates, set quiet hours, view send-log | M | 8F | P8-015..P8-024 |
| P8-027 | Auto-approve threshold logic + per-template approval routing | S | 8F | P8-022, P8-024 |

**Wave plan:**

| Wave | Stories | Mode | Blocks |
|---|---|---|---|
| 8D | P8-015, P8-016, P8-017, P8-018, P8-019 | parallel (5 agents); P8-015 must merge first within 8D since others depend on schema | 8E |
| 8E | P8-020, P8-021, P8-022, P8-023 | parallel (4 agents) | 8F |
| 8F | P8-024, P8-025, P8-026, P8-027 | parallel (4 agents) | done |

Sub-rule: within 8D, the schema story (P8-015) is dispatched alone first, merged, then the other four 8D stories dispatch in parallel.

Sprint estimate: **3 wall-clock days** (8D ≈ 1 day with schema-first sub-step, 8E ≈ 1 day, 8F ≈ 1 day).

**Combined with calling agent:** Sprint Phase 8 = ~6 wall-clock days for both agents.

---

## Story specs

### P8-015 — Schema: rules, send-log, DNC, consent

> **Size:** M | **Layer:** Data | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-024 (RLS middleware)

**Allowed files:** `packages/api/src/db/schema.ts, packages/api/src/agents/customer-followup/schema-types.ts`

**Build prompt:** Add migrations for:
- `tenant_followup_rules` (rule config per tenant)
- `tenant_followup_templates` (overrides for built-in templates)
- `followup_tasks` (one row per scheduled send)
- `followup_send_log` (one row per actual send + status)
- `tenant_dnc_list` (recipient phone, opted_out_at, source)
- `customer_consent_flags` (sms, email, voice — bool + timestamp + source)

All tables tenant-scoped via RLS. Unique constraints on:
- `(rule_id, recipient_id, fire_window_minute)` — idempotency key for tasks.
- `(tenant_id, recipient_phone)` — DNC dedup.
- `(send_log_id, status_event_id)` — Twilio callback dedup.

**Migration number reservation:** `050_*`–`054_*` (5 tables across this story).

**Required tests:**
- [ ] Migration up + down clean
- [ ] RLS prevents cross-tenant reads on every table
- [ ] Unique constraints reject duplicates
- [ ] Indexes used for the scheduler's hot queries (verify with EXPLAIN)

**Forbidden files:** any file outside the allowed list.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P8-015|followup_schema"
```

---

### P8-016 — Built-in rule templates

> **Size:** S | **Layer:** Shared | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** none

**Allowed files:** `packages/shared/src/templates/followup/**, packages/api/test/templates/**`

**Build prompt:** Define the 10 built-in templates listed in `flow.md` (`appointment_reminder_24h` … `callback_reminder_15m`). Each template:
- Static base copy
- Variable interpolation slots (e.g. `{{customer.firstName}}`, `{{appointment.scheduledFor}}`, `{{tenant.brandName}}`)
- LLM personalization prompt (cheap-tier)
- Positive-response keywords (used by reply handler to detect resolution)

**Required tests:**
- [ ] Each template renders with mock context
- [ ] Missing variable raises clear error
- [ ] Tenant override loaded preferentially
- [ ] Templates ≤ 160 char base where SMS-targeted (single SMS segment)

---

### P8-017 — Compliance skills bundle

> **Size:** M | **Layer:** Compliance | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P8-015

**Allowed files:** `packages/api/src/compliance/**, packages/api/test/compliance/**`

**Build prompt:** Five small skills, one PR:
- `enforce_dnc` (reads `tenant_dnc_list`)
- `enforce_consent` (reads `customer_consent_flags`)
- `enforce_quiet_hours` (recipient timezone + tenant config)
- `enforce_cooldown` (queries `followup_send_log`)
- `enforce_per_day_cap` (queries `followup_send_log` for today)

Each is a pure function returning `{ blocked: boolean, reason?: string }`. Compose them in `pre_send_validate` (P8-021).

**Required tests:** every blocking path + every passing path. **100% branch coverage** required for this story.

---

### P8-018 — Keyword router + opt-out registration

> **Size:** S | **Layer:** Compliance | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P8-015

**Allowed files:** `packages/api/src/agents/customer-followup/keyword-router.ts, packages/api/src/agents/customer-followup/optout.ts, packages/api/test/agents/customer-followup/**`

**Build prompt:** CTIA-mandated keyword detection + DNC registration + auto-reply confirmation. Test for every keyword variant (case, with surrounding punctuation, with extra words). Use a static list — never an LLM for this — to avoid LLM-introduced misclassification of opt-out intent.

**Required tests:** every CTIA-mandated keyword, mixed-case, surrounded by other text, common typos like "stoppppp". **Failing to detect opt-out = legal liability**, treat as a critical correctness test.

---

### P8-019 — Rule evaluation + recipient selection

> **Size:** M | **Layer:** AI/Data | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P8-015

**Allowed files:** `packages/api/src/agents/customer-followup/rule-evaluator.ts, packages/api/src/agents/customer-followup/recipient-selector.ts, packages/api/test/agents/customer-followup/**`

**Build prompt:** Implement the rule queries from `skills.md`. Each rule kind has its own SQL. Recipient selector resolves entity refs to a `Recipient` record with phone/email/timezone/preferred channel. Tenant-scoped via `withTenant()`.

**Required tests:** every rule kind with a fixture recipient + non-matching state (e.g. invoice already paid).

---

### P8-020 — Scheduler worker

> **Size:** M | **Layer:** Workers | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P8-019, P8-015

**Allowed files:** `packages/api/src/workers/followup-scheduler.ts, packages/api/src/agents/customer-followup/task-queue.ts`

**Build prompt:** 1-minute cron worker. Iterates enabled rules per tenant, calls `evaluate_rule`, calls `enqueue_followup_task` for each result, dedupes by task idempotency key. v1 uses `setInterval` in-process; v2 uses external scheduler when needed.

---

### P8-021 — `pre_send_validate` (composes 8-017 + state checks)

> **Size:** S | **Layer:** AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P8-017

**Allowed files:** `packages/api/src/agents/customer-followup/pre-send-validate.ts, packages/api/test/agents/customer-followup/**`

**Build prompt:** Composes the five compliance checks + entity-state revalidation (invoice still overdue? estimate still unread? appointment still scheduled?). Returns `{ valid, reason }`.

---

### P8-022 — `draft_followup_message`

> **Size:** M | **Layer:** AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P8-016, P0-027

**Allowed files:** `packages/api/src/agents/customer-followup/draft-message.ts`

**Build prompt:** Calls LLM gateway with template + recipient context; returns `{ body, confidence, modelUsed }`. Falls back to non-personalized base text on LLM failure.

**Required tests:** template render + LLM mock, fallback on LLM error, confidence threshold for auto-approve (≥ 0.9 default).

---

### P8-023 — `send_sms` + idempotency + status callback

> **Size:** M | **Layer:** Telephony | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P8-015

**Allowed files:** `packages/api/src/notifications/sms/**, packages/api/src/routes/telephony.ts, packages/api/test/notifications/sms/**`

**Build prompt:** Twilio Messaging API client + status callback handler. Idempotency key = task id. Status callback updates `followup_send_log.status`. Handle 5xx (retriable) vs 4xx (non-retriable) errors.

---

### P8-024 — Send state machine + worker

> **Size:** M | **Layer:** AI | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P8-021..P8-023

**Allowed files:** `packages/api/src/agents/customer-followup/send-machine.ts, packages/api/src/workers/followup-sender.ts, packages/api/test/agents/customer-followup/**`

**Build prompt:** State machine from `flow.md` (send half). Worker dequeues, walks the machine, persists transitions. Channel-agnostic; concrete sender (`send_sms`) injected.

---

### P8-025 — Inbound SMS reply handler

> **Size:** M | **Layer:** AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P8-024

**Allowed files:** `packages/api/src/agents/customer-followup/reply-handler.ts, packages/api/src/routes/telephony.ts, packages/api/test/agents/customer-followup/**`

**Build prompt:** Inbound Twilio webhook → match to recent send → keyword router first → if non-keyword, run reference-resolver + intent-classifier → resolve task or escalate.

---

### P8-026 — Tenant settings UI

> **Size:** M | **Layer:** UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P8-015..P8-024

**Allowed files:** `packages/web/src/components/settings/Followups/**, packages/web/src/hooks/useFollowupRules.ts, packages/api/src/routes/followup-rules.ts`

**Build prompt:** Settings page sections:
- Rule list with enable/disable toggle
- Per-rule editor (template body, quiet hours, cooldown, cap)
- Send log viewer with filters
- DNC list viewer (read-only; remove via revoke flow)

---

### P8-027 — Auto-approve threshold logic

> **Size:** S | **Layer:** AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P8-022, P8-024

**Allowed files:** `packages/api/src/agents/customer-followup/approval-router.ts, packages/api/test/agents/customer-followup/**`

**Build prompt:** Per-template + per-tenant decision: auto-send vs queue for human approval. Defaults: auto-approve if `template.autoApprove === true && draft.confidence >= 0.9`. Per-tenant override flips defaults globally.

---

## Dispatch addendum metadata

After this roadmap is approved, append to `docs/superpowers/contracts/p8-dispatch-addendum.md`:

- Wave plan rows for 8D / 8E / 8F (note: 8D's P8-015 must merge before 8D's other stories — single-agent sub-wave then parallel).
- Migration reservations: `050_*`–`054_*` (P8-015), `055_*` (P8-018 if any DNC schema additions).
- Per-story block for P8-015..P8-027.

## Pre-launch checklist (operator-side)

Before flipping the agent on for any tenant:
- [ ] Tenant has Twilio Messaging Service Sid configured (or platform default + opt-in to platform 10DLC).
- [ ] Tenant business hours + quiet hours configured.
- [ ] Tenant has reviewed each built-in rule's template body.
- [ ] Tenant has confirmed compliance with their state's TCPA / CCPA exposure.
- [ ] Initial sends gated to a subset (10 customers) for first 48h to monitor reply / opt-out rate.
- [ ] On-call alerting wired for: opt-out rate > 5%, error rate > 2%, scheduler stalls.

## Out of scope for v1

- **Outbound voice (v3)** — `dial_outbound_voice` skill is medium-large work; defer to dedicated phase.
- **Email channel (v2)** — SES integration; defer.
- **Multi-step conversations on SMS** — v1 treats reply as terminal (resolve, escalate, or close). v2 may run multi-turn.
- **Cross-tenant DNC** — v1 is tenant-local.

## Sequencing

Wave 8D depends on Sprint 1 (P0-024 RLS) being fully merged. Wave 8E depends on 8D. Within 8D, the schema story (P8-015) is dispatched and merged first, then 8D's other four stories run parallel.

The customer-calling and customer-follow-up agents share the **compliance** layer (`enforce_dnc`, `enforce_quiet_hours`). To avoid duplicate work, dispatch them in this order:
1. Calling agent's Wave 8A → merges including `enforce_compliance` skill.
2. Follow-up agent's Wave 8D → P8-017 imports the calling agent's compliance utilities and extends them with `enforce_consent` + `enforce_cooldown` + `enforce_per_day_cap`.
3. Both agents complete Wave 8B/8E and 8C/8F in parallel.

The combined Phase 8 critical path is ≈ 6 wall-clock days.
