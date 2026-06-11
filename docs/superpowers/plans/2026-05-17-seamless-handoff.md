# Seamless Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the AI calling agent escalates a call to a human dispatcher, the dispatcher receives full caller context via three parallel channels (Twilio whisper in their ear, SMS to their phone, in-app overlay panel) — and the AI fires escalation on three new triggers (explicit "talk to human", keyword frustration, async LLM sentiment) in addition to the existing low-confidence fallback.

**Architecture:** A new `EscalationSummaryBuilder` produces one structured `EscalationSummary` (whisper/SMS/panel projections) from FSM context + caller identity + transcript snapshot. A new `escalate_with_context` SideEffect carries the summary through the FSM into `mediastream-adapter`, which fan-outs to SMS (existing Twilio delivery provider), in-app SSE event (new `escalation_started` voice-quality event), and Twilio whisper (new `<Dial url=>` attribute pointing to a new `/whisper/:escalationId` webhook backed by a short-TTL cache). Three new triggers feed the same path: `operator_request` intent (LLM classifier), keyword frustration detector (synchronous, free), and per-turn LLM sentiment classifier (async, fire-and-forget, opt-in).

**Tech Stack:** TypeScript, Node 22, Vitest, Twilio Voice + Programmable Messaging, existing LLM gateway (tier-1 model for sentiment), React + SSE on the web, existing `SettingsRepository`.

**Spec:** [docs/superpowers/specs/2026-05-17-seamless-handoff-design.md](../specs/2026-05-17-seamless-handoff-design.md)

---

## File Structure

| Path | Responsibility | Status |
|---|---|---|
| `packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts` | Pure function: build whisper/SMS/panel projections from EscalationContext | Create |
| `packages/api/src/ai/agents/customer-calling/frustration-detector.ts` | Pure function: word-boundary keyword match on transcript | Create |
| `packages/api/src/ai/agents/customer-calling/sentiment-classifier.ts` | Async LLM call returning frustrationScore + cost-cap | Create |
| `packages/api/src/ai/agents/customer-calling/types.ts` | Extend `SideEffectType` with `escalate_with_context`; extend `CallingAgentEvent` with `frustration_detected` | Modify |
| `packages/api/src/ai/agents/customer-calling/transitions.ts` | Add `operator_request` fast-path; add `frustration_detected` event handler | Modify |
| `packages/api/src/ai/orchestration/intent-classifier.ts` | Add `operator_request` intent + system prompt entry | Modify |
| `packages/api/src/ai/voice-quality/events.ts` | Add 6 escalation event variants + constructors | Modify |
| `packages/api/src/ai/skills/escalate-to-human.ts` | Emit `escalate_with_context` SideEffect carrying summary + channel prefs | Modify |
| `packages/api/src/telephony/whisper-cache.ts` | In-memory short-TTL cache for whisper TwiML payloads | Create |
| `packages/api/src/telephony/whisper-route.ts` | New `GET /api/telephony/whisper/:escalationId` route handler | Create |
| `packages/api/src/telephony/twilio-call-control.ts` | Extend `dialDispatcher()` with `whisperUrl?` param emitting `<Number url=>` | Modify |
| `packages/api/src/telephony/twilio-adapter.ts` | Wire frustration detector + sentiment classifier; handle `escalate_with_context` side effect | Modify |
| `packages/api/src/escalations/outcome-route.ts` | New `POST /api/escalations/:id/outcome` handler | Create |
| `packages/api/src/settings/settings.ts` | Extend `TenantSettings` with `escalationSettings` field | Modify |
| `packages/api/src/app.ts` | Wire whisperCache + sentimentClassifier + frustrationDetector into adapter deps | Modify |
| `packages/web/src/components/dispatch/EscalationPanel.tsx` | Floating overlay component (header + customer + intent + reason + transcript snapshot) | Create |
| `packages/web/src/components/dispatch/EscalationPanelHost.tsx` | Mount point + queue management for concurrent panels | Create |
| `packages/web/src/hooks/useEscalationStream.ts` | SSE subscriber for `escalation_started` events | Create |
| `packages/web/src/components/settings/CallRoutingSheet.tsx` | Modal sheet for escalation_settings | Create |
| `packages/web/src/pages/EscalationMobilePage.tsx` | Mobile route at `/c/:escalationId` for SMS short-link | Create |
| `packages/web/src/components/settings/SettingsPage.tsx` | Add "Call Routing & Handoff" section button | Modify |
| `packages/web/src/app.tsx` | Mount `<EscalationPanelHost />` at root | Modify |
| Tests under `packages/api/test/...` and `packages/web/src/components/**/__tests__/...` | TDD test files per task | Create/Modify |

---

## Section 0 — Setup

### Task 0.1: Verify worktree + commit spec/plan

**Files:** none (worktree already created)

- [ ] **Step 1: Verify on the correct branch in the worktree**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git branch --show-current
```

Expected output: `feat/seamless-handoff`

- [ ] **Step 2: Verify production typecheck is green pre-changes**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Confirm vitest runs cleanly on a fixed file**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/transitions.test.ts
```

Expected: existing transitions tests pass.

- [ ] **Step 4: Confirm spec + plan are committed**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff && git log --oneline -2
```

Expected: top commit is `docs(voice): add Seamless Handoff spec (Theme B sub-project 1)`. If the plan file is uncommitted, stage and commit it:

```bash
git add docs/superpowers/plans/2026-05-17-seamless-handoff.md
git commit -m "docs(voice): add Seamless Handoff implementation plan"
```

---

## Section 1 — F1: EscalationSummaryBuilder

### Task 1.1: Define the types

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts`

- [ ] **Step 1: Create the file with type definitions only (no logic yet)**

Create `packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts`:

```typescript
/**
 * Composes dispatcher-ready summaries from FSM context at escalation time.
 *
 * Pure function — no I/O. Used by the escalate-to-human skill to bundle
 * caller identity + intent + transcript snapshot into three coordinated
 * projections (whisper / SMS / in-app panel). Template-based on purpose:
 * adding an LLM call here would block the escalation path with ~500ms of
 * latency and add fabrication risk on critical fields (caller name,
 * address). Spoken phrasing is composed from structured fields.
 */

export type EscalationReason =
  | 'low_confidence_intent'
  | 'operator_request'
  | 'keyword_frustration'
  | 'llm_sentiment'
  | 'emergency_dispatch';

export interface TranscriptTurn {
  role: 'caller' | 'ai';
  text: string;
  ts: number;
}

export interface EscalationContext {
  shopName: string;
  caller: {
    name?: string;
    phone: string;
    customerId?: string;
    tags?: ReadonlyArray<string>;
  };
  customer?: {
    lastService?: { date: Date; type: string; amountCents?: number };
    isMember?: boolean;
    memberTier?: string;
  };
  intent: {
    type: string;
    entities: Record<string, unknown>;
    confidence: number;
  };
  reason: EscalationReason;
  /** Free-form detail: matched keyword, sentiment score, etc. */
  reasonDetail?: string;
  /** Last 4-6 turns before escalation fires. Caller-first ordering. */
  transcriptSnapshot: ReadonlyArray<TranscriptTurn>;
}

export interface PanelData {
  header: { title: string; callerName: string; callerPhone: string };
  customer: {
    name: string;
    phone: string;
    tags: ReadonlyArray<string>;
  };
  lastInteraction: string | null;
  intent: { summary: string; entities: ReadonlyArray<{ key: string; value: string }> };
  reason: { code: EscalationReason; humanReadable: string };
  transcriptSnapshot: ReadonlyArray<TranscriptTurn>;
}

export interface EscalationSummary {
  /** ≤25 words, TTS-friendly, fed to <Say> in whisper TwiML. */
  whisper: string;
  /** ≤160 chars, fits in one SMS segment. */
  sms: string;
  /** Structured object for in-app panel render. */
  panel: PanelData;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors (file has only types, no exports beyond them).

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts
git commit -m "feat(escalation): scaffold EscalationSummaryBuilder types"
```

---

### Task 1.2: Failing test for `buildEscalationSummary`

**Files:**
- Create: `packages/api/test/ai/agents/customer-calling/escalation-summary-builder.test.ts`

- [ ] **Step 1: Create test file with 4 representative cases**

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildEscalationSummary,
  type EscalationContext,
} from '../../../../src/ai/agents/customer-calling/escalation-summary-builder';

function baseCtx(overrides: Partial<EscalationContext> = {}): EscalationContext {
  return {
    shopName: "Joe's HVAC",
    caller: { name: 'Sarah Chen', phone: '+15125550142', customerId: 'cust-1', tags: [] },
    customer: { isMember: false },
    intent: { type: 'create_appointment', entities: { service: 'HVAC repair' }, confidence: 0.4 },
    reason: 'operator_request',
    transcriptSnapshot: [
      { role: 'caller', text: 'My AC is making a clicking sound', ts: 1 },
      { role: 'ai', text: 'When did it start?', ts: 2 },
      { role: 'caller', text: 'Let me talk to a real person', ts: 3 },
    ],
    ...overrides,
  };
}

describe('buildEscalationSummary', () => {
  it('produces whisper text under 25 words for an identified caller', () => {
    const result = buildEscalationSummary(baseCtx());
    expect(result.whisper.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(result.whisper).toContain('Sarah Chen');
    expect(result.whisper.toLowerCase()).toContain('operator');
  });

  it('produces SMS text under 160 chars including short link placeholder', () => {
    const result = buildEscalationSummary(baseCtx());
    expect(result.sms.length).toBeLessThanOrEqual(160);
    expect(result.sms).toContain('Sarah Chen');
    expect(result.sms).toContain("Joe's HVAC");
  });

  it('flags Gold member status in both whisper and SMS', () => {
    const ctx = baseCtx({ customer: { isMember: true, memberTier: 'Gold' } });
    const result = buildEscalationSummary(ctx);
    expect(result.whisper.toLowerCase()).toContain('gold');
    expect(result.sms.toLowerCase()).toContain('gold');
  });

  it('falls back to "unknown caller" phrasing when no name resolved', () => {
    const ctx = baseCtx({ caller: { name: undefined, phone: '+15125550142' } });
    const result = buildEscalationSummary(ctx);
    expect(result.whisper.toLowerCase()).toContain('unknown');
    expect(result.panel.header.callerName).toBe('Unknown caller');
  });

  it('passes the transcript snapshot through to panel verbatim', () => {
    const result = buildEscalationSummary(baseCtx());
    expect(result.panel.transcriptSnapshot.length).toBe(3);
    expect(result.panel.transcriptSnapshot[2].text).toBe('Let me talk to a real person');
  });

  it('maps reason codes to human-readable text in the panel', () => {
    const cases: Array<[EscalationContext['reason'], string]> = [
      ['operator_request', 'asked for a person'],
      ['keyword_frustration', 'frustration'],
      ['llm_sentiment', 'frustration'],
      ['low_confidence_intent', "didn't catch"],
      ['emergency_dispatch', 'emergency'],
    ];
    for (const [reason, expectedSubstring] of cases) {
      const result = buildEscalationSummary(baseCtx({ reason }));
      expect(result.panel.reason.humanReadable.toLowerCase()).toContain(expectedSubstring);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/escalation-summary-builder.test.ts
```

Expected: FAIL with "buildEscalationSummary is not exported" or similar.

---

### Task 1.3: Implement `buildEscalationSummary`

**Files:**
- Modify: `packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts`

- [ ] **Step 1: Append the implementation to the existing file**

Append to `packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts`:

```typescript
function reasonHuman(reason: EscalationReason, detail?: string): string {
  switch (reason) {
    case 'operator_request':
      return 'Caller asked for a person';
    case 'keyword_frustration':
      return `Frustration detected${detail ? ` (${detail})` : ''}`;
    case 'llm_sentiment':
      return `Frustration detected${detail ? ` (sentiment ${detail})` : ''}`;
    case 'low_confidence_intent':
      return "AI didn't catch what they wanted after retries";
    case 'emergency_dispatch':
      return 'Emergency dispatch';
  }
}

function reasonShort(reason: EscalationReason): string {
  switch (reason) {
    case 'operator_request': return 'operator request';
    case 'keyword_frustration': return 'frustration';
    case 'llm_sentiment': return 'frustration';
    case 'low_confidence_intent': return 'low confidence';
    case 'emergency_dispatch': return 'emergency';
  }
}

function intentShort(intent: EscalationContext['intent']): string {
  const service = typeof intent.entities.service === 'string' ? intent.entities.service : null;
  switch (intent.type) {
    case 'create_appointment':
      return service ? `scheduling a ${service} visit` : 'scheduling a visit';
    case 'lookup_appointments': return 'checking on an appointment';
    case 'lookup_invoices': return 'asking about an invoice';
    case 'lookup_balance': return 'asking about their balance';
    case 'create_invoice': return 'wants an invoice';
    case 'cancel_appointment': return 'wants to cancel an appointment';
    case 'reschedule_appointment': return 'wants to reschedule';
    case 'reassign_appointment': return 'wants a different tech';
    case 'emergency_dispatch': return 'emergency';
    case 'unknown': return 'unclear what they need';
    default: return intent.type.replace(/_/g, ' ');
  }
}

function membershipPhrase(customer?: EscalationContext['customer']): string {
  if (!customer?.isMember) return '';
  return customer.memberTier ? `${customer.memberTier} member.` : 'Member.';
}

function membershipTag(customer?: EscalationContext['customer']): string {
  if (!customer?.isMember) return '';
  return customer.memberTier ? `${customer.memberTier} member.` : 'Member.';
}

function formatPhone(phone: string): string {
  // E.164 → readable: +15125550142 → 512-555-0142
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1);
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return phone;
}

function lastInteractionText(customer?: EscalationContext['customer']): string | null {
  if (!customer?.lastService) return null;
  const { date, type, amountCents } = customer.lastService;
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const amount = amountCents != null ? `, $${(amountCents / 100).toFixed(0)}` : '';
  return `Last service: ${dateStr} — ${type}${amount}`;
}

function entitiesAsList(entities: Record<string, unknown>): ReadonlyArray<{ key: string; value: string }> {
  return Object.entries(entities)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => ({ key: k, value: String(v) }));
}

export function buildEscalationSummary(ctx: EscalationContext): EscalationSummary {
  const callerName = ctx.caller.name?.trim() || 'Unknown caller';
  const phoneReadable = formatPhone(ctx.caller.phone);
  const intent = intentShort(ctx.intent);
  const member = membershipPhrase(ctx.customer);
  const reasonText = reasonShort(ctx.reason);

  // Whisper: target ≤25 words. Drop membership phrase if needed.
  const whisperFull = [
    `Incoming call from ${callerName}.`,
    capitalizeFirst(`${intent}.`),
    member,
    `Reason: ${reasonText}.`,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const whisper = ensureMaxWords(whisperFull, 25);

  // SMS: target ≤160 chars. Short link placeholder; route resolves to mobile panel.
  const linkPlaceholder = `app.serviceos.app/c/<escalationId>`;
  const smsCore = `${ctx.shopName}: Incoming call from ${callerName} (${phoneReadable}). Re: ${intent}.${member ? ' ' + member : ''} Reason: ${reasonText}.`;
  const sms = (smsCore.length + linkPlaceholder.length + 1 <= 160)
    ? `${smsCore} ${linkPlaceholder}`
    : `${smsCore}`.slice(0, 160);

  const panel: PanelData = {
    header: {
      title: 'Incoming transfer — answering now',
      callerName,
      callerPhone: phoneReadable,
    },
    customer: {
      name: callerName,
      phone: phoneReadable,
      tags: ctx.caller.tags ?? [],
    },
    lastInteraction: lastInteractionText(ctx.customer),
    intent: {
      summary: `Calling about: ${intent}`,
      entities: entitiesAsList(ctx.intent.entities),
    },
    reason: {
      code: ctx.reason,
      humanReadable: reasonHuman(ctx.reason, ctx.reasonDetail),
    },
    transcriptSnapshot: ctx.transcriptSnapshot,
  };

  return { whisper, sms, panel };
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function ensureMaxWords(s: string, maxWords: number): string {
  const words = s.split(/\s+/);
  if (words.length <= maxWords) return s;
  return words.slice(0, maxWords).join(' ');
}
```

- [ ] **Step 2: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/escalation-summary-builder.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/agents/customer-calling/escalation-summary-builder.ts packages/api/test/ai/agents/customer-calling/escalation-summary-builder.test.ts
git commit -m "feat(escalation): implement buildEscalationSummary with whisper/sms/panel projections"
```

---

## Section 2 — F2: `escalate_with_context` SideEffect

### Task 2.1: Extend `SideEffectType` + add EscalateWithContextPayload helper

**Files:**
- Modify: `packages/api/src/ai/agents/customer-calling/types.ts`

- [ ] **Step 1: Read current SideEffectType union**

Open `packages/api/src/ai/agents/customer-calling/types.ts` and find `SideEffectType` (around line 100).

- [ ] **Step 2: Add the new type to the union and import the summary type**

Replace the `SideEffectType` union with:

```typescript
export type SideEffectType =
  | 'tts_play'
  | 'audit_log'
  | 'create_proposal'
  | 'notify_oncall'
  | 'start_transcription'
  | 'end_session'
  | 'emit_quality_event'
  | 'escalate_with_context';
```

Then near the top of the file (after the existing imports), add:

```typescript
import type { EscalationSummary } from './escalation-summary-builder';
```

And export a typed payload helper near the existing SideEffect interface (around line 110):

```typescript
export interface EscalateWithContextPayload {
  escalationId: string;
  summary: EscalationSummary;
  dispatcher: { userId: string; phone: string };
  callSid: string;
  tenantId: string;
  channelPreferences: { sms: boolean; in_app: boolean; whisper: boolean };
}
```

- [ ] **Step 3: Add `frustration_detected` to `CallingAgentEvent`**

Find the `CallingAgentEvent` discriminated union (around lines 30-63). Append:

```typescript
| { type: 'frustration_detected'; source: 'keyword' | 'llm_sentiment'; detail?: string }
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/agents/customer-calling/types.ts
git commit -m "feat(fsm): add escalate_with_context SideEffect + frustration_detected event"
```

---

## Section 3 — F6a: `operator_request` Intent + Fast-Path

### Task 3.1: Add `operator_request` to intent classifier

**Files:**
- Modify: `packages/api/src/ai/orchestration/intent-classifier.ts`

- [ ] **Step 1: Add to the `IntentType` union**

Find the `IntentType` union (around lines 15-46) and add `| 'operator_request'` (alphabetical or grouped with `unknown` — match the existing style).

- [ ] **Step 2: Add to `SUPPORTED_INTENTS` array**

Find the `SUPPORTED_INTENTS` array (around lines 48-74) and add `'operator_request'` in the same position.

- [ ] **Step 3: Add the system prompt entry**

Find the system prompt block (around lines 320-330 where `emergency_dispatch` is documented). After the `emergency_dispatch` description, insert:

```
- "operator_request"   — caller explicitly asks to speak with a person,
                          dispatcher, owner, or asks to leave the AI agent.
                          Skip normal intent confirmation — escalate
                          directly to on-call dispatcher.
                          Examples: "Let me talk to a human"
                                    "I want a real person"
                                    "Is anyone there"
                                    "Transfer me to dispatch"
                                    "I don't want to talk to a bot"
                                    "Can I speak with the owner"
```

- [ ] **Step 4: Run existing intent classifier tests to confirm no regression**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/orchestration
```

Expected: existing tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors (the union addition forces exhaustive `switch` consumers to be checked — fix any flagged sites by adding `case 'operator_request':` per the next task).

- [ ] **Step 6: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/orchestration/intent-classifier.ts
git commit -m "feat(intent): add operator_request intent for explicit human handoff"
```

---

### Task 3.2: Failing test for FSM `operator_request` fast-path

**Files:**
- Modify: `packages/api/test/ai/agents/customer-calling/transitions.test.ts`

- [ ] **Step 1: Append the test**

Add inside the existing top-level `describe`:

```typescript
describe('intent_capture operator_request fast-path', () => {
  it('transitions directly to escalating with reason operator_request', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'operator_request', entities: {}, confidence: 0.95 },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('operator_request');
    // Should NOT have entity_resolution or intent_confirm side effects.
    const sideEffectTypes = result.sideEffects.map((fx) => fx.type);
    expect(sideEffectTypes).not.toContain('create_proposal');
    expect(sideEffectTypes).toContain('tts_play');
    expect(sideEffectTypes).toContain('notify_oncall');
  });

  it('does not require confidence threshold for operator_request (treats any confidence as valid)', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'operator_request', entities: {}, confidence: 0.2 },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
  });
});
```

`baseContext` was already defined in the existing test file (see Task 4.6 of the prior Sound Human plan). If it doesn't exist, define it at the top of the new describe:

```typescript
const baseContext: CallingAgentContext = {
  sessionId: 'session-test',
  tenantId: 'tenant-test',
  channel: 'telephony',
  retryCount: 0,
  repromptCount: 0,
  startedAt: Date.now(),
};
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/transitions.test.ts -t "operator_request"
```

Expected: FAIL (FSM doesn't yet have an operator_request branch).

---

### Task 3.3: Implement FSM `operator_request` fast-path

**Files:**
- Modify: `packages/api/src/ai/agents/customer-calling/transitions.ts`

- [ ] **Step 1: Add the branch alongside the existing `emergency_dispatch` fast-path**

Find the `intent_capture` state's `if (event.type === 'intent_classified')` block (around lines 370-410). Just after the `emergency_dispatch` `if` branch, add a parallel branch for `operator_request`:

```typescript
// operator_request → fast-path directly to escalating (skip entity_resolution and intent_confirm)
if (event.intentType === 'operator_request') {
  const updatedContext: CallingAgentContext = {
    ...context,
    currentIntent: event.intentType,
    extractedEntities: event.entities,
    retryCount: 0,
    escalationReason: 'operator_request',
  };
  return {
    nextState: 'escalating',
    sideEffects: [
      auditLog(updatedContext, 'intent_capture', 'escalating', 'operator_request'),
      ttsPlay("Of course — let me connect you with a person right now."),
      notifyOncall(updatedContext, 'operator_request'),
    ],
    updatedContext,
  };
}
```

- [ ] **Step 2: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/transitions.test.ts -t "operator_request"
```

Expected: both new tests pass.

- [ ] **Step 3: Run the full transitions test file (no regressions)**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/transitions.test.ts
```

Expected: all pass.

- [ ] **Step 4: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/agents/customer-calling/transitions.ts packages/api/test/ai/agents/customer-calling/transitions.test.ts
git commit -m "feat(fsm): add operator_request fast-path to escalating state"
```

---

## Section 4 — F7: Telemetry Events

### Task 4.1: Add 6 new event variants to `events.ts`

**Files:**
- Modify: `packages/api/src/ai/voice-quality/events.ts`

- [ ] **Step 1: Append the new event interfaces + constructors**

Append at the bottom of `packages/api/src/ai/voice-quality/events.ts`:

```typescript
export interface EscalationStartedEvent {
  type: 'escalation_started';
  escalationId: string;
  reason: string;
  dispatcherUserId: string;
  ts: number;
}

export interface EscalationSummaryBuiltEvent {
  type: 'escalation_summary_built';
  escalationId: string;
  durationMs: number;
  ts: number;
}

export interface WhisperPlayedEvent {
  type: 'whisper_played';
  escalationId: string;
  dispatcherCallSid: string;
  ts: number;
}

export interface DispatcherAnsweredEvent {
  type: 'dispatcher_answered';
  escalationId: string;
  ts: number;
}

export interface DispatcherNoAnswerEvent {
  type: 'dispatcher_no_answer';
  escalationId: string;
  secondsRing: number;
  ts: number;
}

export interface EscalationOutcomeEvent {
  type: 'escalation_outcome';
  escalationId: string;
  outcome: 'resolved' | 'hung_up' | 'needs_callback';
  ts: number;
}

export const escalationStartedEvent = (opts: {
  escalationId: string;
  reason: string;
  dispatcherUserId: string;
  ts?: number;
}): EscalationStartedEvent => ({
  type: 'escalation_started',
  escalationId: opts.escalationId,
  reason: opts.reason,
  dispatcherUserId: opts.dispatcherUserId,
  ts: opts.ts ?? Date.now(),
});

export const escalationSummaryBuiltEvent = (opts: {
  escalationId: string;
  durationMs: number;
  ts?: number;
}): EscalationSummaryBuiltEvent => ({
  type: 'escalation_summary_built',
  escalationId: opts.escalationId,
  durationMs: opts.durationMs,
  ts: opts.ts ?? Date.now(),
});

export const whisperPlayedEvent = (opts: {
  escalationId: string;
  dispatcherCallSid: string;
  ts?: number;
}): WhisperPlayedEvent => ({
  type: 'whisper_played',
  escalationId: opts.escalationId,
  dispatcherCallSid: opts.dispatcherCallSid,
  ts: opts.ts ?? Date.now(),
});

export const dispatcherAnsweredEvent = (opts: {
  escalationId: string;
  ts?: number;
}): DispatcherAnsweredEvent => ({
  type: 'dispatcher_answered',
  escalationId: opts.escalationId,
  ts: opts.ts ?? Date.now(),
});

export const dispatcherNoAnswerEvent = (opts: {
  escalationId: string;
  secondsRing: number;
  ts?: number;
}): DispatcherNoAnswerEvent => ({
  type: 'dispatcher_no_answer',
  escalationId: opts.escalationId,
  secondsRing: opts.secondsRing,
  ts: opts.ts ?? Date.now(),
});

export const escalationOutcomeEvent = (opts: {
  escalationId: string;
  outcome: EscalationOutcomeEvent['outcome'];
  ts?: number;
}): EscalationOutcomeEvent => ({
  type: 'escalation_outcome',
  escalationId: opts.escalationId,
  outcome: opts.outcome,
  ts: opts.ts ?? Date.now(),
});
```

- [ ] **Step 2: Add new variants to the `VoiceSessionEvent` union**

Find the `VoiceSessionEvent` union (likely in `voice-session-store.ts` per the prior plan reference). Append:

```typescript
| EscalationStartedEvent
| EscalationSummaryBuiltEvent
| WhisperPlayedEvent
| DispatcherAnsweredEvent
| DispatcherNoAnswerEvent
| EscalationOutcomeEvent
```

(The union import line at the top of that file may need to add the new types from `events.ts`.)

- [ ] **Step 3: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/voice-quality/events.ts packages/api/src/ai/agents/customer-calling/voice-session-store.ts
git commit -m "feat(voice-quality): add 6 escalation telemetry events"
```

---

## Section 5 — F1 + F2 + F4 wiring: emit `escalate_with_context`

### Task 5.1: Failing test for `escalate-to-human` emitting `escalate_with_context`

**Files:**
- Modify: `packages/api/test/ai/skills/escalate-to-human.test.ts`

- [ ] **Step 1: Locate or create the test file**

```bash
ls /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api/test/ai/skills/escalate-to-human.test.ts 2>/dev/null || echo missing
```

If the file exists, append. If "missing", create it.

- [ ] **Step 2: Add the test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { escalateToHuman } from '../../../src/ai/skills/escalate-to-human';

describe('escalateToHuman — emits escalate_with_context', () => {
  it('returns an EscalationResult whose transfer includes a built summary', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [
        { id: 'rot-1', userId: 'user-disp-1', phone: '+15125550999', cursorIndex: 0 },
      ]),
    };
    const dispatcherPhoneResolver = vi.fn(async () => '+15125550999');
    const buildSummary = vi.fn(() => ({
      whisper: 'Incoming call from Sarah Chen.',
      sms: 'Test SMS body',
      panel: { header: {}, customer: {}, lastInteraction: null, intent: {}, reason: {}, transcriptSnapshot: [] },
    }));

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'operator_request',
      channel: 'telephony',
      callSid: 'CA-test',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver,
      buildSummary,
      shopName: "Joe's HVAC",
      callerContext: {
        caller: { name: 'Sarah Chen', phone: '+15125550142' },
        intent: { type: 'create_appointment', entities: {}, confidence: 0.4 },
        transcriptSnapshot: [],
      },
    });

    expect(result.escalated).toBe(true);
    expect(buildSummary).toHaveBeenCalledTimes(1);
    expect(result.transfer).toBeDefined();
    expect(result.transfer?.summary).toBeDefined();
    expect(result.transfer?.summary?.whisper).toContain('Sarah Chen');
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/skills/escalate-to-human.test.ts -t "escalate_with_context"
```

Expected: FAIL (the `buildSummary` and `summary` fields don't exist yet on the skill).

---

### Task 5.2: Extend `escalate-to-human.ts` to build summary

**Files:**
- Modify: `packages/api/src/ai/skills/escalate-to-human.ts`

- [ ] **Step 1: Extend `EscalateToHumanInput` and `TransferDescriptor`**

In `packages/api/src/ai/skills/escalate-to-human.ts`, locate `EscalateToHumanInput` (lines 96-142) and add fields:

```typescript
import type { EscalationSummary, EscalationContext } from '../agents/customer-calling/escalation-summary-builder';

export interface EscalateToHumanInput {
  // ... existing fields ...
  buildSummary?: (ctx: EscalationContext) => EscalationSummary;
  callerContext?: {
    caller: EscalationContext['caller'];
    customer?: EscalationContext['customer'];
    intent: EscalationContext['intent'];
    transcriptSnapshot: EscalationContext['transcriptSnapshot'];
  };
  shopName?: string;
}
```

Locate `TransferDescriptor` (lines 166-181) and extend:

```typescript
export interface TransferDescriptor {
  // ... existing fields ...
  summary?: EscalationSummary;
  escalationId?: string;
}
```

- [ ] **Step 2: Build the summary in the telephony branch**

In the main `escalateToHuman` body, after the rotation lookup succeeds and `dispatcherPhone` is resolved, build the summary if both `buildSummary` + `callerContext` are present:

```typescript
let summary: EscalationSummary | undefined;
let escalationId: string | undefined;
if (input.buildSummary && input.callerContext) {
  escalationId = `esc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ctx: EscalationContext = {
    shopName: input.shopName ?? 'Our shop',
    caller: input.callerContext.caller,
    customer: input.callerContext.customer,
    intent: input.callerContext.intent,
    reason: input.reason as EscalationContext['reason'],
    transcriptSnapshot: input.callerContext.transcriptSnapshot,
  };
  summary = input.buildSummary(ctx);
}
```

Then include in the returned `TransferDescriptor`:

```typescript
transfer: {
  // ... existing fields (dispatcherPhone, fallbackTwiml, rotationEntryId, dispatcherUserId, rotationIndex) ...
  summary,
  escalationId,
}
```

- [ ] **Step 3: Run the new test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/skills/escalate-to-human.test.ts -t "escalate_with_context"
```

Expected: PASS.

- [ ] **Step 4: Run full escalate-to-human tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/skills/escalate-to-human.test.ts
```

Expected: all pre-existing tests still pass.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/skills/escalate-to-human.ts packages/api/test/ai/skills/escalate-to-human.test.ts
git commit -m "feat(escalation): escalate-to-human builds summary + escalationId for transfer descriptor"
```

---

## Section 6 — F3: Twilio Whisper Webhook + `<Dial url=>`

### Task 6.1: WhisperCache (in-memory short-TTL)

**Files:**
- Create: `packages/api/src/telephony/whisper-cache.ts`
- Create: `packages/api/test/telephony/whisper-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/telephony/whisper-cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhisperCache } from '../../src/telephony/whisper-cache';

describe('WhisperCache', () => {
  let cache: WhisperCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new WhisperCache({ ttlMs: 5 * 60 * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves whisper text by escalationId', () => {
    cache.set('esc_abc', 'Incoming call from Sarah Chen.');
    expect(cache.get('esc_abc')).toBe('Incoming call from Sarah Chen.');
  });

  it('returns undefined for unknown id', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    cache.set('esc_abc', 'whisper');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(cache.get('esc_abc')).toBeUndefined();
  });

  it('does not expire entries before TTL', () => {
    cache.set('esc_abc', 'whisper');
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(cache.get('esc_abc')).toBe('whisper');
  });

  it('overwriting an entry resets its TTL', () => {
    cache.set('esc_abc', 'first');
    vi.advanceTimersByTime(4 * 60 * 1000);
    cache.set('esc_abc', 'second');
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(cache.get('esc_abc')).toBe('second');
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/whisper-cache.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the cache**

Create `packages/api/src/telephony/whisper-cache.ts`:

```typescript
/**
 * Short-TTL in-memory cache for Twilio whisper TwiML payloads.
 *
 * Twilio fetches the whisper webhook within seconds of dialing the
 * dispatcher. We keep entries alive for 5 minutes by default so a slow
 * carrier doesn't 404 us, and reap them on access or on expiry.
 *
 * NOTE: This is process-local. In a multi-instance deployment, sticky
 * sessions on the Twilio-facing routes are required, OR replace with a
 * Redis-backed implementation that conforms to the same interface.
 */

interface CacheEntry {
  text: string;
  expiresAt: number;
}

export interface WhisperCacheOptions {
  ttlMs?: number;
}

export class WhisperCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: WhisperCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  }

  set(escalationId: string, text: string): void {
    this.entries.set(escalationId, { text, expiresAt: Date.now() + this.ttlMs });
  }

  get(escalationId: string): string | undefined {
    const entry = this.entries.get(escalationId);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(escalationId);
      return undefined;
    }
    return entry.text;
  }

  size(): number {
    return this.entries.size;
  }
}
```

- [ ] **Step 4: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/whisper-cache.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/telephony/whisper-cache.ts packages/api/test/telephony/whisper-cache.test.ts
git commit -m "feat(telephony): add WhisperCache for short-TTL whisper TwiML payloads"
```

---

### Task 6.2: Whisper route handler

**Files:**
- Create: `packages/api/src/telephony/whisper-route.ts`
- Create: `packages/api/test/telephony/whisper-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/telephony/whisper-route.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { whisperRouter } from '../../src/telephony/whisper-route';
import { WhisperCache } from '../../src/telephony/whisper-cache';

describe('GET /api/telephony/whisper/:escalationId', () => {
  it('returns TwiML <Say> with the cached whisper text', async () => {
    const cache = new WhisperCache();
    cache.set('esc_abc', 'Incoming call from Sarah Chen.');
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));

    const res = await request(app).get('/api/telephony/whisper/esc_abc');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Say>');
    expect(res.text).toContain('Incoming call from Sarah Chen.');
  });

  it('returns 200 with empty <Response> when escalationId is unknown (caller still connects)', async () => {
    const cache = new WhisperCache();
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    const res = await request(app).get('/api/telephony/whisper/nonexistent');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
  });

  it('escapes XML in the whisper text', async () => {
    const cache = new WhisperCache();
    cache.set('esc_xml', 'Caller said: <urgent> & "rush"');
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    const res = await request(app).get('/api/telephony/whisper/esc_xml');
    expect(res.text).not.toContain('<urgent>');
    expect(res.text).toContain('&lt;urgent&gt;');
    expect(res.text).toContain('&amp;');
    expect(res.text).toContain('&quot;');
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/whisper-route.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the route**

Create `packages/api/src/telephony/whisper-route.ts`:

```typescript
import { Router } from 'express';
import type { WhisperCache } from './whisper-cache';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface WhisperRouterDeps {
  whisperCache: WhisperCache;
  voice?: string;
}

/**
 * GET /api/telephony/whisper/:escalationId
 *
 * Twilio fetches this when the dispatcher answers — the returned TwiML
 * plays in the dispatcher's ear before the caller is connected. The
 * caller hears standard ring + hold during this window.
 *
 * If the escalationId is unknown (expired, never stored), return an
 * empty <Response/> so Twilio connects the caller anyway without
 * whisper. NEVER 404 — that would drop the call.
 */
export function whisperRouter(deps: WhisperRouterDeps): Router {
  const router = Router();
  const voice = deps.voice ?? 'Polly.Joanna';

  router.get('/whisper/:escalationId', (req, res) => {
    const text = deps.whisperCache.get(req.params.escalationId);
    res.set('Content-Type', 'text/xml; charset=utf-8');
    if (!text) {
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    res
      .status(200)
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}">${xmlEscape(
          text,
        )}</Say></Response>`,
      );
  });

  return router;
}
```

- [ ] **Step 4: Install supertest if not already a dev dep**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && grep -q '"supertest"' package.json && echo "already installed" || npm install --save-dev supertest @types/supertest
```

- [ ] **Step 5: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/whisper-route.test.ts
```

Expected: 3/3 pass.

- [ ] **Step 6: Typecheck + commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/telephony/whisper-route.ts packages/api/test/telephony/whisper-route.test.ts packages/api/package.json packages/api/package-lock.json
git commit -m "feat(telephony): add /whisper/:escalationId route for Twilio whisper TwiML"
```

---

### Task 6.3: Extend `dialDispatcher()` with `whisperUrl`

**Files:**
- Modify: `packages/api/src/telephony/twilio-call-control.ts`

- [ ] **Step 1: Write failing test**

Append to (or create) `packages/api/test/telephony/twilio-call-control.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TwilioCallControl } from '../../src/telephony/twilio-call-control';

describe('dialDispatcher with whisper', () => {
  const ctrl = new TwilioCallControl();

  it('omits url attribute when no whisperUrl is supplied (no regression)', () => {
    const twiml = ctrl.dialDispatcher('CA-1', '+15551234567', {
      actionUrl: 'https://example.com/action',
      timeoutSeconds: 20,
    });
    expect(twiml).toContain('<Number>+15551234567</Number>');
    expect(twiml).not.toContain('url="');
  });

  it('adds url attribute on <Number> when whisperUrl is supplied', () => {
    const twiml = ctrl.dialDispatcher('CA-1', '+15551234567', {
      actionUrl: 'https://example.com/action',
      whisperUrl: 'https://example.com/api/telephony/whisper/esc_abc',
      timeoutSeconds: 20,
    });
    expect(twiml).toContain(
      '<Number url="https://example.com/api/telephony/whisper/esc_abc">+15551234567</Number>',
    );
  });

  it('XML-escapes the whisperUrl', () => {
    const twiml = ctrl.dialDispatcher('CA-1', '+15551234567', {
      actionUrl: 'https://example.com/action',
      whisperUrl: 'https://example.com/whisper?id=a&b=c',
    });
    expect(twiml).toContain('url="https://example.com/whisper?id=a&amp;b=c"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/twilio-call-control.test.ts
```

Expected: FAIL (whisperUrl not in DialDispatcherOptions).

- [ ] **Step 3: Extend `DialDispatcherOptions` + implementation**

In `packages/api/src/telephony/twilio-call-control.ts`, add `whisperUrl?: string` to `DialDispatcherOptions`. Modify the `dialDispatcher` method body so that, when `opts.whisperUrl` is set, the `<Number>` element gets a `url=` attribute:

```typescript
dialDispatcher(
  callSid: string,
  dispatcherPhone: string,
  opts: DialDispatcherOptions,
): string {
  if (!callSid) throw new Error('dialDispatcher: callSid is required');
  if (!dispatcherPhone) throw new Error('dialDispatcher: dispatcherPhone is required');
  if (!opts.actionUrl) throw new Error('dialDispatcher: actionUrl is required');

  const timeout = opts.timeoutSeconds ?? 20;
  const callerIdAttr = opts.callerId ? ` callerId="${xmlEscape(opts.callerId)}"` : '';
  const whisperAttr = opts.whisperUrl ? ` url="${xmlEscape(opts.whisperUrl)}"` : '';

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial timeout="${timeout}" action="${xmlEscape(opts.actionUrl)}" method="POST"${callerIdAttr}>` +
    `<Number${whisperAttr}>${xmlEscape(dispatcherPhone)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}
```

- [ ] **Step 4: Run tests + typecheck + commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/twilio-call-control.test.ts
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/telephony/twilio-call-control.ts packages/api/test/telephony/twilio-call-control.test.ts
git commit -m "feat(telephony): dialDispatcher accepts whisperUrl for <Number url=>"
```

---

## Section 7 — Wire `escalate_with_context` Handler in `mediastream-adapter`

### Task 7.1: Handle `escalate_with_context` side effect

**Files:**
- Modify: `packages/api/src/telephony/twilio-adapter.ts`

- [ ] **Step 1: Locate `handleNotifyOncall`**

Search for `handleNotifyOncall` in `packages/api/src/telephony/twilio-adapter.ts`. This method currently consumes the `notify_oncall` side effect and produces `<Dial>` TwiML out-of-band.

- [ ] **Step 2: Add a sibling method `handleEscalateWithContext`**

Add a new method just below `handleNotifyOncall`:

```typescript
private async handleEscalateWithContext(
  payload: EscalateWithContextPayload,
): Promise<void> {
  const startMs = Date.now();
  const { escalationId, summary, dispatcher, callSid, tenantId, channelPreferences } = payload;

  // 1) Store whisper text in cache for Twilio's webhook fetch (no-op if disabled).
  if (channelPreferences.whisper && this.deps.whisperCache) {
    this.deps.whisperCache.set(escalationId, summary.whisper);
  }

  // 2) Send dispatcher SMS in parallel (no-op if disabled).
  let smsPromise: Promise<unknown> = Promise.resolve();
  if (channelPreferences.sms && this.deps.deliveryProvider) {
    const smsBody = summary.sms.replace('<escalationId>', escalationId);
    smsPromise = this.deps.deliveryProvider
      .sendSms({ to: dispatcher.phone, body: smsBody })
      .catch((err) => {
        logger.warn('escalate_with_context: SMS dispatch failed', {
          escalationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 3) Emit in-app SSE event (no-op if disabled or no session bus).
  if (channelPreferences.in_app && this.state.session) {
    this.state.session.events.emit(
      VOICE_EVENT_CHANNEL,
      escalationStartedEvent({
        escalationId,
        reason: summary.panel.reason.code,
        dispatcherUserId: dispatcher.userId,
      }),
    );
  }

  // 4) Build the actual <Dial> with whisper URL and stash for the route.
  const whisperUrl =
    channelPreferences.whisper && this.deps.publicBaseUrl
      ? `${this.deps.publicBaseUrl}/api/telephony/whisper/${escalationId}`
      : undefined;
  this.state.pendingTransferTwiml = this.deps.callControl.dialDispatcher(
    callSid,
    dispatcher.phone,
    {
      actionUrl: `${this.deps.publicBaseUrl}/api/telephony/dial-action`,
      whisperUrl,
      timeoutSeconds: 20,
    },
  );

  await smsPromise;

  // 5) Telemetry — summary built event.
  if (this.state.session) {
    this.state.session.events.emit(
      VOICE_EVENT_CHANNEL,
      escalationSummaryBuiltEvent({
        escalationId,
        durationMs: Date.now() - startMs,
      }),
    );
  }
}
```

Add imports near the top of the file:

```typescript
import type { EscalateWithContextPayload } from '../ai/agents/customer-calling/types';
import {
  escalationStartedEvent,
  escalationSummaryBuiltEvent,
} from '../ai/voice-quality/events';
import { VOICE_EVENT_CHANNEL } from '../ai/voice-quality/event-bus';
```

- [ ] **Step 3: Dispatch the new side effect**

Find the location where side effects are dispatched (likely the same place that calls `handleNotifyOncall`). Add a branch for `escalate_with_context`:

```typescript
} else if (fx.type === 'escalate_with_context') {
  void this.handleEscalateWithContext(fx.payload as EscalateWithContextPayload);
}
```

- [ ] **Step 4: Extend `MediaStreamAdapterDeps`**

Find `MediaStreamAdapterDeps` interface. Add:

```typescript
whisperCache?: WhisperCache;
deliveryProvider?: { sendSms(args: { to: string; body: string }): Promise<unknown> };
publicBaseUrl?: string;
```

(Import `WhisperCache` from `'../telephony/whisper-cache'`.)

- [ ] **Step 5: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors. (If `state.pendingTransferTwiml` doesn't exist yet on `RuntimeState`, add `pendingTransferTwiml: string | null` to the state type and initialize to `null` in the constructor.)

- [ ] **Step 6: Run existing tests for no regression**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts
```

Expected: all pre-existing pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/telephony/twilio-adapter.ts
git commit -m "feat(telephony): handle escalate_with_context side effect (SMS + in-app + whisper)"
```

---

### Task 7.2: Failing integration test for fan-out

**Files:**
- Modify: `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts` (or twilio-adapter.test.ts)

- [ ] **Step 1: Add test**

Append:

```typescript
describe('escalate_with_context fan-out', () => {
  it('writes whisper cache, calls SMS provider, emits in-app event in parallel', async () => {
    const whisperCache = new WhisperCache();
    const sendSms = vi.fn(async () => ({ success: true }));
    const deliveryProvider = { sendSms };

    const { adapter, session } = setupAdapter({
      whisperCache,
      deliveryProvider,
      publicBaseUrl: 'https://api.example.com',
    });

    const inAppEvents: unknown[] = [];
    session?.events.on(VOICE_EVENT_CHANNEL, (evt) => inAppEvents.push(evt));

    await (adapter as unknown as { handleEscalateWithContext: (p: EscalateWithContextPayload) => Promise<void> }).handleEscalateWithContext({
      escalationId: 'esc_xyz',
      summary: {
        whisper: 'Test whisper',
        sms: 'Test SMS <escalationId>',
        panel: { header: {}, customer: {}, lastInteraction: null, intent: {}, reason: { code: 'operator_request', humanReadable: 'asked for a person' }, transcriptSnapshot: [] } as never,
      },
      dispatcher: { userId: 'user-1', phone: '+15125550999' },
      callSid: 'CA-test',
      tenantId: 'tenant-1',
      channelPreferences: { sms: true, in_app: true, whisper: true },
    });

    expect(whisperCache.get('esc_xyz')).toBe('Test whisper');
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+15125550999', body: 'Test SMS esc_xyz' }),
    );
    expect(inAppEvents.some((e) => (e as { type?: string }).type === 'escalation_started')).toBe(true);
    expect(inAppEvents.some((e) => (e as { type?: string }).type === 'escalation_summary_built')).toBe(true);
  });

  it('respects channel preferences when one or more are disabled', async () => {
    const whisperCache = new WhisperCache();
    const sendSms = vi.fn(async () => ({ success: true }));
    const { adapter, session } = setupAdapter({
      whisperCache,
      deliveryProvider: { sendSms },
      publicBaseUrl: 'https://api.example.com',
    });
    const inAppEvents: unknown[] = [];
    session?.events.on(VOICE_EVENT_CHANNEL, (evt) => inAppEvents.push(evt));

    await (adapter as unknown as { handleEscalateWithContext: (p: EscalateWithContextPayload) => Promise<void> }).handleEscalateWithContext({
      escalationId: 'esc_no_sms',
      summary: { whisper: 'w', sms: 's', panel: { reason: { code: 'operator_request' } } as never },
      dispatcher: { userId: 'u', phone: '+15125550999' },
      callSid: 'CA',
      tenantId: 't',
      channelPreferences: { sms: false, in_app: true, whisper: true },
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(whisperCache.get('esc_no_sms')).toBe('w');
    expect(inAppEvents.some((e) => (e as { type?: string }).type === 'escalation_started')).toBe(true);
  });
});
```

Add imports at the top of the test file as needed (`WhisperCache`, `EscalateWithContextPayload`, `VOICE_EVENT_CHANNEL`).

- [ ] **Step 2: Adjust `setupAdapter` helper if needed**

If `setupAdapter` doesn't already accept these deps, extend it. Pattern: pass-through to `MediaStreamAdapterDeps`.

- [ ] **Step 3: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts -t "escalate_with_context fan-out"
```

Expected: both new tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/test/telephony/media-streams/mediastream-adapter.test.ts
git commit -m "test(telephony): cover escalate_with_context fan-out (SMS + in-app + whisper)"
```

---

## Section 8 — F6b: Keyword Frustration Detector

### Task 8.1: Failing test for `detectFrustration`

**Files:**
- Create: `packages/api/test/ai/agents/customer-calling/frustration-detector.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { detectFrustration } from '../../../../src/ai/agents/customer-calling/frustration-detector';

describe('detectFrustration', () => {
  it('returns matched=true on explicit keyword', () => {
    expect(detectFrustration('this is ridiculous').matched).toBe(true);
    expect(detectFrustration('THIS IS RIDICULOUS').matched).toBe(true); // case-insensitive
    expect(detectFrustration("I'll just hang up").matched).toBe(true);
  });

  it('returns the matched keyword in the result', () => {
    const r = detectFrustration('forget it, just connect me');
    expect(r.matched).toBe(true);
    expect(r.keyword).toBe('forget it');
  });

  it('respects word boundaries — "forget the AC" does NOT match "forget it"', () => {
    expect(detectFrustration('please forget the AC for now').matched).toBe(false);
  });

  it('returns matched=false on neutral text', () => {
    expect(detectFrustration('Yes, my address is 123 Main Street').matched).toBe(false);
    expect(detectFrustration('I need an appointment for Thursday').matched).toBe(false);
  });

  it('matches multi-word phrases anywhere in the transcript', () => {
    expect(detectFrustration('You know what, real person please').matched).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/frustration-detector.test.ts
```

Expected: FAIL (module not found).

---

### Task 8.2: Implement `detectFrustration`

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/frustration-detector.ts`

- [ ] **Step 1: Implement**

```typescript
/**
 * Synchronous, free keyword-based frustration detector.
 *
 * Runs on every Deepgram final transcript BEFORE intent classification.
 * Matches a curated list of frustration-indicating phrases with word-
 * boundary regex (case-insensitive). Deliberately conservative — false
 * positives pull a dispatcher away from another call.
 *
 * Returns the FIRST matched keyword for telemetry, even if multiple
 * patterns hit. Add to the list only based on call-data evidence after
 * launch.
 */

export const FRUSTRATION_KEYWORDS: ReadonlyArray<string> = [
  // Explicit / declarative frustration
  'this is ridiculous',
  'this is stupid',
  'forget it',
  'never mind',
  // Demand for human
  'i want a human',
  'real person',
  'speak to a person',
  // Generic frustration markers
  "i'm frustrated",
  "this isn't working",
  'are you kidding',
  // Hang-up threats
  "i'll just hang up",
  'this is wasting my time',
];

const KEYWORD_REGEXES = FRUSTRATION_KEYWORDS.map((kw) => {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { keyword: kw, regex: new RegExp(`\\b${escaped}\\b`, 'i') };
});

export interface FrustrationMatch {
  matched: boolean;
  keyword?: string;
}

export function detectFrustration(transcript: string): FrustrationMatch {
  for (const { keyword, regex } of KEYWORD_REGEXES) {
    if (regex.test(transcript)) {
      return { matched: true, keyword };
    }
  }
  return { matched: false };
}
```

- [ ] **Step 2: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/frustration-detector.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/agents/customer-calling/frustration-detector.ts packages/api/test/ai/agents/customer-calling/frustration-detector.test.ts
git commit -m "feat(escalation): add keyword frustration detector"
```

---

### Task 8.3: FSM `frustration_detected` handler + wire into `processCallerUtterance`

**Files:**
- Modify: `packages/api/src/ai/agents/customer-calling/transitions.ts`
- Modify: `packages/api/src/telephony/twilio-adapter.ts`

- [ ] **Step 1: Add FSM handler for `frustration_detected`**

In `transitions.ts`, in the top-level event dispatch (somewhere a global event guard runs before per-state handling), add a branch:

```typescript
// frustration_detected fires from the keyword detector OR async LLM
// sentiment classifier. Both route to the same escalation path.
if (event.type === 'frustration_detected') {
  // Idempotent: if already escalating/terminated, no-op.
  if (currentState === 'escalating' || currentState === 'terminated') {
    return { nextState: currentState, sideEffects: [], updatedContext: context };
  }
  const updatedContext: CallingAgentContext = {
    ...context,
    escalationReason:
      event.source === 'keyword' ? 'keyword_frustration' : 'llm_sentiment',
  };
  return {
    nextState: 'escalating',
    sideEffects: [
      auditLog(updatedContext, currentState, 'escalating', updatedContext.escalationReason),
      ttsPlay("I understand. Let me get a person on the line for you right away."),
      notifyOncall(updatedContext, updatedContext.escalationReason ?? 'frustration'),
    ],
    updatedContext,
  };
}
```

- [ ] **Step 2: Wire the detector into `processCallerUtterance`**

In `packages/api/src/telephony/twilio-adapter.ts`, modify `processCallerUtterance`:

```typescript
async processCallerUtterance(opts: {
  sessionId: string;
  callSid: string;
  speechResult: string;
  tenantId: string;
}): Promise<SideEffect[]> {
  const session = this.deps.store.get(opts.sessionId);
  if (!session) {
    logger.warn('processCallerUtterance: unknown session', { sessionId: opts.sessionId });
    return [
      { type: 'tts_play', payload: { text: "I'm sorry, your session has ended. Please call again." } },
      { type: 'end_session', payload: { reason: 'session_not_found' } },
    ];
  }

  // B3.2 — keyword frustration check BEFORE intent classification.
  // Fire-and-forget into the FSM; if matched, FSM produces escalation
  // side effects and we return them directly.
  const frustration = detectFrustration(opts.speechResult);
  if (frustration.matched) {
    return session.fsm.dispatch({
      type: 'frustration_detected',
      source: 'keyword',
      detail: frustration.keyword,
    });
  }

  return this.processor.speechTurn({
    session,
    speechResult: opts.speechResult,
    callSid: opts.callSid,
    tenantId: opts.tenantId,
  });
}
```

Add the import at top of file:

```typescript
import { detectFrustration } from '../ai/agents/customer-calling/frustration-detector';
```

- [ ] **Step 3: Test for the wiring (in twilio-adapter or processor test)**

Add a test asserting that "this is ridiculous" → FSM dispatched `frustration_detected` → escalation side effects emitted.

```typescript
// In packages/api/test/telephony/twilio-adapter.test.ts
it('processCallerUtterance escalates on frustration keyword without invoking intent classifier', async () => {
  const speechTurn = vi.fn();
  const fsmDispatch = vi.fn(() => [
    { type: 'tts_play', payload: { text: 'connecting you' } },
    { type: 'notify_oncall', payload: {} },
  ]);
  const session = { id: 's', fsm: { dispatch: fsmDispatch } };
  const store = { get: vi.fn(() => session) };
  const adapter = new TwilioGatherAdapter({ store, processor: { speechTurn } } as never);

  const sideEffects = await adapter.processCallerUtterance({
    sessionId: 's',
    callSid: 'CA',
    speechResult: 'this is ridiculous',
    tenantId: 't',
  });

  expect(speechTurn).not.toHaveBeenCalled();
  expect(fsmDispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'frustration_detected', source: 'keyword' }),
  );
  expect(sideEffects.length).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Run all affected tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/transitions.test.ts test/telephony/twilio-adapter.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/agents/customer-calling/transitions.ts packages/api/src/telephony/twilio-adapter.ts packages/api/test/telephony/twilio-adapter.test.ts
git commit -m "feat(escalation): wire keyword frustration detector into FSM dispatch"
```

---

## Section 9 — F8: Per-Tenant `escalationSettings` (Backend Only)

### Task 9.1: Add `EscalationSettings` to `TenantSettings`

**Files:**
- Modify: `packages/api/src/settings/settings.ts`

- [ ] **Step 1: Extend the types**

In `packages/api/src/settings/settings.ts`:

```typescript
export interface EscalationSettings {
  channel_sms: boolean;
  channel_in_app: boolean;
  channel_whisper: boolean;
  trigger_low_confidence: boolean;
  trigger_explicit_request: boolean;
  trigger_keyword_frustration: boolean;
  trigger_llm_sentiment: boolean;
  llm_sentiment_threshold: number;
}

export const DEFAULT_ESCALATION_SETTINGS: EscalationSettings = {
  channel_sms: true,
  channel_in_app: true,
  channel_whisper: true,
  trigger_low_confidence: true,
  trigger_explicit_request: true,
  trigger_keyword_frustration: true,
  trigger_llm_sentiment: false,
  llm_sentiment_threshold: 0.7,
};
```

Add `escalationSettings?: EscalationSettings` to `TenantSettings`. Add the same to `UpdateSettingsInput`. Provide the default value when reading via a helper:

```typescript
export function resolveEscalationSettings(
  settings: TenantSettings | null,
): EscalationSettings {
  return { ...DEFAULT_ESCALATION_SETTINGS, ...(settings?.escalationSettings ?? {}) };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/settings/settings.ts
git commit -m "feat(settings): add escalationSettings + DEFAULT_ESCALATION_SETTINGS + resolveEscalationSettings"
```

---

### Task 9.2: Resolve settings inside `escalate-to-human`

**Files:**
- Modify: `packages/api/src/ai/skills/escalate-to-human.ts`

- [ ] **Step 1: Thread channel prefs into the TransferDescriptor**

Extend `EscalateToHumanInput`:

```typescript
channelPreferences?: { sms: boolean; in_app: boolean; whisper: boolean };
```

In the body, if not passed, default to all true (matches current single-channel behavior gracefully).

Pass into the `TransferDescriptor`:

```typescript
transfer: {
  // ... existing ...
  summary,
  escalationId,
  channelPreferences: input.channelPreferences ?? { sms: true, in_app: true, whisper: true },
}
```

- [ ] **Step 2: Wire `resolveEscalationSettings` at the call site**

Find the call site of `escalateToHuman` (likely in `processCallerUtterance` or a skill invocation in `twilio-adapter.ts`). Before invoking, load settings:

```typescript
const settings = await this.deps.settingsRepo.findByTenant(tenantId);
const escSettings = resolveEscalationSettings(settings);

const result = await escalateToHuman({
  // ... existing ...
  channelPreferences: {
    sms: escSettings.channel_sms,
    in_app: escSettings.channel_in_app,
    whisper: escSettings.channel_whisper,
  },
  // ...
});
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/skills/escalate-to-human.ts packages/api/src/telephony/twilio-adapter.ts
git commit -m "feat(escalation): resolve per-tenant channelPreferences from settings"
```

---

## Section 10 — F6c: LLM Sentiment Classifier (Async, Opt-In)

### Task 10.1: Failing test for `classifyTurnSentiment`

**Files:**
- Create: `packages/api/test/ai/agents/customer-calling/sentiment-classifier.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { classifyTurnSentiment } from '../../../../src/ai/agents/customer-calling/sentiment-classifier';

describe('classifyTurnSentiment', () => {
  it('returns frustrationScore from the LLM response', async () => {
    const llm = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({ frustrationScore: 0.85, reasonHint: 'angry tone' }),
      })),
    };
    const result = await classifyTurnSentiment(
      { transcript: 'this is so frustrating', priorTurns: [], intent: 'unknown' },
      { llm: llm as never },
    );
    expect(result.frustrationScore).toBeCloseTo(0.85);
    expect(result.reasonHint).toBe('angry tone');
  });

  it('returns frustrationScore=0 when LLM response is malformed', async () => {
    const llm = { complete: vi.fn(async () => ({ text: 'not json' })) };
    const result = await classifyTurnSentiment(
      { transcript: 'hi', priorTurns: [], intent: 'unknown' },
      { llm: llm as never },
    );
    expect(result.frustrationScore).toBe(0);
  });

  it('returns frustrationScore=0 when LLM call throws', async () => {
    const llm = { complete: vi.fn(async () => { throw new Error('rate limit'); }) };
    const result = await classifyTurnSentiment(
      { transcript: 'hi', priorTurns: [], intent: 'unknown' },
      { llm: llm as never },
    );
    expect(result.frustrationScore).toBe(0);
  });

  it('respects cost cap — returns early without calling LLM when budget exceeded', async () => {
    const llm = { complete: vi.fn() };
    const tracker = { totals: { costCents: 30 } };
    const result = await classifyTurnSentiment(
      { transcript: 'hi', priorTurns: [], intent: 'unknown' },
      {
        llm: llm as never,
        costTracker: tracker as never,
        sessionCostCapCents: 40,
        maxSentimentBudgetRatio: 0.25,
      },
    );
    expect(llm.complete).not.toHaveBeenCalled();
    expect(result.frustrationScore).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/sentiment-classifier.test.ts
```

Expected: FAIL (module not found).

---

### Task 10.2: Implement `classifyTurnSentiment`

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/sentiment-classifier.ts`

- [ ] **Step 1: Implement**

```typescript
/**
 * Per-turn LLM sentiment classifier. Async fire-and-forget — called
 * AFTER the FSM dispatch so it never blocks the audio path. If the
 * returned frustrationScore ≥ threshold, the caller is expected to
 * dispatch a `frustration_detected` event back into the FSM out-of-
 * band; the FSM treats it identically to the keyword path.
 *
 * Cost cap: if the cumulative session cost has already consumed
 * `maxSentimentBudgetRatio` of `sessionCostCapCents`, skip the LLM
 * call (returns score=0) to protect tenant budgets.
 */

export interface SentimentInput {
  transcript: string;
  priorTurns: ReadonlyArray<{ role: 'caller' | 'ai'; text: string }>;
  intent: string;
}

export interface SentimentDeps {
  llm: { complete(args: { prompt: string }): Promise<{ text: string }> };
  costTracker?: { totals: { costCents: number } };
  sessionCostCapCents?: number;
  maxSentimentBudgetRatio?: number;
}

export interface SentimentResult {
  frustrationScore: number;
  reasonHint?: string;
}

const SYSTEM_PROMPT = `You are a sentiment classifier for an AI calling agent.
Given the caller's latest utterance and a few prior turns, return a JSON object:
{
  "frustrationScore": <number 0..1>,
  "reasonHint": <short string or null>
}
0 = perfectly neutral or positive. 1 = explicitly furious / about to hang up.
Calibrate around 0.5 = mildly impatient.
Respond ONLY with valid JSON, no prose.`;

export async function classifyTurnSentiment(
  input: SentimentInput,
  deps: SentimentDeps,
): Promise<SentimentResult> {
  // Cost cap guard.
  if (
    deps.costTracker &&
    deps.sessionCostCapCents != null &&
    deps.maxSentimentBudgetRatio != null
  ) {
    const ratio = deps.costTracker.totals.costCents / deps.sessionCostCapCents;
    if (ratio >= deps.maxSentimentBudgetRatio) {
      return { frustrationScore: 0 };
    }
  }

  const priorSummary = input.priorTurns
    .slice(-4)
    .map((t) => `${t.role}: ${t.text}`)
    .join('\n');
  const prompt = `${SYSTEM_PROMPT}\n\nIntent: ${input.intent}\n\nPrior turns:\n${priorSummary}\n\nLatest caller utterance:\n${input.transcript}\n\nJSON:`;

  let raw: string;
  try {
    const res = await deps.llm.complete({ prompt });
    raw = res.text;
  } catch {
    return { frustrationScore: 0 };
  }

  try {
    const parsed = JSON.parse(raw.trim()) as { frustrationScore?: number; reasonHint?: string | null };
    const score = typeof parsed.frustrationScore === 'number' ? parsed.frustrationScore : 0;
    const clamped = Math.max(0, Math.min(1, score));
    return {
      frustrationScore: clamped,
      reasonHint: typeof parsed.reasonHint === 'string' ? parsed.reasonHint : undefined,
    };
  } catch {
    return { frustrationScore: 0 };
  }
}
```

- [ ] **Step 2: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai/agents/customer-calling/sentiment-classifier.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/ai/agents/customer-calling/sentiment-classifier.ts packages/api/test/ai/agents/customer-calling/sentiment-classifier.test.ts
git commit -m "feat(escalation): add async LLM sentiment classifier with cost-cap guard"
```

---

### Task 10.3: Wire sentiment classifier into `processCallerUtterance` (async dispatch)

**Files:**
- Modify: `packages/api/src/telephony/twilio-adapter.ts`

- [ ] **Step 1: Add an async hook AFTER speechTurn returns**

In `processCallerUtterance`, after the existing dispatch path (when frustration didn't match), add a fire-and-forget call:

```typescript
const sideEffects = await this.processor.speechTurn({
  session,
  speechResult: opts.speechResult,
  callSid: opts.callSid,
  tenantId: opts.tenantId,
});

// B3.3 — async LLM sentiment classifier. Gated by per-tenant settings.
if (this.deps.sentimentClassifier && this.deps.escalationSettings?.trigger_llm_sentiment) {
  void this.runSentimentCheckAndMaybeEscalate(session, opts.speechResult, sideEffects).catch(
    (err) =>
      logger.warn('sentiment check failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
  );
}

return sideEffects;
```

Add the helper method:

```typescript
private async runSentimentCheckAndMaybeEscalate(
  session: VoiceSession,
  transcript: string,
  priorTurnEffects: SideEffect[],
): Promise<void> {
  const priorTurns = this.extractPriorTurns(session, 4);
  const intent =
    (priorTurnEffects.find((fx) => fx.type === 'audit_log')?.payload as { intent?: string } | undefined)
      ?.intent ?? 'unknown';
  const result = await this.deps.sentimentClassifier!({
    transcript,
    priorTurns,
    intent,
  });
  const threshold = this.deps.escalationSettings!.llm_sentiment_threshold;
  if (result.frustrationScore >= threshold) {
    const newEffects = session.fsm.dispatch({
      type: 'frustration_detected',
      source: 'llm_sentiment',
      detail: result.frustrationScore.toFixed(2),
    });
    await this.executeSideEffects(newEffects);
  }
}
```

(`extractPriorTurns` is a small helper that pulls the last N transcript turns from session state; if your session doesn't already track them, store them on session in a small ring buffer when transcripts arrive.)

- [ ] **Step 2: Extend `MediaStreamAdapterDeps`**

```typescript
sentimentClassifier?: (input: SentimentInput) => Promise<SentimentResult>;
escalationSettings?: EscalationSettings;
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/telephony/twilio-adapter.ts
git commit -m "feat(escalation): wire async LLM sentiment classifier with FSM out-of-band dispatch"
```

---

## Section 11 — F5: In-App Escalation Panel (Web Frontend)

### Task 11.1: `useEscalationStream` SSE hook

**Files:**
- Create: `packages/web/src/hooks/useEscalationStream.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';

export interface EscalationEvent {
  type: 'escalation_started';
  escalationId: string;
  reason: string;
  dispatcherUserId: string;
  ts: number;
  panel?: unknown;
}

export interface UseEscalationStream {
  activeEscalations: EscalationEvent[];
  dismissEscalation: (escalationId: string) => void;
}

/**
 * Subscribes to the user's escalation event stream via SSE.
 * Mirrors useVoiceSession SSE pattern. Maintains a queue of active
 * escalations so concurrent transfers to the same dispatcher render
 * stacked panels.
 */
export function useEscalationStream(): UseEscalationStream {
  const { getToken } = useAuth();
  const [activeEscalations, setActiveEscalations] = useState<EscalationEvent[]>([]);
  const sseAbortRef = useRef<AbortController | null>(null);

  const dismissEscalation = useCallback((escalationId: string) => {
    setActiveEscalations((prev) => prev.filter((e) => e.escalationId !== escalationId));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const subscribe = async () => {
      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      const token = await getToken();
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (token) headers.Authorization = `Bearer ${token}`;

      let response: Response;
      try {
        response = await fetch('/api/escalations/events', {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch {
        return;
      }

      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const eventBlock = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of eventBlock.split('\n')) {
              if (line.startsWith('data:')) {
                try {
                  const evt = JSON.parse(line.slice(5).trim()) as EscalationEvent;
                  if (evt.type === 'escalation_started') {
                    setActiveEscalations((prev) => [...prev, evt]);
                  }
                } catch {
                  // ignore malformed
                }
              }
            }
          }
        }
      } catch {
        // aborted or stream broken
      }
    };

    void subscribe();
    return () => {
      cancelled = true;
      sseAbortRef.current?.abort();
    };
  }, [getToken]);

  return { activeEscalations, dismissEscalation };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/web && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/web/src/hooks/useEscalationStream.ts
git commit -m "feat(web): add useEscalationStream SSE hook for in-app escalation events"
```

---

### Task 11.2: `EscalationPanel` + `EscalationPanelHost`

**Files:**
- Create: `packages/web/src/components/dispatch/EscalationPanel.tsx`
- Create: `packages/web/src/components/dispatch/EscalationPanelHost.tsx`

- [ ] **Step 1: Implement `EscalationPanel`**

Create `packages/web/src/components/dispatch/EscalationPanel.tsx`:

```typescript
import type { EscalationEvent } from '../../hooks/useEscalationStream';

interface EscalationPanelProps {
  event: EscalationEvent;
  onDismiss: () => void;
  onOutcome: (outcome: 'resolved' | 'hung_up' | 'needs_callback') => void;
}

export function EscalationPanel({ event, onDismiss, onOutcome }: EscalationPanelProps) {
  // event.panel is provided by backend serialization; default to safe empties.
  const panel = (event.panel ?? {}) as {
    header?: { title: string; callerName: string; callerPhone: string };
    customer?: { name: string; phone: string; tags?: string[] };
    lastInteraction?: string | null;
    intent?: { summary: string; entities?: Array<{ key: string; value: string }> };
    reason?: { code: string; humanReadable: string };
    transcriptSnapshot?: Array<{ role: 'caller' | 'ai'; text: string; ts: number }>;
  };

  return (
    <div
      role="dialog"
      aria-label="Incoming call transfer"
      className="fixed top-4 right-4 z-50 w-96 rounded-lg border border-amber-300 bg-white shadow-2xl"
    >
      <div className="bg-amber-50 px-4 py-3 border-b border-amber-200 rounded-t-lg">
        <div className="font-semibold text-amber-900">📞 {panel.header?.title ?? 'Incoming transfer'}</div>
        <div className="text-sm text-amber-700">
          {panel.header?.callerName} · {panel.header?.callerPhone}
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        {panel.customer?.tags && panel.customer.tags.length > 0 && (
          <div className="flex gap-1">
            {panel.customer.tags.map((tag) => (
              <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                {tag}
              </span>
            ))}
          </div>
        )}

        {panel.lastInteraction && (
          <div className="text-sm text-gray-600">{panel.lastInteraction}</div>
        )}

        {panel.intent && (
          <div>
            <div className="text-sm font-medium">{panel.intent.summary}</div>
            {panel.intent.entities && panel.intent.entities.length > 0 && (
              <ul className="text-xs text-gray-500 mt-1">
                {panel.intent.entities.map((e) => (
                  <li key={e.key}>
                    {e.key}: {e.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {panel.reason && (
          <div className="text-xs text-amber-700">Reason: {panel.reason.humanReadable}</div>
        )}

        {panel.transcriptSnapshot && panel.transcriptSnapshot.length > 0 && (
          <div className="bg-gray-50 rounded p-2 max-h-40 overflow-y-auto text-xs space-y-1">
            {panel.transcriptSnapshot.map((t, i) => (
              <div key={i} className={t.role === 'caller' ? 'text-gray-800' : 'text-blue-700'}>
                <span className="font-medium">{t.role === 'caller' ? 'Caller' : 'AI'}:</span> {t.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 px-4 py-3 flex gap-2 justify-end">
        <button
          onClick={() => onOutcome('hung_up')}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
        >
          Hung up
        </button>
        <button
          onClick={() => onOutcome('needs_callback')}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
        >
          Needs callback
        </button>
        <button
          onClick={() => onOutcome('resolved')}
          className="text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700"
        >
          Resolved
        </button>
        <button
          onClick={onDismiss}
          className="text-xs px-2 py-1.5 text-gray-400 hover:text-gray-600"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `EscalationPanelHost`**

Create `packages/web/src/components/dispatch/EscalationPanelHost.tsx`:

```typescript
import { useEscalationStream } from '../../hooks/useEscalationStream';
import { EscalationPanel } from './EscalationPanel';

export function EscalationPanelHost() {
  const { activeEscalations, dismissEscalation } = useEscalationStream();

  const handleOutcome = async (
    escalationId: string,
    outcome: 'resolved' | 'hung_up' | 'needs_callback',
  ) => {
    try {
      await fetch(`/api/escalations/${escalationId}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
    } catch {
      // best-effort; user can re-try
    }
    dismissEscalation(escalationId);
  };

  return (
    <>
      {activeEscalations.map((evt, idx) => (
        <div
          key={evt.escalationId}
          style={{ top: `${1 + idx * 28}rem` }}
          className="fixed right-4 z-50"
        >
          <EscalationPanel
            event={evt}
            onDismiss={() => dismissEscalation(evt.escalationId)}
            onOutcome={(outcome) => handleOutcome(evt.escalationId, outcome)}
          />
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 3: Mount at root**

In `packages/web/src/app.tsx`, mount `<EscalationPanelHost />` near the top-level provider tree (after auth gating, since SSE requires auth):

```typescript
import { EscalationPanelHost } from './components/dispatch/EscalationPanelHost';

// inside the authenticated app render tree:
<>
  <EscalationPanelHost />
  {/* existing app content */}
</>
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/web && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/web/src/components/dispatch packages/web/src/app.tsx
git commit -m "feat(web): add EscalationPanel + EscalationPanelHost mounted at root"
```

---

### Task 11.3: Escalation outcome route + SSE event stream route

**Files:**
- Create: `packages/api/src/escalations/outcome-route.ts`
- Create: `packages/api/src/escalations/events-route.ts`

- [ ] **Step 1: Implement outcome route**

Create `packages/api/src/escalations/outcome-route.ts`:

```typescript
import { Router } from 'express';
import { z } from 'zod';
import { escalationOutcomeEvent } from '../ai/voice-quality/events';
import { VOICE_EVENT_CHANNEL } from '../ai/voice-quality/event-bus';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';

const OutcomeSchema = z.object({
  outcome: z.enum(['resolved', 'hung_up', 'needs_callback']),
});

export interface OutcomeRouteDeps {
  store: VoiceSessionStore;
}

export function escalationOutcomeRouter(deps: OutcomeRouteDeps): Router {
  const router = Router();
  router.post('/:escalationId/outcome', async (req, res) => {
    const parsed = OutcomeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_outcome' });
      return;
    }
    const escalationId = req.params.escalationId;
    // Find the session associated with this escalation. For now we
    // broadcast the event globally on the session bus; the call quality
    // scoring spec will persist it. If no session matches, still 200 —
    // outcome capture is best-effort.
    const session = deps.store.findByEscalationId?.(escalationId);
    if (session) {
      session.events.emit(
        VOICE_EVENT_CHANNEL,
        escalationOutcomeEvent({ escalationId, outcome: parsed.data.outcome }),
      );
    }
    res.status(200).json({ ok: true });
  });
  return router;
}
```

Note: `findByEscalationId` may not exist on `VoiceSessionStore` yet. If it doesn't, add a small lookup or accept that outcomes are recorded against the current session-bus only (acceptable — the call quality scoring spec will durably persist).

- [ ] **Step 2: Implement SSE events route**

Create `packages/api/src/escalations/events-route.ts`:

```typescript
import { Router } from 'express';
// Reuse the existing SSE-by-session pattern but per-user.
// Frontend hits /api/escalations/events; backend subscribes to all
// escalation_started events on the voice event bus FILTERED by the
// requesting user's userId (matched against dispatcherUserId in the event).

export interface EscalationEventsDeps {
  // Provide whatever auth helper extracts userId from req (Clerk middleware).
  authUserIdFromRequest: (req: import('express').Request) => Promise<string | null>;
  // Subscribe function over the global voice event bus.
  subscribeToVoiceEvents: (callback: (evt: { type: string; [key: string]: unknown }) => void) => () => void;
}

export function escalationEventsRouter(deps: EscalationEventsDeps): Router {
  const router = Router();
  router.get('/events', async (req, res) => {
    const userId = await deps.authUserIdFromRequest(req);
    if (!userId) {
      res.status(401).end();
      return;
    }
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.flushHeaders();

    const unsubscribe = deps.subscribeToVoiceEvents((evt) => {
      if (evt.type === 'escalation_started' && (evt as { dispatcherUserId?: string }).dispatcherUserId === userId) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
    });

    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  });
  return router;
}
```

`subscribeToVoiceEvents` and `authUserIdFromRequest` are dependency-injected to keep the route testable. The wiring in `app.ts` provides concrete implementations.

- [ ] **Step 3: Mount routes in app.ts**

In `packages/api/src/app.ts`, after the existing routes:

```typescript
import { escalationOutcomeRouter } from './escalations/outcome-route';
import { escalationEventsRouter } from './escalations/events-route';

app.use('/api/escalations', escalationOutcomeRouter({ store: voiceSessionStore }));
app.use('/api/escalations', escalationEventsRouter({
  authUserIdFromRequest: async (req) => {
    // existing Clerk middleware attaches user; adapt as needed
    return (req as unknown as { auth?: { userId?: string } }).auth?.userId ?? null;
  },
  subscribeToVoiceEvents: (cb) => globalVoiceEventBus.subscribe(cb),
}));
```

Mount the whisper router similarly:

```typescript
import { whisperRouter } from './telephony/whisper-route';
app.use('/api/telephony', whisperRouter({ whisperCache }));
```

- [ ] **Step 4: Typecheck + commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/api/src/escalations packages/api/src/app.ts
git commit -m "feat(escalation): mount outcome + SSE events + whisper routes in app.ts"
```

---

### Task 11.4: `CallRoutingSheet` settings UI

**Files:**
- Create: `packages/web/src/components/settings/CallRoutingSheet.tsx`
- Modify: `packages/web/src/components/settings/SettingsPage.tsx`

- [ ] **Step 1: Implement `CallRoutingSheet`**

Create `packages/web/src/components/settings/CallRoutingSheet.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { toast } from '../../lib/toast';

interface EscalationSettings {
  channel_sms: boolean;
  channel_in_app: boolean;
  channel_whisper: boolean;
  trigger_low_confidence: boolean;
  trigger_explicit_request: boolean;
  trigger_keyword_frustration: boolean;
  trigger_llm_sentiment: boolean;
  llm_sentiment_threshold: number;
}

const DEFAULTS: EscalationSettings = {
  channel_sms: true,
  channel_in_app: true,
  channel_whisper: true,
  trigger_low_confidence: true,
  trigger_explicit_request: true,
  trigger_keyword_frustration: true,
  trigger_llm_sentiment: false,
  llm_sentiment_threshold: 0.7,
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CallRoutingSheet({ open, onOpenChange }: Props) {
  const [settings, setSettings] = useState<EscalationSettings>(DEFAULTS);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          setSettings({ ...DEFAULTS, ...(data.escalationSettings ?? {}) });
        }
      } catch {
        // ignore — defaults
      }
    })();
  }, [open]);

  async function update(patch: Partial<EscalationSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalationSettings: next }),
      });
      if (!res.ok) throw new Error(`PUT /api/settings ${res.status}`);
    } catch {
      toast.error('Could not save preference');
      setSettings(settings);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="absolute right-0 top-0 h-full w-96 bg-white shadow-2xl p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Call Routing & Handoff</h2>

        <section className="mb-6">
          <h3 className="text-sm font-medium mb-2">Where dispatcher gets context</h3>
          {[
            ['channel_whisper', 'Whisper in dispatcher\'s ear when they answer'],
            ['channel_sms', 'SMS to dispatcher\'s phone'],
            ['channel_in_app', 'In-app overlay panel'],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 py-1.5">
              <input
                type="checkbox"
                checked={settings[key as keyof EscalationSettings] as boolean}
                onChange={(e) => update({ [key]: e.target.checked } as never)}
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </section>

        <section className="mb-6">
          <h3 className="text-sm font-medium mb-2">When AI hands off</h3>
          {[
            ['trigger_low_confidence', 'Sustained low confidence (baseline, always on)'],
            ['trigger_explicit_request', '"Talk to a human" / operator request'],
            ['trigger_keyword_frustration', 'Frustration keywords ("this is ridiculous", etc.)'],
            ['trigger_llm_sentiment', 'AI sentiment classifier (opt-in, adds per-turn cost)'],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 py-1.5">
              <input
                type="checkbox"
                checked={settings[key as keyof EscalationSettings] as boolean}
                disabled={key === 'trigger_low_confidence'}
                onChange={(e) => update({ [key]: e.target.checked } as never)}
              />
              <span className={`text-sm ${key === 'trigger_low_confidence' ? 'text-gray-400' : ''}`}>{label}</span>
            </label>
          ))}
        </section>

        {settings.trigger_llm_sentiment && (
          <section className="mb-6">
            <label className="block text-sm font-medium mb-1">Sentiment escalation threshold</label>
            <input
              type="range"
              min="0.4"
              max="0.9"
              step="0.05"
              value={settings.llm_sentiment_threshold}
              onChange={(e) => update({ llm_sentiment_threshold: parseFloat(e.target.value) })}
              className="w-full"
            />
            <div className="text-xs text-gray-500">
              Current: {settings.llm_sentiment_threshold.toFixed(2)} — higher = fewer escalations.
            </div>
          </section>
        )}

        <button onClick={() => onOpenChange(false)} className="w-full py-2 rounded bg-gray-100 hover:bg-gray-200 text-sm">
          Close
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the section button in `SettingsPage`**

Open `packages/web/src/components/settings/SettingsPage.tsx`. Find the existing section buttons. Add:

```typescript
import { CallRoutingSheet } from './CallRoutingSheet';

// In the component state:
const [showCallRouting, setShowCallRouting] = useState(false);

// In the JSX render:
<SectionButton onClick={() => setShowCallRouting(true)}>Call Routing & Handoff</SectionButton>
<CallRoutingSheet open={showCallRouting} onOpenChange={setShowCallRouting} />
```

If the codebase uses a different button component or wrapper (e.g., a different name), match the existing pattern.

- [ ] **Step 3: Verify settings save round-trips**

The backend `/api/settings` endpoint must accept `escalationSettings` in the PUT body. This was wired in Task 9.1's type extension; verify by smoke-testing in dev (or skip if covered by an existing settings endpoint test).

- [ ] **Step 4: Typecheck + commit**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/web && npx tsc --noEmit
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git add packages/web/src/components/settings
git commit -m "feat(web): add Call Routing & Handoff settings sheet"
```

---

## Section 12 — Integration & PR Prep

### Task 12.1: Full suite verification

**Files:** none

- [ ] **Step 1: Production typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx tsc --project tsconfig.build.json --noEmit
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/web && npx tsc --noEmit
```

Expected: zero errors in both.

- [ ] **Step 2: Run all relevant test suites**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff/packages/api && npx vitest run test/ai test/telephony test/settings test/escalations 2>&1 | tail -20
```

Expected: all pass (any pre-existing failures from date-sensitive tests can be ignored — confirm they fail on the base commit too).

- [ ] **Step 3: Note any pre-existing failures**

If failures show up that are unrelated to this branch, confirm by:

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff
git stash && git checkout main && cd packages/api && npx vitest run test/<failing-file> ; cd ../.. ; git checkout feat/seamless-handoff && git stash pop
```

If pre-existing → log them, don't block.

### Task 12.2 GATE — Stop for user approval before push/PR

**Files:** none

- [ ] **Step 1: Verify branch state**

```bash
cd /Users/macmini/Serviceos/Serviceos/.claude/worktrees/feat-seamless-handoff && git log --oneline main..HEAD | wc -l && git status
```

- [ ] **Step 2: Halt and report**

Per the Sound Human workflow, stop here and ask for user approval before:

```bash
git push -u origin feat/seamless-handoff
gh pr create --title "feat(voice): Seamless Handoff — dispatcher context + escalation triggers" --body "..."
```

Do NOT execute push/PR autonomously. The user must explicitly approve.

---

## Self-Review

- [ ] All spec features (F1, F2, F3, F4, F5, F6a/b/c, F7, F8) have at least one task.
- [ ] Every code step includes the actual code (no "implement here" placeholders).
- [ ] Test code in test steps actually exercises the named behavior.
- [ ] Type signatures used in later tasks match those defined in earlier tasks (`EscalationSummary`, `EscalateWithContextPayload`, `EscalationSettings`, `SentimentInput`).
- [ ] Each task ends with typecheck OR test verification + commit.
- [ ] No task spans more than ~5 minutes of engineer time per step.
- [ ] PR creation is gated behind explicit user approval per Sound Human precedent.
