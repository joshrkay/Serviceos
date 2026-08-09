/**
 * Tradesperson wave 1, Task 4 — ApplyCreditTaskHandler (drafting leg).
 *
 * Standalone file per the quality-review ratchet (mirrors complaint-task.ts /
 * brand-voice-task.ts) — voice-extended-tasks.ts is at capacity (2,205
 * lines) and new drafting handlers land in their own file from here on.
 *
 * `apply_credit` reduces what a customer owes on an ISSUED invoice
 * (goodwill, warranty labor, price match) — a NEW money-class proposal
 * type. Never auto-approves at any trust tier (D3).
 *
 * Reference resolution mirrors `RecordRefundTaskHandler` (Task 3,
 * voice-extended-tasks.ts) EXACTLY: `apply_credit` joins
 * `INVOICE_DOC_INTENTS` (ai/agents/customer-calling/entity-resolution.ts)
 * instead of resolving its own reference. By the time this handler runs,
 * the voice-action-router has already resolved the spoken invoice
 * reference — carried on `ee.jobReference` (there is no separate
 * `invoiceReference` extraction field anywhere in this taxonomy; every
 * invoice-doc intent reuses `jobReference`, disambiguated by intent-set
 * membership) — to a verified `invoiceId` and stamped it onto
 * `context.existingEntities`, OR short-circuited to a `voice_clarification`
 * on an ambiguous match, OR left it absent on no match / nothing spoken.
 * `invoiceId` is therefore read off the entities bag with a local
 * type-widening cast (house pattern — see `ComplaintTaskHandler` /
 * `RecordRefundTaskHandler`, which do the same for a router-injected id):
 * it is a ROUTER-INJECTED verified id, never an LLM-extracted field, so it
 * is deliberately NOT added to `ExtractedEntities` or the classifier's JSON
 * template/parse allowlist.
 *
 * Unlike `record_payment`'s contract, `apply_credit`'s has NO
 * `invoiceReference` fallback field — an unresolved reference gates the
 * proposal (`missingFields: ['invoiceId']`) rather than persisting free
 * text as a stand-in "reference" for a later step to puzzle out. Same
 * deliberately safer posture as `record_refund`.
 *
 * The floor guard (a credit may never exceed the invoice's amount due) is
 * enforced at EXECUTION time by `ApplyCreditExecutionHandler` — this
 * drafting handler never reads `amountDueCents` (it has no invoice repo),
 * so it cannot pre-validate the floor; it only gates on the flat payload
 * shape the execution handler's Zod contract requires.
 */
import { createProposal } from '../../proposals/proposal';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import { entitiesFrom, inputFor } from './task-input';

export class ApplyCreditTaskHandler implements TaskHandler {
  readonly taskType = 'apply_credit' as const;

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context) as ExtractedEntities & { invoiceId?: string };
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (typeof ee.invoiceId === 'string' && ee.invoiceId.length > 0) {
      payload.invoiceId = ee.invoiceId;
    } else {
      missing.push('invoiceId');
    }

    if (typeof ee.amount === 'number' && ee.amount > 0) {
      payload.amountCents = Math.round(ee.amount);
    } else {
      missing.push('amountCents');
    }

    if (typeof ee.creditReason === 'string' && ee.creditReason.trim().length > 0) {
      payload.reason = ee.creditReason.trim();
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }
}
