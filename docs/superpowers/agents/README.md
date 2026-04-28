# ServiceOS Agents — Specification Framework

This directory holds the operational specs for every customer-facing AI agent in ServiceOS. Each agent is defined by **four files**, in this order:

1. `flow.md` — state machine: states, events, transitions, entry/exit side effects.
2. `skills.md` — the discrete capabilities the agent composes; each skill has a contract (input, output, errors, cost ceiling, used-by states).
3. `test-plan.md` — happy / edge / adversarial / cost / compliance cases; how each is exercised.
4. `implementation-roadmap.md` — slices the build into gap stories that fit the existing P-NNN-NNN format and the wave dispatch model.

## Why this shape

Previously we had AI components (intent classifier, task router) but no single artifact saying *what the agent does, in what order, with what guardrails*. Without that, every operator and every reviewer reasons about behavior from code, which doesn't scale and isn't testable.

A flow + skills + test plan turns "the agent" into a contract. Implementation can then be sliced and dispatched in waves like any other story work — see `docs/superpowers/multi-agent-runbook.md`.

## Agent inventory

| Agent | Status | Channels | Trigger |
|---|---|---|---|
| `customer-calling` | spec drafting | inbound phone (Twilio) + in-app voice (web) | inbound — user-initiated |
| `customer-followup` | spec drafting | outbound SMS (+ email v2, voice v3) | event-driven (estimate sent, invoice overdue, job completed, etc.) |
| `invoice` | TBD | inbound voice command + scheduled triggers | mixed |
| `estimate-invoice` | TBD | inbound voice command + estimate→invoice handoff | mixed |

All agents share the same orchestration brain:

```
audio / text →
  reference-resolver  (pronoun + ellipsis rewrite, deterministic) →
  intent-classifier   (LLM, returns IntentType + ExtractedEntities) →
  entity-resolver     (resolve free-text → tenant-scoped IDs) →
  task-router         (dispatch to TaskHandler) →
  proposal            (queued for human approval)
```

What differs between agents is:
- **Session shape** (single-shot in-app vs multi-turn phone vs scheduled outbound)
- **Skills mix** (a calling agent needs `greet`, `hangup`, `dtmf`; a follow-up agent doesn't)
- **Triggers** (user-initiated vs event-driven)
- **Compliance** (TCPA + recording disclosure for telephony; CAN-SPAM for email; opt-out + DNC enforcement for follow-up)

## Reading order for new contributors

1. This README.
2. The agent's `flow.md` (the contract).
3. The agent's `skills.md` (the building blocks).
4. The agent's `test-plan.md` (what "done" means).
5. The agent's `implementation-roadmap.md` (what to build, in what order, in what wave).

## Cross-cutting principles

These apply to every agent and override per-agent guidance if there's conflict.

### Approval boundary
**No agent executes mutations directly.** Every state change is mediated by the proposal engine — the agent's job is to produce a high-confidence proposal and queue it for human approval (or auto-approve when the proposal type and tenant settings permit). The 5-second undo window applies.

### Cost ceilings
Every agent declares per-session caps:
- max LLM tokens (input + output)
- max LLM calls
- max provider $ (rolled up across calls)
- max session duration (wall-clock minutes for telephony, or message count for chat)

When a cap is hit, the agent escalates (telephony: "let me transfer you to someone") or terminates (chat: "I'm going to hand this to a human") — never silently degrades.

### Tenant isolation
Every state read/write goes through `withTenant(tenantId)`. An agent never sees data from another tenant. Cross-tenant testing is part of every test plan.

### Audit
Every state transition emits an audit event (`agent.{name}.{state}.entered` / `agent.{name}.{state}.exited`) with correlation id linking to the conversation, voice recording, proposal, and any external session id (Twilio CallSid).

### Compliance defaults
- **Telephony:** call recording disclosure is the first utterance after greet. State-by-state opt-out support. DNC list checked before any outbound dial.
- **SMS:** STOP / HELP keyword handling per CTIA.
- **Email:** unsubscribe header on every send.
- **All channels:** quiet hours respected per tenant business hours.

### Failure modes have explicit handling
Every flow has named recovery paths for: LLM timeout, STT failure, provider outage, tenant quota exceeded, abuse / profanity, prompt injection, malformed transcripts. Test plan asserts each.

## How to add a new agent

1. Create `docs/superpowers/agents/<agent-name>/` with the four files.
2. Use the customer-calling agent as the template — copy its file shapes and replace content.
3. The implementation roadmap must produce gap stories that follow `docs/stories/phase-N-gap-stories.md` format, with dispatch metadata in `docs/superpowers/contracts/p<N>-dispatch-addendum.md`.
4. Update the agent inventory table at the top of this README.

That's it.
