# Voice Tradesperson Intents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 13 missing tradesperson voice capabilities (9 action intents, 4 lookups) plus 3 small parity fixes to the ServiceOS voice→proposal pipeline, so an owner-operator can run comms, change orders, refunds/credits, materials, service agreements, price-book edits, mileage, and crew/timesheet visibility by voice.

**Architecture:** Every new action intent follows the existing four-leg contract: (1) classifier taxonomy entry (`IntentType` + `SUPPORTED_INTENTS` + a SYSTEM_PROMPT block with example utterances), (2) `INTENT_TO_PROPOSAL_TYPE` map entry + `ProposalType` + exhaustive `actionClassForProposalType` case + payload contract, (3) a drafting TaskHandler registered in the shared `handler-registry.ts` (so worker + assistant surfaces can't drift — B5 lesson), (4) an ExecutionHandler registered in `proposals/execution/handlers.ts` with `isFullyWired()` so the boot guard (`wiring-assertions.ts`) fails closed. Lookups follow the `voice-lookup-answer.ts` switch + `LOOKUP_REQUIRED_PERMISSION` pattern. Nothing auto-executes: money/comms classes never auto-approve (D3), everything else is capture-class human-approved.

**Tech Stack:** TypeScript, vitest, raw-SQL migrations in `packages/api/src/db/schema.ts` (`MIGRATIONS` object — NOT drizzle, NOT a migrations dir), Postgres RLS per-tenant, OpenRouter LLM gateway.

**Scope decisions (locked):**
- `schedule_inspection`, `log_permit`, `log_warranty_claim` are **alias intents** onto existing proposal types (`create_appointment`, `add_note`, `create_job`) — classifier + map entries only, no new handlers. Handler dispatch is keyed by proposal type, so aliases inherit drafting + execution for free.
- `log_mileage` drafts a `log_expense` proposal (category `vehicle`) at a flat default rate — no new proposal type.
- `apply_credit` mirrors `apply_late_fee` with a negative, floor-guarded line — money-class.
- `record_refund` records a **manual** refund (cash/check/external) against the existing `payment_refunds` table (migration 264 already exists). Stripe-automated refunds are OUT OF SCOPE (YAGNI; note in handler doc).
- `update_catalog_item` proposal type + execution handler **already exist** (WS20) — we only add the voice intent + drafting leg. `add_catalog_item` is fully new.
- `en_route` parity on live-call/in-app surfaces is OUT OF SCOPE (requires FSM changes in two adapters; separate plan). The three cheap parity fixes (silent-skip clarifications, `callback` handler guard, assistant-chat wiring for six dropped intents) are Phase 8.
- Voice approval/edit surface policy is NOT touched (RV-071 security posture).
- Alias intents carry no summary-prefix guarantees; distinctive wording must live in fields the target handler actually reads (spec-review finding, 2026-08-07).

**Phases (each independently shippable, in order):**
1. Alias intents + `update_catalog_item` intent (pure wiring — ships in an hour)
2. Money completion: `record_refund`, `apply_credit`
3. Comms: `send_customer_message`
4. Revenue engine: `create_change_order`, `create_service_agreement`
5. Materials: `add_material` + `lookup_materials` (new table)
6. People lookups: `lookup_crew_schedule`, `lookup_timesheets`, `lookup_my_day`
7. `log_mileage` + `add_catalog_item`
8. Parity fixes (silent-skip, callback guard, assistant wiring)

**Working conventions for every task:**
- Repo root: `/Users/joshuakay/Serviceos`. All paths below are relative to `packages/api/` unless prefixed.
- Test command: `cd packages/api && npx vitest run <file> -t "<name>"`; full suite `npm test`; lint `npm run lint`; migration-key check `npm run check:migration-keys`.
- Branch: create `feat/voice-tradesperson-intents` off `main` first (`git checkout -b feat/voice-tradesperson-intents`). Commit after every task's final step.
- **The compiler is your safety net:** adding a `ProposalType` without an `actionClassForProposalType` case is a compile error (exhaustive switch). Run `npm run build` whenever a task touches `proposal.ts`.

---

## Task 0: Pattern capture (read-only, 10 min — do this first, once)

Two seams of the four-leg contract are not quoted in this plan because they must be copied from the live exemplars, not re-invented. Capture them into your context before Task 1:

- [ ] **Step 1: Capture the payload-contract pattern**

Run: `grep -n "log_expense" packages/api/src/proposals/contracts.ts`
Read the surrounding block (the `log_expense` payload schema + how `validateProposalPayload` dispatches to it). Every task below that says "add payload contract" means: add an analogous block for the new proposal type with the exact field list given in that task, following this captured pattern (same validation helper style, same error-message tone).

- [ ] **Step 2: Capture the TaskHandler (drafting-leg) pattern**

Run: `grep -n "log_expense\|LogExpense" packages/api/src/ai/orchestration/handler-registry.ts packages/api/src/ai/orchestration/task-router.ts packages/api/src/ai/tasks/*.ts | head -20`
Open the file containing the `log_expense` TaskHandler class (the drafting layer that turns `{intent, entities, transcript}` into a validated proposal payload, with `missing.push(...)` gates for absent required fields). Every task below that says "add TaskHandler" means: a new class with this captured shape, whose extraction fields, gates, and system-prompt text are fully specified in that task.

- [ ] **Step 3: Capture the intent-catalog contract test**

Run: `grep -rn "SUPPORTED_INTENTS\|INTENT_TO_PROPOSAL_TYPE" packages/api/test --include="*.test.ts" -l | head -5`
Open the test that pins the taxonomy↔map↔handler alignment ("the catalog contract test pins all three legs" — see `voice-intent-map.ts:95-97` comment). New intents must be added to its expectations; each task's test step names what to assert.

- [ ] **Step 4: Note current migration head**

Run: `grep -n "'2[67][0-9]_" packages/api/src/db/schema.ts | tail -3`
Expected: last key is `'269_dispatch_entity_portal_session'`. This plan claims keys **270, 271, 272**. If other work has claimed them, take the next free numbers and update the task SQL keys accordingly, then re-run `npm run check:migration-keys`.

---

## Phase 1 — Alias intents + update_catalog_item intent

### Task 1: `schedule_inspection`, `log_permit`, `log_warranty_claim` alias intents

**Files:**
- Modify: `packages/api/src/ai/orchestration/intent-classifier.ts` (IntentType union ~L16-174, SUPPORTED_INTENTS ~L176-239, SYSTEM_PROMPT ~L622-1250)
- Modify: `packages/api/src/proposals/voice-intent-map.ts` (~L67-111)
- Modify: `packages/api/src/ai/agents/customer-calling/entity-resolution.ts` (~L75-115)
- Test: `packages/api/test/proposals/voice-tradesperson-intents.test.ts` (new file, grows across phases)

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/proposals/voice-tradesperson-intents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_INTENTS,
  type IntentType,
} from '../../src/ai/orchestration/intent-classifier';
import {
  INTENT_TO_PROPOSAL_TYPE,
  intentToProposalType,
} from '../../src/proposals/voice-intent-map';

describe('Phase 1 — alias intents', () => {
  const aliases: Array<[IntentType, string]> = [
    ['schedule_inspection', 'create_appointment'],
    ['log_permit', 'add_note'],
    ['log_warranty_claim', 'create_job'],
  ];

  it.each(aliases)('%s is a supported intent mapping to %s', (intent, proposalType) => {
    expect(SUPPORTED_INTENTS).toContain(intent);
    expect(INTENT_TO_PROPOSAL_TYPE[intent as Exclude<IntentType, 'unknown'>]).toBe(proposalType);
    expect(intentToProposalType(intent)).toBe(proposalType);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/voice-tradesperson-intents.test.ts`
Expected: FAIL — TS error `'schedule_inspection'` is not assignable to `IntentType` (or runtime "expected undefined to be 'create_appointment'").

- [ ] **Step 3: Add the three intents to the taxonomy**

In `intent-classifier.ts`, add to the `IntentType` union (after `| 'request_feedback'`):

```ts
  // Tradesperson wave 1 (2026-08-07 plan) — alias intents. Each rides an
  // EXISTING proposal type + handler; only classification + extraction differ.
  | 'schedule_inspection'
  | 'log_permit'
  | 'log_warranty_claim'
```

Add the same three strings to `SUPPORTED_INTENTS` (same relative position).

In the SYSTEM_PROMPT intent list (format exactly per the `log_expense` block at L880-889), add:

```ts
- "schedule_inspection"  — owner/technician books a permit/code inspection
                           visit on a job. Extract customerName and
                           dateTimeDescription exactly as create_appointment
                           does, plus jobReference when an existing job is
                           named (e.g. "the Patel job"). The inspection
                           itself belongs in jobTitle — create_appointment's
                           own "short name of the new work" field — prefixed
                           "Inspection — " plus the type (rough-in/final/
                           other), e.g. jobTitle: "Inspection — rough-in".
                           No separate inspectionType/requestedDate/
                           requestedTime fields exist.
                           Examples: "Schedule the rough-in inspection for Thursday"
                                     "Book the final inspection on the Patel job Friday morning"
- "log_permit"           — owner/technician records a permit number/status
                           against a job. Maps to an add_note whose noteBody
                           MUST begin "PERMIT: " followed by the permit number
                           and any status the speaker gave — put that full
                           "PERMIT: ..." text in noteBody. Extract jobReference.
                           No separate permitNumber field exists.
                           Examples: "Log permit 2024-1187 on the Patel job"
                                     "Note the electrical permit was approved for the Hendersons"
- "log_warranty_claim"   — a warranty callback on past work. Maps to
                           create_job. Put "Warranty — " plus the failure
                           description into jobTitle — create_job's own
                           title field (e.g. jobTitle: "Warranty — water
                           heater pilot won't stay lit"). Extract
                           customerName. No separate problemDescription
                           field exists.
                           Examples: "Log a warranty callback for the Hendersons' water heater"
                                     "The Garcia compressor we installed failed — warranty job"
```

**Spec-review correction (2026-08-07):** the block above replaces an earlier
draft that named fields which don't exist in `ExtractedEntities` / the
classifier's JSON-response allowlist (`customerReference`, `requestedDate`,
`requestedTime`, `inspectionType`, `permitNumber`, `problemDescription`) —
anything the LLM emitted under those keys would have been silently dropped.
`CreateAppointmentAITaskHandler` makes its own LLM call
(`APPOINTMENT_SYSTEM_PROMPT`) and unconditionally rewrites the summary as
`"<jobTitle> — <resolved time>"` (`buildResolvedSummary`,
`create-appointment-task.ts`); `CreateJobVoiceTaskHandler` copies `jobTitle`
straight into the job's `title`. Both aliases now ride real fields the
target handler already reads, so the distinctive wording (`"Inspection — "`,
`"Warranty — "`) survives with zero handler changes — see also the JSON
response schema (`~L1230-1275`), whose `noteBody`/`jobTitle` descriptions
were extended to mention `log_permit`/`schedule_inspection`/
`log_warranty_claim`.

- [ ] **Step 4: Map the aliases to their proposal types**

In `voice-intent-map.ts`, inside `INTENT_TO_PROPOSAL_TYPE` (after the `update_brand_voice` entry):

```ts
  // Tradesperson wave 1 — alias intents onto existing proposal types.
  // Drafting + execution handlers are keyed by PROPOSAL type, so these
  // inherit the create_appointment / add_note / create_job legs unchanged.
  schedule_inspection: 'create_appointment',
  log_permit: 'add_note',
  log_warranty_claim: 'create_job',
```

- [ ] **Step 5: Add entity-resolution membership**

In `packages/api/src/ai/agents/customer-calling/entity-resolution.ts`, add `'schedule_inspection'` and `'log_warranty_claim'` to the set that resolves `customerReference` (find it: `grep -n "CUSTOMER_REF_INTENTS\|customerReference" packages/api/src/ai/agents/customer-calling/entity-resolution.ts | head`), and add `'log_permit'` + `'schedule_inspection'` to `JOB_REF_INTENTS` (L99-113):

```ts
  // Tradesperson wave 1 — aliases resolve the same refs as their targets.
  'log_permit',
  'schedule_inspection',
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/proposals/voice-tradesperson-intents.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 7: Update the intent-catalog contract test**

Add the three intents to the pinning test found in Task 0 Step 3 (they map to existing handled types, so its "every mapped type has a handler" assertion still holds). Run that test file; expected PASS.

- [ ] **Step 8: Build + commit**

Run: `cd packages/api && npm run build && npx vitest run test/proposals/`
Expected: build clean, tests green.

```bash
git add packages/api/src/ai/orchestration/intent-classifier.ts packages/api/src/proposals/voice-intent-map.ts packages/api/src/ai/agents/customer-calling/entity-resolution.ts packages/api/test/proposals/voice-tradesperson-intents.test.ts
git commit -m "feat(voice): schedule_inspection / log_permit / log_warranty_claim alias intents"
```

### Task 2: `update_catalog_item` voice intent (price-book edits by voice)

The proposal type, contract, and execution handler already exist (WS20, correction loop). This task adds the VOICE on-ramp: intent + map entry + drafting TaskHandler registration.

**Files:**
- Modify: `packages/api/src/ai/orchestration/intent-classifier.ts`
- Modify: `packages/api/src/proposals/voice-intent-map.ts`
- Modify: `packages/api/src/ai/orchestration/handler-registry.ts`
- Test: `packages/api/test/proposals/voice-tradesperson-intents.test.ts`

- [ ] **Step 1: Write the failing test** (append to the Phase 1 describe)

```ts
describe('Phase 1 — update_catalog_item voice intent', () => {
  it('is supported and maps to the existing update_catalog_item proposal type', () => {
    expect(SUPPORTED_INTENTS).toContain('update_catalog_item');
    expect(intentToProposalType('update_catalog_item')).toBe('update_catalog_item');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/voice-tradesperson-intents.test.ts -t "update_catalog_item"`
Expected: FAIL.

- [ ] **Step 3: Add taxonomy + map entries**

`IntentType` union + `SUPPORTED_INTENTS`: add `| 'update_catalog_item'` with comment `// Tradesperson wave 1 — price-book edit by voice; rides WS20's existing proposal type.`

SYSTEM_PROMPT block:

```ts
- "update_catalog_item"  — owner changes a price-book (catalog) entry:
                           price, name, or description. Capture-class; only
                           shapes FUTURE drafts. Extract catalogItemReference
                           (spoken name) and the new unitPriceCents (integer
                           cents) or new name/description.
                           Examples: "Raise the diagnostic fee to 89 dollars"
                                     "Change the water heater install price to 1450"
                                     "Rename 'AC tune-up' to 'AC seasonal service'"
```

`INTENT_TO_PROPOSAL_TYPE`: add `update_catalog_item: 'update_catalog_item',` with comment `// WS20 type + handler pre-exist; this adds the voice on-ramp.`

- [ ] **Step 4: Register the drafting leg**

In `handler-registry.ts` `buildTaskHandlers`, check whether `handlers.set('update_catalog_item', ...)` already exists (`grep -n "update_catalog_item" packages/api/src/ai/orchestration/handler-registry.ts packages/api/src/workers/voice-action-router.ts`). The WS20 correction loop creates these proposals outside the voice path, so a TaskHandler likely does NOT exist. If absent, add one (shape per Task 0 Step 2) with:
- deps: `catalogRepo` (already in `HandlerRegistryDeps` — `InvoiceTaskHandler` uses it)
- extraction fields: `catalogItemReference` (string, required), `unitPriceCents` (integer, optional), `name` (string, optional), `description` (string, optional); gate: at least one of the three change fields present, else `missing.push('what to change (price, name, or description)')`
- candidate resolution: `catalogRepo.listByTenant(tenantId)` then case-insensitive `includes` match on the spoken reference; ambiguous (>1 match) → return the missing-fields gate listing the candidate names; zero matches → gate with "no catalog item matching '<ref>'"
- payload emitted must satisfy the EXISTING `update_catalog_item` contract — read its block in `contracts.ts` (Task 0 Step 1 capture) and emit exactly those fields.

- [ ] **Step 5: Run test + the existing WS20 contract tests**

Run: `cd packages/api && npx vitest run test/proposals/voice-tradesperson-intents.test.ts && npx vitest run -t "update_catalog_item"`
Expected: PASS everywhere.

- [ ] **Step 6: Commit**

```bash
git add -A packages/api/src
git add packages/api/test/proposals/voice-tradesperson-intents.test.ts
git commit -m "feat(voice): update_catalog_item intent — price-book edits by voice"
```

---

## Phase 2 — Money completion

### Task 3: `record_refund` intent + proposal type + handler

**Files:**
- Modify: `packages/api/src/ai/orchestration/intent-classifier.ts`
- Modify: `packages/api/src/proposals/voice-intent-map.ts`
- Modify: `packages/api/src/proposals/proposal.ts` (ProposalType union L29 + actionClass switch)
- Modify: `packages/api/src/proposals/contracts.ts` (payload contract)
- Create: `packages/api/src/proposals/execution/record-refund-handler.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts` (registration)
- Modify: `packages/api/src/ai/orchestration/handler-registry.ts` (drafting leg)
- Modify: `packages/api/src/ai/agents/customer-calling/entity-resolution.ts` (add `'record_refund'` to `INVOICE_DOC_INTENTS`)
- Test: `packages/api/test/proposals/record-refund-handler.test.ts`

- [ ] **Step 1: Verify the refunds substrate**

Run: `grep -n "264_create_payment_refunds" -A 25 packages/api/src/db/schema.ts` and `grep -rn "PaymentRefund\|payment_refunds" packages/api/src --include="*.ts" -l | grep -v test`
Record: the table's column list and whether a `PaymentRefundRepository` (or equivalent) exists with a `create(...)` method. The handler below injects a structurally-typed repo — adapt the import to the real repo found here. If NO repo exists, add `InMemoryPaymentRefundRepository` + `PgPaymentRefundRepository` in `packages/api/src/payments/payment-refund.ts` mirroring `packages/api/src/expenses/expense.ts`'s repo pair, with `create` inserting into `payment_refunds` using its actual columns.

- [ ] **Step 2: Write the failing tests**

Create `packages/api/test/proposals/record-refund-handler.test.ts` (mirrors `log-expense-handler.test.ts:1-45` shape):

```ts
import { describe, it, expect } from 'vitest';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { RecordRefundExecutionHandler } from '../../src/proposals/execution/record-refund-handler';
import type { Proposal } from '../../src/proposals/proposal';

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: 't1',
    proposalType: 'record_refund',
    status: 'approved',
    payload,
    summary: 'Record refund',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('record_refund proposal type', () => {
  it('is a valid proposal type classified as money (never auto-approves)', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('record_refund');
    expect(actionClassForProposalType('record_refund')).toBe('money');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('record_refund', {
      invoiceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      amountCents: 10000,
      method: 'cash',
      reason: 'callback — recharge did not hold',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a zero/negative amount', () => {
    const result = validateProposalPayload('record_refund', {
      invoiceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      amountCents: 0,
      method: 'cash',
    });
    expect(result.valid).toBe(false);
  });

  it('degrades to synthetic id without a repo, executes with one', async () => {
    const handler = new RecordRefundExecutionHandler();
    expect(handler.isFullyWired()).toBe(false);
    const result = await handler.execute(
      makeProposal({
        invoiceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        amountCents: 10000,
        method: 'cash',
        reason: 'test',
      }),
      { tenantId: 't1', executedBy: 'u1' },
    );
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run test/proposals/record-refund-handler.test.ts`
Expected: FAIL — `record_refund` not in ProposalType / module not found.

- [ ] **Step 4: Add ProposalType + action class + contract**

`proposal.ts` L29: add `'record_refund'` to the union. In `actionClassForProposalType`:

```ts
    // Recording a refund reverses collected money — money-class, never
    // auto-approves at any trust tier (D3). This records a MANUAL refund
    // (cash/check/external); Stripe-initiated refunds are a separate,
    // deliberate non-goal here (see 2026-08-07 tradesperson plan).
    case 'record_refund':
      return 'money';
```

`contracts.ts`: add a `record_refund` payload block (pattern per Task 0 Step 1) enforcing: `invoiceId` (uuid string, required), `amountCents` (integer > 0, required), `method` (enum: `'cash' | 'check' | 'card_external' | 'other'`, required), `reason` (string, optional), `checkNumber` (string, optional).

- [ ] **Step 5: Write the execution handler**

Create `packages/api/src/proposals/execution/record-refund-handler.ts` (LogExpense shape, `log-expense-handler.ts:1-104`):

```ts
import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

const REFUND_METHODS = ['cash', 'check', 'card_external', 'other'] as const;
type RefundMethod = (typeof REFUND_METHODS)[number];

/** Structural dep — satisfied by the concrete refunds repo found in
 * Task 3 Step 1 (adapt the import if a named repo exists). Records a
 * MANUAL refund row; it does not touch Stripe. */
export interface RefundRecorder {
  create(input: {
    tenantId: string;
    invoiceId: string;
    amountCents: number;
    method: RefundMethod;
    reason?: string;
    checkNumber?: string;
    createdBy: string;
  }): Promise<{ id: string }>;
}

/**
 * Executes an approved `record_refund` proposal: persists a manual refund
 * row against `payment_refunds` and emits a `refund.recorded` audit event.
 * Money-class — only ever runs after explicit owner approval. Follows the
 * voice-handler pattern: degrades to a synthetic-id passthrough without a
 * wired repo; boot fails via wiring-assertions when a pool is configured.
 */
export class RecordRefundExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'record_refund';

  constructor(
    private readonly refundRepo?: RefundRecorder,
    private readonly auditRepo?: AuditRepository,
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.refundRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    const invoiceId = typeof payload.invoiceId === 'string' ? payload.invoiceId : '';
    const amountCents = typeof payload.amountCents === 'number' ? payload.amountCents : NaN;
    const method = payload.method as RefundMethod;
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
    const checkNumber = typeof payload.checkNumber === 'string' ? payload.checkNumber : undefined;

    if (!invoiceId) return { success: false, error: 'Payload invoiceId is required' };
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return { success: false, error: 'Payload amountCents must be a positive integer' };
    }
    if (!REFUND_METHODS.includes(method)) {
      return { success: false, error: `Payload method must be one of: ${REFUND_METHODS.join(', ')}` };
    }

    if (!this.refundRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    let refundId: string;
    try {
      const refund = await this.refundRepo.create({
        tenantId: context.tenantId,
        invoiceId,
        amountCents,
        method,
        ...(reason ? { reason } : {}),
        ...(checkNumber ? { checkNumber } : {}),
        createdBy: context.executedBy,
      });
      refundId = refund.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to record refund: ${msg}` };
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'refund.recorded',
            entityType: 'invoice',
            entityId: invoiceId,
            metadata: { proposalId: proposal.id, proposalType: 'record_refund', amountCents, method },
          }),
        );
      } catch (auditErr) {
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn(
          `Failed to emit refund.recorded audit event for invoice ${invoiceId} (proposal ${proposal.id}): ${msg}`,
        );
      }
    }

    return { success: true, resultEntityId: refundId };
  }
}
```

- [ ] **Step 6: Register execution + taxonomy + drafting legs**

`handlers.ts`: next to `RecordPaymentExecutionHandler` (L1389), add `new RecordRefundExecutionHandler(deps?.paymentRefundRepo, deps?.auditRepo),` and add `paymentRefundRepo?: RefundRecorder` to the deps type (find it: `grep -n "expenseRepo" packages/api/src/proposals/execution/handlers.ts | head -3` — add alongside).

`intent-classifier.ts`: union + SUPPORTED_INTENTS entry `'record_refund'`; SYSTEM_PROMPT block:

```ts
- "record_refund"        — owner records money given BACK to a customer
                           (cash/check/external card refund). Money-class,
                           never auto-approves. Extract invoiceReference,
                           amount (integer cents), refund method, and reason.
                           Examples: "Refund the Smiths 100 dollars on their invoice"
                                     "Give the Garcias back 250, the part was under warranty"
                                     "Record a 75 dollar check refund to Jones, check 2044"
```

`voice-intent-map.ts`: `record_refund: 'record_refund',`
`entity-resolution.ts`: add `'record_refund'` to `INVOICE_DOC_INTENTS` (L75-89).
`handler-registry.ts`: add a `record_refund` TaskHandler (Task 0 Step 2 shape): fields `invoiceReference` (required → resolve to `invoiceId` via the same invoice candidate picker `record_payment`'s handler uses — locate with `grep -n "record_payment" packages/api/src/ai/orchestration/handler-registry.ts`), `amountCents` (required, integer > 0), `method` (default `'cash'` when unstated), `reason`, `checkNumber`; gates on missing invoice reference or amount. Register in `assistant.ts` `proposalHandlers` (L1333-1373): `record_refund: () => sharedHandlers.get('record_refund')!,`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/api && npm run build && npx vitest run test/proposals/record-refund-handler.test.ts test/proposals/voice-tradesperson-intents.test.ts`
Expected: build clean (exhaustive switch satisfied), tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A packages/api/src packages/api/test/proposals/record-refund-handler.test.ts
git commit -m "feat(voice): record_refund — manual refunds by voice (money-class)"
```

### Task 4: `apply_credit` intent + proposal type + handler

Mirror of `apply_late_fee` with a negative, floor-guarded adjustment. Study the exemplar first: `packages/api/src/proposals/execution/apply-late-fee-handler.ts` (registered conditionally on `deps.invoiceRepo`, `handlers.ts:1463-1467`).

**Files:**
- Modify: `packages/api/src/ai/orchestration/intent-classifier.ts`, `packages/api/src/proposals/voice-intent-map.ts`, `packages/api/src/proposals/proposal.ts`, `packages/api/src/proposals/contracts.ts`, `packages/api/src/proposals/execution/handlers.ts`, `packages/api/src/ai/orchestration/handler-registry.ts`, `packages/api/src/routes/assistant.ts`, `packages/api/src/ai/agents/customer-calling/entity-resolution.ts`
- Create: `packages/api/src/proposals/execution/apply-credit-handler.ts`
- Test: `packages/api/test/proposals/apply-credit-handler.test.ts`

- [ ] **Step 1: Read the exemplar**

Run: `cat packages/api/src/proposals/execution/apply-late-fee-handler.ts`
Note exactly: its constructor deps (`invoiceRepo`, `auditRepo`, `moneyStateDeps`), how it appends a line item, and how it refreshes the money-state rollup. `ApplyCreditExecutionHandler` is the same file with three changes (below).

- [ ] **Step 2: Write the failing tests**

Create `packages/api/test/proposals/apply-credit-handler.test.ts` — same skeleton as Task 3 Step 2 with these assertions:

```ts
describe('apply_credit proposal type', () => {
  it('is a valid proposal type classified as money', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('apply_credit');
    expect(actionClassForProposalType('apply_credit')).toBe('money');
  });

  it('accepts a well-formed payload and rejects non-positive credit', () => {
    expect(
      validateProposalPayload('apply_credit', {
        invoiceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        amountCents: 5000,
        reason: 'goodwill — repeat leak',
      }).valid,
    ).toBe(true);
    expect(
      validateProposalPayload('apply_credit', {
        invoiceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        amountCents: -5000,
      }).valid,
    ).toBe(false);
  });
});
```

Plus one behavioral test using the same in-memory invoice repo the late-fee handler's test uses (find it: `grep -rn "ApplyLateFee" packages/api/test -l`; copy its setup): applying a 5000¢ credit to an invoice with `amountDueCents: 3000` must FAIL with an error mentioning the floor (credit may not exceed amount due), and applying 2000¢ must succeed and reduce amount due to 1000.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run test/proposals/apply-credit-handler.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

`proposal.ts`: add `'apply_credit'` to the union +:

```ts
    // Applying a credit reduces an issued invoice's amount due — it moves
    // money (down, but money nonetheless), so money-class: never auto-
    // approves. The handler floors at zero: a credit may never exceed the
    // outstanding amount (over-crediting is a refund — use record_refund).
    case 'apply_credit':
      return 'money';
```

`contracts.ts`: payload block — `invoiceId` (uuid, required), `amountCents` (integer > 0, required — the handler applies it as negative), `reason` (string, optional).

Create `apply-credit-handler.ts` as a copy of `apply-late-fee-handler.ts` with: (1) `proposalType = 'apply_credit'`; (2) the appended line is `{ description: reason ? \`Credit — ${reason}\` : 'Credit', quantity: 1, unitPriceCents: -amountCents }` non-taxable; (3) a pre-write guard `if (amountCents > invoice.amountDueCents) return { success: false, error: \`Credit (${amountCents}¢) exceeds amount due (${invoice.amountDueCents}¢) — record a refund instead\` };` — same audit shape with `eventType: 'credit.applied'`.

`handlers.ts`: inside the existing `if (deps?.invoiceRepo)` block (L1450-1468), add `handlers.push(new ApplyCreditExecutionHandler(deps.invoiceRepo, deps.auditRepo, moneyStateDeps));`.

Taxonomy: union/SUPPORTED_INTENTS `'apply_credit'`; SYSTEM_PROMPT block:

```ts
- "apply_credit"         — owner reduces what a customer owes on an issued
                           invoice (goodwill, warranty labor, price match).
                           Money-class, never auto-approves. Extract
                           invoiceReference, amount (integer cents), reason.
                           Examples: "Knock 50 dollars off the Henderson invoice"
                                     "Apply a 100 dollar credit to Jones for the callback"
                                     "Credit the Garcias 75 — we were late"
```

Map: `apply_credit: 'apply_credit',`. Entity resolution: add to `INVOICE_DOC_INTENTS`. Drafting leg: TaskHandler with `invoiceReference` (required, same picker as Task 3), `amountCents` (required), `reason` (optional); register in `handler-registry.ts` + `assistant.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/api && npm run build && npx vitest run test/proposals/apply-credit-handler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A packages/api/src packages/api/test/proposals/apply-credit-handler.test.ts
git commit -m "feat(voice): apply_credit — floor-guarded invoice credits by voice (money-class)"
```

---

## Phase 3 — `send_customer_message` (the highest-frequency gap)

### Task 5: `send_customer_message` intent + proposal type + handler

Free-form outbound message to a customer ("Text the Hendersons the part arrived"). Comms-class: drafted by AI, ALWAYS owner-approved before sending. Reuses the delivery machinery `notify_delay` uses.

**Files:**
- Modify: taxonomy/map/proposal/contracts/handlers/handler-registry/assistant/entity-resolution (as prior tasks)
- Modify: `packages/api/src/db/schema.ts` (migration 270 — dispatch entity type)
- Create: `packages/api/src/proposals/execution/send-customer-message-handler.ts`
- Test: `packages/api/test/proposals/send-customer-message-handler.test.ts`

- [ ] **Step 1: Read the delivery exemplar**

Run: `cat packages/api/src/proposals/execution/full-app-voice-handlers.ts | sed -n '243,324p'` (NotifyDelayExecutionHandler) and `grep -rn "delayNotificationService\|DelayNotificationService" packages/api/src --include="*.ts" -l | grep -v test | head -5`
Record: how a customer-facing message is dispatched (service interface, channel selection SMS/email, `message_dispatches` row, TCPA/consent gates). The new handler must route through the SAME service layer — never call Twilio directly.

- [ ] **Step 2: Migration 270 — allow the new dispatch entity type**

In `schema.ts` after `'269_dispatch_entity_portal_session'` (L6541), add:

```ts
  // Tradesperson wave 1 — free-form owner-approved customer message
  // (send_customer_message proposal). New dispatch entity type so the
  // message_dispatches audit trail can carry it.
  '270_dispatch_entity_custom_message': `
    ALTER TABLE message_dispatches
      DROP CONSTRAINT IF EXISTS message_dispatches_entity_type_check;
    ALTER TABLE message_dispatches
      ADD CONSTRAINT message_dispatches_entity_type_check
        CHECK (entity_type IN (
          'estimate', 'invoice', 'appointment_confirmation',
          'appointment_reschedule', 'appointment_cancel', 'appointment_reminder',
          'payment_receipt', 'invoice_overdue', 'delay_notice', 'appointment_en_route',
          'daily_digest', 'conversation_reply', 'portal_session', 'custom_message'
        ));
  `,
```

Run: `npm run check:migration-keys`. Expected: clean.

- [ ] **Step 3: Write the failing tests**

Create `packages/api/test/proposals/send-customer-message-handler.test.ts` (Task 3 skeleton) asserting: (a) `'send_customer_message'` in `VALID_PROPOSAL_TYPES` with action class `'comms'`; (b) contract accepts `{ customerId: '<uuid>', channel: 'sms', body: 'Your part arrived — we can come Thursday morning.' }` and rejects an empty `body` and an unknown `channel`; (c) handler degrades to synthetic id unwired; (d) with a stubbed messenger (in-test fake `{ sendCustomMessage: async () => ({ dispatched: true, dispatchId: 'd1' }) }`) execution succeeds and passes tenantId/customerId/body through.

- [ ] **Step 4: Run tests to verify they fail** — `npx vitest run test/proposals/send-customer-message-handler.test.ts` → FAIL.

- [ ] **Step 5: Implement all four legs**

`proposal.ts`: `'send_customer_message'` +:

```ts
    // A free-form outbound customer message is the definition of comms-
    // class: never auto-approves at any trust tier — the owner reads the
    // exact text before a customer sees it. The AI drafts; a human sends.
    case 'send_customer_message':
      return 'comms';
```

`contracts.ts`: `customerId` (uuid, required), `channel` (`'sms' | 'email'`, required), `body` (non-empty string, max 1000 chars, required), `subject` (string, optional — email only).

Create `send-customer-message-handler.ts` (LogExpense shape): structural dep `CustomerMessenger { sendCustomMessage(input: { tenantId: string; customerId: string; channel: 'sms' | 'email'; body: string; subject?: string; actorId: string }): Promise<{ dispatched: boolean; dispatchId?: string }> }` — implemented by (or a thin adapter over) the service found in Step 1, dispatching with `entity_type: 'custom_message'`; validation mirrors the contract; audit `eventType: 'customer_message.sent'`, `entityType: 'customer'`. `isFullyWired()` = messenger present.

`handlers.ts`: register `new SendCustomerMessageExecutionHandler(deps?.customerMessenger, deps?.auditRepo)` + add the dep. Wire the concrete adapter at the composition root — find where `delayNotificationService` is constructed in `app.ts` (`grep -n "delayNotificationService" packages/api/src/app.ts | head -3`) and build the adapter next to it.

Taxonomy block:

```ts
- "send_customer_message" — owner/technician sends the customer a free-form
                           text or email (status update, part arrival, ETA,
                           thanks). Comms-class: the AI drafts the exact
                           message; the owner approves before send. Extract
                           customerReference, channel (sms unless email
                           stated), and messageBody (the content to send,
                           cleaned up but faithful).
                           Examples: "Text the Hendersons the part arrived, we can come Thursday"
                                     "Email the Garcias that the inspection passed"
                                     "Let Maria know we're finished and the gate is locked"
```

Map: `send_customer_message: 'send_customer_message',`. Entity resolution: add `'send_customer_message'` to the customer-reference set (same set found in Task 1 Step 5). Drafting TaskHandler: fields `customerReference` (required → customerId via the customer picker `update_customer`'s handler uses), `channel` (default `'sms'`), `messageBody` (required, gate when empty: `missing.push('what the message should say')`); the handler's LLM step rewrites the spoken body into a clean customer-ready message but must preserve meaning and never add commitments (prompt line: "Rewrite the operator's spoken message as a short, polite customer message. Do not add promises, prices, or times the operator did not say."). Register in `handler-registry.ts` + `assistant.ts`.

- [ ] **Step 6: Run tests + build** — `npm run build && npx vitest run test/proposals/send-customer-message-handler.test.ts` → PASS.

- [ ] **Step 7: Voice-quality corpus entry**

Add `packages/api/src/ai/voice-quality/corpus/scripts/03-operator-actions/send-customer-message-part-arrived.json` (format per the two exemplars in `01-happy-lookups/`; put it in the operator bucket — `ls packages/api/src/ai/voice-quality/corpus/scripts/` to confirm bucket names): one turn, caller line "Text the Hendersons that their part arrived and we can come Thursday morning", expected intent `send_customer_message`. Run `npm run voice-quality` if cassettes exist for the bucket; otherwise `npx vitest run test/ai/orchestration -t "send_customer_message"` for the classifier-level check.

- [ ] **Step 8: Commit**

```bash
git add -A packages/api/src packages/api/test/proposals/send-customer-message-handler.test.ts
git commit -m "feat(voice): send_customer_message — free-form owner-approved customer comms"
```

---

## Phase 4 — Revenue engine

### Task 6: `create_change_order` intent + proposal type + handler

A change order = a new estimate attached to an EXISTING job, flagged as a change order. Migration 271 adds the flag column; execution reuses the estimate-creation path `draft_estimate` uses.

**Files:**
- Modify: `packages/api/src/db/schema.ts` (migration 271), taxonomy/map/proposal/contracts/handlers/handler-registry/assistant/entity-resolution
- Create: `packages/api/src/proposals/execution/create-change-order-handler.ts`
- Test: `packages/api/test/proposals/create-change-order-handler.test.ts`

- [ ] **Step 1: Migration 271**

```ts
  // Tradesperson wave 1 — change orders are estimates pinned to an existing
  // job and flagged so reporting can separate scope-adds from original bids.
  '271_estimates_change_order_flag': `
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS is_change_order BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_estimates_change_order
      ON estimates (tenant_id, job_id) WHERE is_change_order = TRUE;
  `,
```

Run `npm run check:migration-keys` → clean.

- [ ] **Step 2: Read the estimate-creation exemplar**

Run: `grep -n "class DraftEstimateExecutionHandler" -A 60 packages/api/src/proposals/execution/handlers.ts` (it lives at `handlers.ts:870`).
Record: the estimate repo's create method + how grounded `lineItems` land. The change-order handler is this plus `jobId` (required, not optional) and `is_change_order: true`; extend the estimate repo's create input with optional `isChangeOrder?: boolean` (default false) — update `packages/api/src/estimates/` types + `pg-` implementation (find them: `grep -rn "interface.*EstimateRepository\|createEstimate" packages/api/src/estimates/*.ts | head`).

- [ ] **Step 3: Write the failing tests**

`create-change-order-handler.test.ts` (Task 3 skeleton): (a) type present, action class `'capture'`; (b) contract accepts `{ jobId: '<uuid>', title: 'Change order — add second zone', lineItems: [{ description: 'Second zone', quantity: 1, unitPriceCents: 180000 }] }`, rejects a payload missing `jobId` (that is the whole point of the type); (c) unwired → synthetic id; wired with the in-memory estimate repo (same fixture the draft_estimate tests use — `grep -rn "InMemoryEstimateRepository" packages/api/test -l | head -1`) → creates an estimate with `isChangeOrder: true` linked to the job.

- [ ] **Step 4: Fail** — `npx vitest run test/proposals/create-change-order-handler.test.ts` → FAIL.

- [ ] **Step 5: Implement**

`proposal.ts`: `'create_change_order'` +:

```ts
    // A change order mints a NEW draft estimate against an existing job —
    // no money moves, sending is a later comms-class step, so capture-class
    // like draft_estimate. The jobId is REQUIRED (that's what makes it a
    // change order and not a fresh bid).
    case 'create_change_order':
      return 'capture';
```

`contracts.ts`: `jobId` (uuid, required), `title` (string, required), `lineItems` (array of `{description, quantity, unitPriceCents?}`, min 1, required), `customerMessage` (optional).

Handler (LogExpense shape, estimate repo dep): validates, prefixes `title` with `Change order — ` when the drafting layer didn't, creates the estimate `{ jobId, isChangeOrder: true, internalNotes: \`Created from voice change-order proposal ${proposal.id}\`, lineItems }`, audit `estimate.change_order_created`. Register in `handlers.ts` inside `if (deps?.estimateRepo)` (L1469-1480).

Taxonomy:

```ts
- "create_change_order"  — mid-job scope change the customer asked for:
                           drafts a NEW estimate tied to the EXISTING job.
                           Extract jobReference (required), the added work
                           description, and amount if spoken (integer cents).
                           Examples: "The Garcias want a second zone — change order for 1800"
                                     "Add a change order on the Patel job: replace the flue liner too"
                                     "Customer added three more outlets — write it up"
```

Map: `create_change_order: 'create_change_order',`. Entity resolution: add `'create_change_order'` to `JOB_REF_INTENTS`. Drafting TaskHandler: `jobReference` (required, resolve → `jobId`, gate when unresolved — a change order without its job is meaningless), work description → single line item (grounded via `catalogRepo` when a match exists, same `groundLineItemPricing` helper `buildVoiceProposalPayload` uses — `grep -n "groundLineItemPricing" packages/api/src -r`), spoken amount → `unitPriceCents`. Register in registry + assistant.

- [ ] **Step 6: Pass + commit**

`npm run build && npx vitest run test/proposals/create-change-order-handler.test.ts` → PASS.

```bash
git add -A packages/api/src packages/api/test/proposals/create-change-order-handler.test.ts
git commit -m "feat(voice): create_change_order — scope changes drafted against the live job"
```

### Task 7: `create_service_agreement` intent + proposal type + handler

The `service_agreements` table exists (migration 056: name, recurrence_rule, price_cents, next_run_at, starts_on, auto_generate flags — `schema.ts:1334-1354`). This adds the voice on-ramp to recurring revenue.

**Files:** taxonomy/map/proposal/contracts/handlers/handler-registry/assistant/entity-resolution + Create: `packages/api/src/proposals/execution/create-service-agreement-handler.ts` + Test: `packages/api/test/proposals/create-service-agreement-handler.test.ts`

- [ ] **Step 1: Find the agreements repo**

Run: `grep -rn "service_agreements\|ServiceAgreement" packages/api/src --include="*.ts" -l | grep -v test | head -8`
Record the repository interface + create method (a worker generates invoices/jobs from these rows, so a repo exists). The handler injects it structurally: `AgreementCreator { create(input: { tenantId: string; customerId: string; locationId?: string; name: string; description?: string; recurrenceRule: string; priceCents: number; startsOn: string; nextRunAt: Date; createdBy: string }): Promise<{ id: string }> }` — adapt field names to the real interface found here.

- [ ] **Step 2: Failing tests**

`create-service-agreement-handler.test.ts` (Task 3 skeleton): (a) type present, class `'capture'`; (b) contract accepts `{ customerId: '<uuid>', name: 'Annual maintenance plan', recurrenceRule: 'FREQ=MONTHLY', priceCents: 2900, startsOn: '2026-09-01' }`, rejects `priceCents < 0` and an empty `name`; (c) unwired degrade; wired create passes through with `nextRunAt` computed from `startsOn`.

- [ ] **Step 3: Fail** → **Step 4: Implement**

`proposal.ts`: `'create_service_agreement'` +:

```ts
    // Signing a customer up to a recurring plan writes an agreement row —
    // no money moves at creation (the agreement's own sweep invoices later,
    // and those invoices ride the normal review path), so capture-class.
    case 'create_service_agreement':
      return 'capture';
```

`contracts.ts`: `customerId` (uuid, required), `name` (non-empty string, required), `recurrenceRule` (non-empty string, required — RRULE text like `FREQ=MONTHLY` / `FREQ=YEARLY;INTERVAL=1`; the drafting layer maps spoken cadence → RRULE), `priceCents` (integer ≥ 0, required), `startsOn` (ISO date string, required), `description`, `locationId` (optional).

Handler (LogExpense shape): validates; `nextRunAt = new Date(startsOn)`; creates via the repo from Step 1; audit `service_agreement.created` (the analytics mapping for `service_agreement_created` already exists — verify with `grep -n "service_agreement" packages/api/src/analytics/audit-event-mapping.ts`). Register in `handlers.ts` with its repo dep.

Taxonomy:

```ts
- "create_service_agreement" — owner signs a customer up for a recurring
                           maintenance plan/membership. Extract
                           customerReference, plan name, cadence
                           (monthly/quarterly/twice a year/annual), price
                           (integer cents per period), and start date if
                           spoken (default: first of next month).
                           Examples: "Sign the Garcias up for the annual maintenance plan, 290 a year"
                                     "Put Maria on the 29-a-month membership starting September"
                                     "Quarterly filter service for the Patels, 79 per visit"
```

Map + entity resolution (customer-ref set) + drafting TaskHandler: `customerReference` (required), cadence words → RRULE (`monthly`→`FREQ=MONTHLY`, `quarterly`→`FREQ=MONTHLY;INTERVAL=3`, `twice a year`→`FREQ=MONTHLY;INTERVAL=6`, `annual/yearly`→`FREQ=YEARLY`), `priceCents` (required), `startsOn` default first of next month in tenant timezone (reuse `SchedulingResolutionOptions` timezone plumbing, `entity-resolution.ts:218-260`). Register in registry + assistant.

- [ ] **Step 5: Pass + commit**

```bash
git add -A packages/api/src packages/api/test/proposals/create-service-agreement-handler.test.ts
git commit -m "feat(voice): create_service_agreement — recurring plans signed up by voice"
```

---

## Phase 5 — Materials

### Task 8: `material_items` table + repo (migration 272)

- [ ] **Step 1: Failing repo test**

Create `packages/api/test/materials/material-item.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryMaterialItemRepository } from '../../src/materials/material-item';

describe('MaterialItemRepository', () => {
  it('creates and lists pending items by tenant, optional job filter', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await repo.create({
      tenantId: 't1', description: '3 boxes 1/2" PEX', quantity: 3,
      jobId: 'job-1', createdBy: 'u1',
    });
    await repo.create({ tenantId: 't1', description: 'Flue liner kit', quantity: 1, createdBy: 'u1' });
    await repo.create({ tenantId: 't2', description: 'other tenant', quantity: 1, createdBy: 'u2' });

    const all = await repo.listPending('t1');
    expect(all).toHaveLength(2);
    const forJob = await repo.listPending('t1', { jobId: 'job-1' });
    expect(forJob).toHaveLength(1);
    expect(forJob[0].description).toBe('3 boxes 1/2" PEX');

    await repo.markPurchased('t1', all[0].id, 'u1');
    expect(await repo.listPending('t1')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Fail** — `npx vitest run test/materials/material-item.test.ts` → module not found.

- [ ] **Step 3: Migration 272 + module**

`schema.ts` (RLS pattern per `call_me_back_tasks`, `schema.ts:3861-3892`):

```ts
  // Tradesperson wave 1 — voice-captured materials/shopping list. An item
  // is an operational row (like call_me_back_tasks), created via an
  // approved add_material proposal; purchasing/PO automation is a non-goal.
  '272_create_material_items': `
    CREATE TABLE IF NOT EXISTS material_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      job_id UUID REFERENCES jobs(id),
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      vendor TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'purchased', 'cancelled')),
      needed_by TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      purchased_by TEXT,
      purchased_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE material_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE material_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_material_items ON material_items;
    CREATE POLICY tenant_isolation_material_items ON material_items
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
    CREATE INDEX IF NOT EXISTS idx_material_items_tenant ON material_items (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_material_items_pending
      ON material_items (tenant_id) WHERE status = 'pending';
  `,
```

Create `packages/api/src/materials/material-item.ts` — mirror `packages/api/src/expenses/expense.ts`'s structure exactly (`cat` it first): a `MaterialItem` type matching the columns, `MaterialItemRepository` interface (`create`, `listPending(tenantId, opts?: { jobId?: string })`, `markPurchased(tenantId, id, actorId)`), `InMemoryMaterialItemRepository`, and `PgMaterialItemRepository` following the expense Pg repo's query/RLS style.

- [ ] **Step 4: Pass** — repo test green; `npm run check:migration-keys` clean. **Step 5: Commit** `git add -A packages/api/src/materials packages/api/src/db/schema.ts packages/api/test/materials && git commit -m "feat(materials): material_items table + repo (migration 272)"`.

### Task 9: `add_material` intent + handler, `lookup_materials` lookup

**Files:** taxonomy/map/proposal/contracts/handlers/handler-registry/assistant/entity-resolution + Create: `packages/api/src/proposals/execution/add-material-handler.ts` + Modify: `packages/api/src/workers/voice-lookup-answer.ts` + Test: `packages/api/test/proposals/add-material-handler.test.ts`

- [ ] **Step 1: Failing tests** — Task 3 skeleton: type present, class `'capture'`; contract accepts `{ description: '3 boxes 1/2" PEX', quantity: 3, jobId: '<uuid>' }` (quantity defaults 1, jobId/vendor/neededBy optional), rejects empty description; handler unwired degrade / wired create via `InMemoryMaterialItemRepository`. Plus a lookup test in the same file asserting `intentToProposalType('lookup_materials')` stays `'voice_clarification'` (lookups are NOT in the map) and `isLookupIntent('lookup_materials')` is true.

- [ ] **Step 2: Fail.** **Step 3: Implement.**

`proposal.ts`: `'add_material'` + `case 'add_material': return 'capture';` (comment: `// Adds a row to the shopping list — no money, reversible, capture.`). `contracts.ts`: `description` (required), `quantity` (integer > 0, default 1), `jobId`/`vendor`/`neededBy` optional. Handler: LogExpense shape over `MaterialItemRepository.create`, audit `material.requested`. Register in `handlers.ts` (`deps?.materialItemRepo`) + wire the Pg repo at the composition root next to `expenseRepo` (`grep -n "expenseRepo" packages/api/src/app.ts | head -3`).

Taxonomy — action intent:

```ts
- "add_material"         — owner/technician adds parts/materials to the
                           shopping list, optionally tied to a job and
                           vendor. Extract description (required), quantity,
                           jobReference, vendor, neededBy date.
                           Examples: "Add three boxes of half-inch PEX to the shopping list"
                                     "We need a flue liner kit for the Patel job"
                                     "Pick up two 40-gallon heaters at Ferguson before Thursday"
```

Lookup intent (union + SUPPORTED_INTENTS `'lookup_materials'`):

```ts
- "lookup_materials"     — read back the pending shopping list, optionally
                           for one job or "for tomorrow".
                           Examples: "What parts do I need tomorrow?"
                                     "Read me the shopping list"
                                     "What materials are open on the Patel job?"
```

Map: `add_material: 'add_material',` (lookup intents are never mapped). Entity resolution: `'add_material'` and `'lookup_materials'` into `JOB_REF_INTENTS`. Drafting TaskHandler for `add_material` (fields above; only `description` gates). Lookup leg in `voice-lookup-answer.ts`: add `materialItemRepo` to its deps, a case following `lookup_revenue`'s shape (L583-597):

```ts
      case 'lookup_materials': {
        if (!deps.materialItemRepo) return { kind: 'unsupported' };
        const items = await deps.materialItemRepo.listPending(tenantId, jobId ? { jobId } : undefined);
        if (items.length === 0) {
          return { kind: 'answer', answer: buildAnswer(intent, 'none', 'Your materials list is clear — nothing pending.', []) };
        }
        const summary = `${items.length} item${items.length === 1 ? '' : 's'} on the materials list: ` +
          items.slice(0, 5).map((m) => `${m.quantity}× ${m.description}`).join('; ') +
          (items.length > 5 ? `; and ${items.length - 5} more` : '');
        return {
          kind: 'answer',
          answer: buildAnswer(intent, 'found', summary,
            items.slice(0, 5).map((m) => text(m.description, `qty ${m.quantity}${m.vendor ? ` — ${m.vendor}` : ''}`))),
        };
      }
```

(Adapt `text(...)` row helper to the file's actual row-builder — `grep -n "function text\|const text" packages/api/src/workers/voice-lookup-answer.ts`.) No entry in `LOOKUP_REQUIRED_PERMISSION` (any authenticated operator may hear the shopping list).

- [ ] **Step 4: Pass + commit** — `npm run build && npx vitest run test/proposals/add-material-handler.test.ts test/materials` → PASS.

```bash
git add -A packages/api/src packages/api/test
git commit -m "feat(voice): add_material + lookup_materials — voice shopping list"
```

---

## Phase 6 — People lookups

### Task 10: `lookup_crew_schedule`, `lookup_timesheets`, `lookup_my_day`

**Files:**
- Modify: `packages/api/src/ai/orchestration/intent-classifier.ts` (three lookup intents; add `lookup_crew_schedule`+`lookup_timesheets` to `OWNER_EXTENDED_LOOKUP_INTENT_TYPES` L305-312 — owner-line gated; `lookup_my_day` is NOT extended: any tech may ask about their own day)
- Modify: `packages/api/src/workers/voice-lookup-answer.ts` (three cases + permissions)
- Modify: `packages/api/src/workers/voice-action-router.ts` (only if lookup deps need threading — check `grep -n "voiceLookupDeps\|lookupDeps" packages/api/src/workers/voice-action-router.ts`)
- Test: `packages/api/test/workers/voice-lookup-people.test.ts`

- [ ] **Step 1: Read the lookup test exemplar** — `ls packages/api/test/workers/ | grep -i lookup` then `cat` the closest existing lookup test to copy its deps-stubbing setup (in-memory repos + `buildAnswer` assertions).

- [ ] **Step 2: Failing tests** — `voice-lookup-people.test.ts` with the exemplar's setup, covering:
  - `lookup_crew_schedule` for "Thursday afternoon": given two technicians where one has an appointment 13:00–15:00 Thursday and one has none, the answer summary names the free tech as available and shows the busy tech's booking. Requires resolving the spoken day via the same `resolveSpokenWindow` used in U4 (`entity-resolution.ts:218-260`).
  - `lookup_timesheets` for "this week": time entries totaling 12.5h for Carlos and 8h for Mike → summary contains both names with hours; permission-gated `reports:view`.
  - `lookup_my_day`: given the ASKING technician (recording `createdBy` → canonical technician via the same `resolveCanonicalTechnician` used by en-route, `dispatch/en-route-voice.ts:421-511`) with two assignments today → summary lists both with times; a tech with none → "nothing scheduled today".

- [ ] **Step 3: Fail.** **Step 4: Implement.**

Taxonomy blocks:

```ts
- "lookup_crew_schedule" — owner asks who is free / where a crew member is
                           on a given day or window. Owner-extended.
                           Examples: "Who's free Thursday afternoon?"
                                     "What's Mike's day look like?"
                                     "Where's Carlos right now?"
- "lookup_timesheets"    — owner asks logged hours per crew member for a
                           period (default: this week). Owner-extended.
                           Examples: "How many hours did Carlos log this week?"
                                     "Give me everyone's hours for the week"
- "lookup_my_day"        — the SPEAKER asks about their own schedule today.
                           Available to any technician; scoped to the
                           speaker's own assignments only.
                           Examples: "What's my next job?"
                                     "What's on my schedule today?"
                                     "Where am I going after this one?"
```

`voice-lookup-answer.ts`: extend deps with `assignmentRepo`, `appointmentRepo`, `userRepo`, `timeEntryRepo` (reuse the concrete types en-route + LogTimeEntry already use); add the three cases modeled on `lookup_revenue`; permissions: `['lookup_crew_schedule', 'reports:view']`, `['lookup_timesheets', 'reports:view']` in `LOOKUP_REQUIRED_PERMISSION`; `lookup_my_day` unlisted (self-scoped — filter STRICTLY to the resolved asking technician's own assignments; if the speaker can't be resolved to a technician, return `{ kind: 'failed', error: 'could not match you to a technician' }`).

`intent-classifier.ts`: add the two owner intents to `OWNER_EXTENDED_LOOKUP_INTENT_TYPES` (they then require `extendedIntents === true` exactly like `lookup_day_overview`).

- [ ] **Step 5: Pass + commit**

```bash
git add -A packages/api/src packages/api/test/workers/voice-lookup-people.test.ts
git commit -m "feat(voice): crew schedule, timesheets, and tech my-day lookups"
```

---

## Phase 7 — `log_mileage` + `add_catalog_item`

### Task 11: `log_mileage` alias intent (drafts a `log_expense`)

**Files:** `intent-classifier.ts`, `voice-intent-map.ts`, `handler-registry.ts`, `entity-resolution.ts` + Test: append to `voice-tradesperson-intents.test.ts`

- [ ] **Step 1: Failing test** — assert `'log_mileage'` supported and `intentToProposalType('log_mileage')` is `'log_expense'`; plus a TaskHandler unit test (place next to the existing log_expense TaskHandler tests — find them via Task 0 Step 2) asserting spoken "32 miles" yields payload `{ category: 'vehicle', amountCents: 2240, description: 'Mileage — 32 miles' , spentAt: <today> }` (32 × 70¢).

- [ ] **Step 2: Fail.** **Step 3: Implement.**

Taxonomy:

```ts
- "log_mileage"          — technician logs drive miles (tax deduction).
                           Maps to log_expense, category "vehicle", amount =
                           miles × DEFAULT_MILEAGE_RATE_CENTS_PER_MILE (70¢,
                           2026 IRS standard rate — constant, not config).
                           Extract miles (number, required) and jobReference.
                           Examples: "Log 32 miles to the Patel job"
                                     "Put down 18 miles for today's supply run"
```

Map: `log_mileage: 'log_expense',`. Entity resolution: `'log_mileage'` → `JOB_REF_INTENTS`. Drafting: in the log_expense TaskHandler (or a thin subclass registered for the alias — follow how `create_invoice` aliases `draft_invoice` in `assistant.ts:835`), when `intent === 'log_mileage'`: require `miles` (gate otherwise), compute `amountCents = Math.round(miles * 70)`, force `category: 'vehicle'`, description `Mileage — ${miles} miles`, `spentAt` = today. Export `DEFAULT_MILEAGE_RATE_CENTS_PER_MILE = 70` from the handler file with a comment naming the 2026 IRS rate.

- [ ] **Step 4: Pass + commit** — `git commit -m "feat(voice): log_mileage — mileage capture riding log_expense"`.

### Task 12: `add_catalog_item` intent + proposal type + handler

**Files:** taxonomy/map/proposal/contracts/handlers/handler-registry/assistant + Create: `packages/api/src/proposals/execution/add-catalog-item-handler.ts` + Test: `packages/api/test/proposals/add-catalog-item-handler.test.ts`

- [ ] **Step 1: Failing tests** — Task 3 skeleton: type present, class `'capture'`; contract accepts `{ name: 'Smart thermostat install', unitPriceCents: 38500 }` (+ optional `description`, `unit`), rejects empty name or negative price; unwired degrade; wired create via the in-memory catalog repo (exists? `grep -rn "InMemoryCatalogItemRepository" packages/api/src | head -1` — if absent, stub `{ create: async (i) => ({ ...i, id: 'c1' }) }` in-test).

- [ ] **Step 2: Fail.** **Step 3: Implement.**

`proposal.ts`: `'add_catalog_item'` + `case 'add_catalog_item': return 'capture';` (comment mirrors `update_catalog_item`'s WS20 rationale — config change shaping future drafts only). `contracts.ts`: `name` (required), `unitPriceCents` (integer ≥ 0, required), `description`/`unit` optional. Handler: LogExpense shape over `CatalogItemRepository.create` (`catalog/catalog-item.ts:56-62` — construct the `CatalogItem` per its type definition; `cat packages/api/src/catalog/catalog-item.ts` first), audit `catalog_item.created` (analytics event `catalog_item_created` already exists). Register in `handlers.ts` reusing `deps?.catalogRepo` if present in deps (check: `grep -n "catalogRepo" packages/api/src/proposals/execution/handlers.ts`) else add the dep.

Taxonomy:

```ts
- "add_catalog_item"     — owner adds a price-book entry (new service or
                           part with a standard price). Extract name
                           (required), unitPriceCents (required), unit and
                           description when spoken.
                           Examples: "Add a catalog item: smart thermostat install, 385"
                                     "New price-book entry — sump pump replacement, 1200"
```

Map + drafting TaskHandler (`name` + `unitPriceCents` gates) + registry + assistant wiring.

- [ ] **Step 4: Pass + commit** — `git commit -m "feat(voice): add_catalog_item — price-book additions by voice"`.

---

## Phase 8 — Parity fixes

### Task 13: Fix silent-skip on S2/voicemail for `language_switch` / `operator_request` / `confirm`

Today `voice-action-router.ts` indexes `INTENT_TO_PROPOSAL_TYPE[intentType]` directly (L1503) and on a miss logs a warn + `{kind:'skipped'}` — no user-visible feedback (unlike S1/IA, which call `intentToProposalType()` and get a clarification).

**Files:** Modify `packages/api/src/workers/voice-action-router.ts` (~L1496-1520) + Test: `packages/api/test/workers/voice-action-router-silent-skip.test.ts`

- [ ] **Step 1: Failing test** — using the router's existing test harness (find: `ls packages/api/test/workers/ | grep voice-action-router`; copy its setup), process a transcript classified as `confirm` (stub the classifier as the existing tests do) and assert a `voice_clarification` proposal is created whose payload `reason` mentions the intent isn't actionable on a recorded memo — instead of `{kind:'skipped'}` with nothing persisted. Repeat for `language_switch` and `operator_request` via `it.each`.

- [ ] **Step 2: Fail.** **Step 3: Implement** — in the miss branch (L1515-1520), replace silent skip for these three intents with the existing `emitClarification(...)` path (same helper used at L1182-1201) and copy for each:
  - `confirm`: "It sounds like you were confirming something, but recorded memos don't have a pending question — say the full action instead."
  - `language_switch`: "Language preferences apply to live calls — this memo was still processed in English."
  - `operator_request`: "Talking to a person isn't available from a recorded memo — call the office line instead."
  All other unmapped intents keep the existing warn+skip (that branch protects future taxonomy growth).

- [ ] **Step 4: Pass + commit** — `git commit -m "fix(voice): clarification cards instead of silent skips for confirm/language_switch/operator_request on memos"`.

### Task 14: `callback` proposal execution guard

`callback` proposals have NO execution handler and escape the boot guard (not a value of `INTENT_TO_PROPOSAL_TYPE`); an approved one reaches `executor.ts:167-174` → `HANDLER_NOT_FOUND` → retry loop → `'failed'`.

**Files:** Create `packages/api/src/proposals/execution/callback-handler.ts` + Modify `handlers.ts` + Test: `packages/api/test/proposals/callback-handler.test.ts`

- [ ] **Step 1: Failing test** — build the execution registry (`buildExecutionHandlers` or equivalent — the registry constructor at `handlers.ts:1512-1517`) with no deps and assert `registry.get('callback')` is defined, `isFullyWired()` is true (it needs no deps), and executing an approved callback proposal `{ payload: { callerPhone: '+15555550100', callbackMessage: 'wants a quote' } }` returns `{ success: true }` without throwing.

- [ ] **Step 2: Fail.** **Step 3: Implement:**

```ts
import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * `callback` proposals route a caller to a human — they mutate nothing
 * (see proposal.ts:302-305 / surface.ts:50). Historically they had NO
 * execution handler, so an approved callback hit HANDLER_NOT_FOUND and
 * retried into 'failed'. This handler makes approval a graceful no-op:
 * it acknowledges the callback (audit trail) and completes. The REAL
 * follow-up lives in call_me_back_tasks / the operator's queue.
 */
export class CallbackExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'callback';

  constructor(private readonly auditRepo?: AuditRepository) {}

  isFullyWired(): boolean {
    return true; // deliberately dep-free: acknowledging is always possible
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'callback.acknowledged',
            entityType: 'proposal',
            entityId: proposal.id,
            metadata: { proposalType: 'callback' },
          }),
        );
      } catch (auditErr) {
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn(`Failed to emit callback.acknowledged for proposal ${proposal.id}: ${msg}`);
      }
    }
    return { success: true, resultEntityId: uuidv4() };
  }
}
```

Register unconditionally in `handlers.ts`: `new CallbackExecutionHandler(deps?.auditRepo),`.

- [ ] **Step 4: Pass + commit** — `git commit -m "fix(proposals): callback execution handler — approved callbacks no longer HANDLER_NOT_FOUND"`.

### Task 15: Assistant-chat wiring for the six dropped shared-registry intents

`assistant.ts`'s `proposalHandlers` (L1333-1373) omits `add_crew_member`, `remove_crew_member`, `mark_lead_lost`, `add_service_location`, `convert_lead`, `request_feedback` — spoken/typed commands fall to a bare LLM reply. All six ALREADY have TaskHandlers in the worker's registry; this is dispatch wiring only (same as the "Field write intents (2026-07)" batch in the file). `emergency_dispatch`, `update_brand_voice`, `respond_to_review`, `create_standing_instruction` stay surface-specific BY DESIGN (`handler-registry.ts:53-83` comment) — do NOT wire them.

- [ ] **Step 1: Confirm the six exist in the shared registry** — `grep -n "add_crew_member\|mark_lead_lost\|add_service_location\|convert_lead\|request_feedback\|remove_crew_member" packages/api/src/ai/orchestration/handler-registry.ts`. If any is worker-local instead (in `voice-action-router.ts buildHandlers`), move it into `buildTaskHandlers` first (that's the whole point of the shared registry — B5).

- [ ] **Step 2: Failing test** — extend the existing assistant dispatch test (find: `grep -rn "proposalHandlers\|assistant.*chat" packages/api/test -l | head -3`) asserting a chat turn classified `mark_lead_lost` produces a proposal card, not a conversational fallback.

- [ ] **Step 3: Wire** — add six lines to `proposalHandlers` (and the chain map above it if the file keeps both in sync — read the comment at L1339):

```ts
        // Tradesperson wave 1 — six intents the worker drafted but chat
        // dropped to a bare LLM reply. Same shared registry, same gates.
        add_crew_member: () => sharedHandlers.get('add_crew_member')!,
        remove_crew_member: () => sharedHandlers.get('remove_crew_member')!,
        mark_lead_lost: () => sharedHandlers.get('mark_lead_lost')!,
        add_service_location: () => sharedHandlers.get('add_service_location')!,
        convert_lead: () => sharedHandlers.get('convert_lead')!,
        request_feedback: () => sharedHandlers.get('request_feedback')!,
```

Also add the NEW intents from Phases 2-7 here if any were missed (cross-check every task above that says "register in assistant").

- [ ] **Step 4: Pass + commit** — `git commit -m "fix(assistant): wire six dropped intents to the shared registry (B5 completion)"`.

---

## Final verification (after all phases)

- [ ] `cd packages/api && npm run build && npm test` — full suite green.
- [ ] `npm run lint && npm run check:migration-keys` — clean.
- [ ] Boot check: the wiring guard must pass with all new handlers — run the scoped runtime-verify skill (`Serviceos/packages/api:verify`) to boot the API in-memory and confirm no `assertVoiceHandlersWired` throw, then drive one simulated memo transcript per NEW action intent and confirm a proposal row of the right type + class lands in `'draft'`.
- [ ] Voice-quality: add one corpus script per Phase 2-5 action intent (format per Task 5 Step 7) and run `npm run voice-quality`.
- [ ] Update `packages/web` VoiceBar examples (`packages/web/src/components/shared/voice-examples.ts`) with five new entries: change order, refund, materials, service agreement, crew schedule — copy the existing entry shape.
- [ ] The S1 inbound-caller allowlist (`surface.ts:43-52`) is deliberately UNTOUCHED — every new type is operator-surface only. Verify: `npx vitest run -t "S1"` stays green.

## Self-review notes (already applied)

- Spec coverage: all 9 persona gaps → Tasks 1-12; 3 parity fixes → Tasks 13-15; tech-day-view gap → Task 10 (`lookup_my_day`). En-route surface parity + Stripe refunds + PO/purchasing automation explicitly out of scope with reasons.
- Type consistency: every new ProposalType appears in exactly four places (union, action-class switch, contracts, handler registration) + map; the exhaustive switch enforces it at compile time.
- The two capture-first seams (contracts.ts block shape, TaskHandler class shape) are Task 0 steps because inventing them cold would violate the repo's own contract tests — each task specifies the full field lists, gates, and prompt text so nothing is left to taste.
