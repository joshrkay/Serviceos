/**
 * Tradesperson wave 1, Task 6 — create_change_order execution handler tests.
 *
 * `create_change_order` mints a NEW estimate pinned to an EXISTING job,
 * flagged `isChangeOrder: true` (migration 271) so reporting can separate
 * scope-adds from original bids. `jobId` is REQUIRED on the contract —
 * that's what makes this a change order and not `draft_estimate` (a fresh
 * bid, whose jobId is optional).
 *
 * Covers: valid-type + capture-class classification, payload validation
 * (jobId required, title required, lineItems non-empty), dev-wiring
 * passthrough, and the wired estimate-creation path (isChangeOrder flag,
 * job linkage, title prefixing, estimate numbering, audit event) —
 * LogExpenseExecutionHandler's house pattern, plus the estimateRepo +
 * settingsRepo dual-dependency `DraftEstimateExecutionHandler` needs for
 * estimate numbering.
 */
import { describe, it, expect } from 'vitest';
import { CreateChangeOrderExecutionHandler } from '../../src/proposals/execution/create-change-order-handler';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal, VALID_PROPOSAL_TYPES, actionClassForProposalType } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';

const TENANT = 't-1';
const OTHER_TENANT = 't-2';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'create_change_order',
    status: 'approved',
    payload: {
      jobId: JOB_ID,
      title: 'Change order — add second zone',
      lineItems: [{ description: 'Second zone', quantity: 1, unitPriceCents: 180000 }],
    },
    summary: 'Change order on JOB-0001',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('create_change_order proposal type', () => {
  it('is a valid proposal type classified as capture', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('create_change_order');
    expect(actionClassForProposalType('create_change_order')).toBe('capture');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('create_change_order', {
      jobId: JOB_ID,
      title: 'Change order — add second zone',
      lineItems: [{ description: 'Second zone', quantity: 1, unitPriceCents: 180000 }],
    });
    expect(result.valid).toBe(true);
  });

  // The whole point of this type: without a jobId it is indistinguishable
  // from a fresh bid, so it must be REQUIRED, not optional like
  // draft_estimate's.
  it('rejects a payload missing jobId', () => {
    const result = validateProposalPayload('create_change_order', {
      title: 'Change order — add second zone',
      lineItems: [{ description: 'Second zone', quantity: 1, unitPriceCents: 180000 }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a payload with an empty lineItems array', () => {
    const result = validateProposalPayload('create_change_order', {
      jobId: JOB_ID,
      title: 'Change order — add second zone',
      lineItems: [],
    });
    expect(result.valid).toBe(false);
  });

  // Quality-review CRITICAL fix — the contract must declare (not just
  // tolerate) the catalog-grounding passthrough fields, or Zod's
  // strip-mode silently deletes them before they ever reach
  // normalizeDraftLineItems. See the execution-handler describe block
  // below for the persisted-row round trip.
  it('accepts a catalog-grounded line item carrying pricingSource/unit/category/catalogItemId/totalCents', () => {
    const result = validateProposalPayload('create_change_order', {
      jobId: JOB_ID,
      title: 'Change order — add second zone',
      lineItems: [
        {
          description: 'Second zone install',
          quantity: 1,
          unitPriceCents: 175000,
          totalCents: 175000,
          unit: 'each',
          category: 'labor',
          catalogItemId: '99999999-9999-4999-8999-999999999999',
          pricingSource: 'catalog',
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload missing title', () => {
    const result = validateProposalPayload('create_change_order', {
      jobId: JOB_ID,
      lineItems: [{ description: 'Second zone', quantity: 1, unitPriceCents: 180000 }],
    });
    expect(result.valid).toBe(false);
  });
});

describe('CreateChangeOrderExecutionHandler', () => {
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  function wired(auditRepo?: InMemoryAuditRepository) {
    const estimateRepo = new InMemoryEstimateRepository();
    const settingsRepo = new InMemorySettingsRepository();
    return {
      estimateRepo,
      settingsRepo,
      handler: new CreateChangeOrderExecutionHandler(estimateRepo, settingsRepo, auditRepo),
    };
  }

  it('degrades to a synthetic-id passthrough when no estimateRepo is wired', async () => {
    const handler = new CreateChangeOrderExecutionHandler();
    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('degrades to a synthetic-id passthrough when estimateRepo is wired but settingsRepo is not (estimate numbering unavailable)', async () => {
    const handler = new CreateChangeOrderExecutionHandler(new InMemoryEstimateRepository());
    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('isFullyWired requires BOTH estimateRepo and settingsRepo', () => {
    const estimateRepo = new InMemoryEstimateRepository();
    const settingsRepo = new InMemorySettingsRepository();
    expect(new CreateChangeOrderExecutionHandler(estimateRepo, settingsRepo).isFullyWired()).toBe(true);
    expect(new CreateChangeOrderExecutionHandler(estimateRepo).isFullyWired()).toBe(false);
    expect(new CreateChangeOrderExecutionHandler(undefined, settingsRepo).isFullyWired()).toBe(false);
    expect(new CreateChangeOrderExecutionHandler().isFullyWired()).toBe(false);
  });

  it('fails cleanly on an invalid payload (missing jobId) without throwing', async () => {
    const { handler } = wired();
    const result = await handler.execute(
      makeProposal({ payload: { title: 'Change order', lineItems: [{ description: 'x', quantity: 1 }] } }),
      ctx,
    );
    expect(result.success).toBe(false);
  });

  it('creates an estimate flagged isChangeOrder and linked to the job', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { estimateRepo, handler } = wired(auditRepo);

    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const stored = await estimateRepo.findById(TENANT, result.resultEntityId!);
    expect(stored).toBeDefined();
    expect(stored!.jobId).toBe(JOB_ID);
    expect(stored!.isChangeOrder).toBe(true);
    expect(stored!.estimateNumber).toBeTruthy();
    expect(stored!.lineItems).toHaveLength(1);
    expect(stored!.lineItems[0].description).toBe('Second zone');
    expect(stored!.lineItems[0].unitPriceCents).toBe(180000);
    expect(stored!.internalNotes).toContain('Change order — add second zone');
    expect(stored!.internalNotes).toContain('prop-1');
  });

  it('prefixes a title with "Change order — " when the drafting layer did not', async () => {
    const { estimateRepo, handler } = wired();

    const result = await handler.execute(
      makeProposal({
        payload: {
          jobId: JOB_ID,
          title: 'Add second zone',
          lineItems: [{ description: 'Second zone', quantity: 1, unitPriceCents: 180000 }],
        },
      }),
      ctx,
    );
    expect(result.success).toBe(true);

    const stored = await estimateRepo.findById(TENANT, result.resultEntityId!);
    expect(stored!.internalNotes).toContain('Change order — Add second zone');
  });

  it('carries an optional customerMessage onto the estimate', async () => {
    const { estimateRepo, handler } = wired();

    const result = await handler.execute(
      makeProposal({
        payload: {
          jobId: JOB_ID,
          title: 'Change order — add second zone',
          lineItems: [{ description: 'Second zone', quantity: 1, unitPriceCents: 180000 }],
          customerMessage: 'Adding a second zone as discussed on site.',
        },
      }),
      ctx,
    );
    const stored = await estimateRepo.findById(TENANT, result.resultEntityId!);
    expect(stored!.customerMessage).toBe('Adding a second zone as discussed on site.');
  });

  it('emits an estimate.change_order_created audit event carrying proposalId/jobId, and NOT the generic estimate.created event', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { handler } = wired(auditRepo);

    const result = await handler.execute(makeProposal(), ctx);

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('estimate.change_order_created');
    expect(events[0].entityType).toBe('estimate');
    expect(events[0].entityId).toBe(result.resultEntityId);
    expect(events[0].metadata).toMatchObject({
      proposalId: 'prop-1',
      proposalType: 'create_change_order',
      jobId: JOB_ID,
    });
  });

  // Quality-review CRITICAL fix — changeOrderLineItemSchema (contracts/
  // create-change-order.ts) originally declared only {description,
  // quantity, unitPriceCents}; Zod's strip-mode dropped every other field
  // BEFORE normalizeDraftLineItems ever saw them, so a catalog-grounded
  // line's pricingSource/unit/category were silently NULL on the persisted
  // row — destroying the AI-invented-vs-catalog-grounded audit signal for
  // every change order. This regression guard reads the PERSISTED row back
  // (not just the payload) to prove the round trip.
  //
  // `catalogItemId` is declared on the contract too (so it survives on the
  // PAYLOAD for the review UI's one-tap ambiguity resolution — the exact
  // reason `contracts.ts`'s shared `lineItemSchema` declares it), but — like
  // every other estimate-creating path in this codebase — it is NOT a
  // persisted `LineItem` field at all (no `catalog_item_id` column exists on
  // `estimate_line_items`; `normalizeDraftLineItems` never forwards it
  // either, matching `draft_estimate`'s own behavior). `pricingSource` is
  // the durable grounding signal that survives to the row.
  it('preserves catalog-grounding metadata (pricingSource/unit/category/totalCents) through to the PERSISTED row', async () => {
    const { estimateRepo, handler } = wired();
    const catalogItemId = '99999999-9999-4999-8999-999999999999';

    const result = await handler.execute(
      makeProposal({
        payload: {
          jobId: JOB_ID,
          title: 'Change order — add second zone',
          lineItems: [
            {
              description: 'Second zone install',
              quantity: 1,
              unitPriceCents: 175000,
              totalCents: 175000,
              unit: 'each',
              category: 'labor',
              catalogItemId,
              pricingSource: 'catalog',
            },
          ],
        },
      }),
      ctx,
    );
    expect(result.success).toBe(true);

    const stored = await estimateRepo.findById(TENANT, result.resultEntityId!);
    const line = stored!.lineItems[0];
    expect(line.pricingSource).toBe('catalog');
    expect(line.unit).toBe('each');
    expect(line.category).toBe('labor');
    expect(line.totalCents).toBe(175000);
  });

  // Quality-review fix — a line with NO resolvable unitPriceCents at all
  // (contract-legal: the field is optional pre-grounding) must still fail
  // cleanly at execution rather than silently persisting a priceless line.
  // The drafting task now gates this case before it ever reaches approval
  // (ai/tasks/create-change-order-task.test.ts), but this proves the
  // execution-side backstop independently — e.g. a hand-edited proposal
  // payload that skipped the drafting task entirely.
  it('rejects a line item with no resolvable unitPriceCents ("can\'t be priced"), no mutation', async () => {
    const { estimateRepo, handler } = wired();

    const result = await handler.execute(
      makeProposal({
        payload: {
          jobId: JOB_ID,
          title: 'Change order — add second zone',
          lineItems: [{ description: 'Second zone', quantity: 1 }],
        },
      }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/can't be priced/i);
    expect(await estimateRepo.findByJob(TENANT, JOB_ID)).toHaveLength(0);
  });

  // Quality-review fix — the double-prefix bug: the drafting task's bare
  // 'Change order' fallback (no description spoken) previously tripped a
  // naive `startsWith('Change order — ')` re-prefix check into
  // "Change order — Change order — created from voice change-order
  // proposal <id>". ensureChangeOrderTitle is idempotent against this
  // exact bare string — pinned end-to-end through execution here.
  it('does NOT double-prefix the bare "Change order" title the drafting task emits when no description was spoken', async () => {
    const { estimateRepo, handler } = wired();

    const result = await handler.execute(
      makeProposal({
        payload: {
          jobId: JOB_ID,
          title: 'Change order',
          lineItems: [{ description: 'Additional work', quantity: 1, unitPriceCents: 180000 }],
        },
      }),
      ctx,
    );
    expect(result.success).toBe(true);

    const stored = await estimateRepo.findById(TENANT, result.resultEntityId!);
    expect(stored!.internalNotes).toContain('Change order — created from voice change-order proposal prop-1');
    expect(stored!.internalNotes).not.toContain('Change order — Change order');
  });

  it('tenant isolation — a change order cannot be created for another tenant’s repo view', async () => {
    const { estimateRepo, handler } = wired();

    const result = await handler.execute(makeProposal(), { tenantId: OTHER_TENANT, executedBy: 'u-2' });
    expect(result.success).toBe(true);

    // Created under OTHER_TENANT, so it must be invisible from TENANT's view.
    const seenFromOriginalTenant = await estimateRepo.findById(TENANT, result.resultEntityId!);
    expect(seenFromOriginalTenant).toBeNull();
    const seenFromOwnTenant = await estimateRepo.findById(OTHER_TENANT, result.resultEntityId!);
    expect(seenFromOwnTenant).toBeDefined();
  });
});
