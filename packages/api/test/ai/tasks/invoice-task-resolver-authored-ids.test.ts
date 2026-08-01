/**
 * QA-2026-07-28 — the model never authors entity ids on a drafted INVOICE.
 *
 * Live bug (Development, voice run): `draft_invoice` proposals carried garbage
 * in `customerId`/`jobId` because INVOICE_SYSTEM_PROMPT handed the model
 * `"customerId": "<uuid>"` and `"jobId": "<uuid>"` templates and closed with
 * "Ensure customerId and jobId are present". Observed values, verbatim from
 * the dev database:
 *
 *     "unknown"
 *     "<uuid>"
 *     "123e4567-e89b-12d3-a456-426614174000"
 *
 * This is the same defect fixed on the estimate path in 7fd370e4, but it
 * matters MORE here on three counts:
 *
 *   1. `draftInvoicePayloadSchema.customerId` was a REQUIRED
 *      `z.string().uuid()`, so the model was *obliged* to produce an id it
 *      cannot know.
 *   2. An invoice is a money proposal.
 *   3. `CreateInvoiceExecutionHandler` auto-opens a JOB from `customerId`, and
 *      writes `jobId` straight onto the invoice as its job container — a
 *      fabricated jobId also SKIPS the auto-open path entirely.
 *
 * The third observed value is the RFC 4122 §C.1 EXAMPLE uuid. It is
 * SYNTACTICALLY VALID, so `z.string().uuid()` waves it through and any fix
 * built on format validation alone is worthless. The fix is authorship: ids
 * come from the entity resolver (voice-action-router's
 * `annotateResolvedEntities`), which has already matched the spoken reference
 * against tenant-scoped records.
 */
import { describe, it, expect, vi } from 'vitest';
import { InvoiceTaskHandler, INVOICE_SYSTEM_PROMPT } from '../../../src/ai/tasks/invoice-task';
import { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { validateProposalPayload } from '../../../src/proposals/contracts';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../../src/catalog/catalog-item';

const RESOLVED_CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const RESOLVED_JOB_ID = '9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f';
const RESOLVED_ESTIMATE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** RFC 4122 §C.1 example uuid — well-formed, references nothing. */
const RFC_EXAMPLE_UUID = '123e4567-e89b-12d3-a456-426614174000';

/**
 * Every value the live model actually put in these fields. 'unknown' and
 * '<uuid>' are caught by format; RFC_EXAMPLE_UUID is NOT, and is the whole
 * reason this suite exists.
 */
const HALLUCINATED = ['unknown', '<uuid>', RFC_EXAMPLE_UUID];

interface Captured {
  gateway: LLMGateway;
  lastRequest: () => LLMRequest;
}

function makeGateway(responseContent: string): Captured {
  const complete = vi.fn().mockImplementation(
    async (): Promise<LLMResponse> => ({
      content: responseContent,
      model: 'test-model',
      provider: 'test-provider',
      tokenUsage: { input: 10, output: 20, total: 30 },
      latencyMs: 1,
    }),
  );
  return {
    gateway: { complete } as unknown as LLMGateway,
    lastRequest: () => complete.mock.calls[0][0] as LLMRequest,
  };
}

function context(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 'tenant-1',
    message: 'Invoice the Henderson place for the water heater install',
    conversationId: 'conv-1',
    userId: 'user-1',
    customerId: RESOLVED_CUSTOMER_ID,
    ...overrides,
  };
}

/** A catalog that prices the drafted line, so nothing else caps confidence. */
function groundedCatalog(): InMemoryCatalogItemRepository {
  const repo = new InMemoryCatalogItemRepository();
  void repo.create(
    createCatalogItem({
      tenantId: 'tenant-1',
      name: 'Water Heater Install',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: 185_000,
    }),
  );
  return repo;
}

/** The model's JSON, with whatever ids we want to prove are discarded. */
function invoiceJson(ids: Record<string, string>, confidence = 0.95): string {
  return JSON.stringify({
    ...ids,
    lineItems: [{ description: 'Water Heater Install', quantity: 1, unitPrice: 185_000 }],
    confidence_score: confidence,
  });
}

describe('QA-2026-07-28 — the prompt no longer asks the model for entity ids', () => {
  it('strips the id templates and the "ensure … present" instruction', async () => {
    const { gateway, lastRequest } = makeGateway(invoiceJson({}));
    await new InvoiceTaskHandler(gateway).handle(context());

    const system = lastRequest().messages.find((m) => m.role === 'system')!.content;
    expect(system).toBe(INVOICE_SYSTEM_PROMPT);

    // The three id templates are gone…
    expect(system).not.toContain('"customerId": "<uuid>"');
    expect(system).not.toContain('"jobId": "<uuid>"');
    expect(system).not.toContain('"estimateId": "<uuid, optional>"');
    // …as is the instruction that FORCED the model to invent them.
    expect(system).not.toContain('Ensure customerId and jobId are present');
    // …and the model is told explicitly why it must not emit one.
    expect(system).toContain('Never output a "customerId", "jobId", or "estimateId" field');
    expect(system).toContain('verified tenant records');
    // No "<uuid>" placeholder of any kind survives.
    expect(system).not.toContain('<uuid');
  });
});

describe('QA-2026-07-28 — customerId is authored by the resolver, never the model', () => {
  for (const garbage of HALLUCINATED) {
    it(`discards a model-invented customerId (${garbage}) in favour of the resolved one`, async () => {
      const { gateway } = makeGateway(invoiceJson({ customerId: garbage }));
      const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

      const { proposal } = await handler.handle(context());

      expect(proposal.payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
      expect(proposal.payload.customerId).not.toBe(garbage);
      expect(proposal.payload.customerReference).toBeUndefined();
    });

    it(`never emits a model-invented customerId (${garbage}) when nothing resolved`, async () => {
      const { gateway } = makeGateway(invoiceJson({ customerId: garbage }));
      const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

      const { proposal } = await handler.handle(
        context({
          customerId: undefined,
          existingEntities: { customerName: 'the Henderson place' },
        }),
      );

      // No fake id — the spoken reference rides instead (the
      // customerId-or-customerReference convention shared with
      // addServiceLocation / convertLead).
      expect(proposal.payload.customerId).toBeUndefined();
      expect(proposal.payload.customerReference).toBe('the Henderson place');
      expect(JSON.stringify(proposal.payload)).not.toContain(garbage);

      // …and the unresolved variant is forced non-auto-approvable, despite the
      // model's 0.95 and a fully catalog-grounded line. This is the money gate.
      expect(proposal.status).toBe('draft');
      expect(proposal.status).not.toBe('approved');
      const ctx = proposal.sourceContext as Record<string, unknown>;
      expect(ctx.missingFields).toContain('customerId');
    });
  }

  it('the RFC example uuid is not distinguishable by format — only authorship saves us', () => {
    // Pinning the crux: this string passes `z.string().uuid()`, so the schema
    // alone accepts a drafted invoice that references nothing.
    const result = validateProposalPayload('draft_invoice', {
      customerId: RFC_EXAMPLE_UUID,
      lineItems: [{ description: 'Water Heater Install', quantity: 1, unitPrice: 185_000 }],
    });
    expect(result.valid).toBe(true);
  });

  it('the RFC example uuid never reaches the payload, from either field', async () => {
    const { gateway } = makeGateway(
      invoiceJson({
        customerId: RFC_EXAMPLE_UUID,
        jobId: RFC_EXAMPLE_UUID,
        estimateId: RFC_EXAMPLE_UUID,
      }),
    );
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(context({ customerId: undefined }));

    expect(proposal.payload.customerId).toBeUndefined();
    expect(proposal.payload.jobId).toBeUndefined();
    expect(proposal.payload.estimateId).toBeUndefined();
    expect(JSON.stringify(proposal.payload)).not.toContain('123e4567');
  });

  it('resolver-supplied customerId on existingEntities is honoured (voice-action-router path)', async () => {
    // voice-action-router places the resolved id on BOTH context.customerId
    // and existingEntities.customerId; the latter alone must be enough.
    const { gateway } = makeGateway(invoiceJson({ customerId: '<uuid>' }));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(
      context({
        customerId: undefined,
        existingEntities: { customerName: 'Henderson', customerId: RESOLVED_CUSTOMER_ID },
      }),
    );

    expect(proposal.payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(proposal.payload.customerReference).toBeUndefined();
  });

  it('happy path — a resolved customer flows onto the payload and can auto-approve', async () => {
    const { gateway } = makeGateway(invoiceJson({ customerId: 'unknown' }));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(context());

    expect(proposal.payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(proposal.sourceContext?.missingFields).toBeUndefined();
    expect(proposal.status).toBe('approved');
  });
});

describe('QA-2026-07-28 — jobId / estimateId are authored by the resolver too', () => {
  for (const garbage of HALLUCINATED) {
    it(`discards a model-invented jobId (${garbage}) in favour of the resolved one`, async () => {
      const { gateway } = makeGateway(invoiceJson({ jobId: garbage }));
      const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

      const { proposal } = await handler.handle(
        context({ existingEntities: { jobId: RESOLVED_JOB_ID } }),
      );

      expect(proposal.payload.jobId).toBe(RESOLVED_JOB_ID);
      expect(proposal.payload.jobId).not.toBe(garbage);
    });

    it(`drops a model-invented jobId (${garbage}) entirely when nothing resolved`, async () => {
      const { gateway } = makeGateway(invoiceJson({ jobId: garbage }));
      const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

      const { proposal } = await handler.handle(context());

      // Absent, NOT fabricated. A present jobId bypasses the execution
      // handler's auto-open-a-job path and is written straight onto the
      // invoice, so a fake one is strictly worse than none.
      expect(proposal.payload.jobId).toBeUndefined();
      expect(JSON.stringify(proposal.payload)).not.toContain(garbage);
    });
  }

  it('discards a model-invented estimateId and honours the resolved one', async () => {
    const { gateway } = makeGateway(invoiceJson({ estimateId: RFC_EXAMPLE_UUID }));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(
      context({ existingEntities: { estimateId: RESOLVED_ESTIMATE_ID } }),
    );

    expect(proposal.payload.estimateId).toBe(RESOLVED_ESTIMATE_ID);
  });

  /**
   * DECISION (see the comment in invoice-task.ts `handle()`): an unresolved
   * job is NOT a `missingFields` entry.
   *
   * B6 deliberately made `jobId` optional on the contract and taught
   * CreateInvoiceExecutionHandler to auto-open a job for the resolved customer
   * when the payload has none ("invoice the Smith account"). Gating on jobId
   * here would force every job-reference-free invoice to 'draft' — a behavior
   * regression unrelated to this bug, and one that would make the fix look
   * like it broke invoicing. Absence is safe and recoverable at execution;
   * fabrication is neither, which is why only fabrication is closed off.
   */
  it('an unresolved job does NOT gate the proposal — the executor opens one', async () => {
    const { gateway } = makeGateway(invoiceJson({ jobId: RFC_EXAMPLE_UUID }));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(context());

    expect(proposal.payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(proposal.payload.jobId).toBeUndefined();
    // No jobId gate: a customer-only invoice stays auto-approvable exactly as
    // it was before this fix.
    expect(proposal.sourceContext?.missingFields).toBeUndefined();
    expect(proposal.status).toBe('approved');
  });

  it('an unresolved CUSTOMER still gates, even when a job resolved', async () => {
    // VOX-07 lets the execution handler proceed on a jobId alone, but a draft
    // that names nobody must still be reviewed — the operator has to confirm
    // whose money this is.
    const { gateway } = makeGateway(invoiceJson({ customerId: RFC_EXAMPLE_UUID }));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(
      context({
        customerId: undefined,
        existingEntities: { customerName: 'Henderson', jobId: RESOLVED_JOB_ID },
      }),
    );

    expect(proposal.payload.jobId).toBe(RESOLVED_JOB_ID);
    expect(proposal.payload.customerId).toBeUndefined();
    expect(proposal.payload.customerReference).toBe('Henderson');
    expect(proposal.status).toBe('draft');
    expect((proposal.sourceContext as Record<string, unknown>).missingFields).toContain(
      'customerId',
    );
  });
});

describe('P2-002 — the mandatory payload contract gate on draft_invoice', () => {
  it('blocks approval instead of throwing the turn away', async () => {
    // assertValidProposalPayload is documented as MANDATORY before
    // createProposal. On this live-voice handler a rejected payload must still
    // surface a reviewable draft, so the gate is enforced as a forced 'draft'
    // + recorded errors rather than an exception.
    const { gateway } = makeGateway(JSON.stringify({ internalNotes: 'no line items at all' }));
    const handler = new InvoiceTaskHandler(gateway);

    const { proposal } = await handler.handle(context());

    expect(proposal.status).toBe('draft');
    const ctx = proposal.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toContain('lineItems');
    expect(proposal.confidenceFactors).toContain('payload_contract_violation');
    expect(Array.isArray(ctx.payloadContractErrors)).toBe(true);
    expect(proposal.confidenceScore).toBeLessThanOrEqual(0.5);
  });

  it('unparseable model output still yields a reviewable draft, never a throw', async () => {
    const { gateway } = makeGateway('not json at all');
    const handler = new InvoiceTaskHandler(gateway);

    const { proposal } = await handler.handle(context());

    expect(proposal.status).toBe('draft');
    expect(proposal.payload.lineItems).toEqual([]);
    expect(proposal.confidenceFactors).toContain('payload_contract_violation');
  });

  it('the drafted payload from a resolved customer SATISFIES the contract', async () => {
    // The gate is only useful if the normal path passes it — otherwise every
    // live invoice would silently land in draft and nobody would notice the
    // gate was misconfigured.
    const { gateway } = makeGateway(invoiceJson({}));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(
      context({ existingEntities: { jobId: RESOLVED_JOB_ID } }),
    );

    expect(validateProposalPayload('draft_invoice', proposal.payload).valid).toBe(true);
    expect(proposal.confidenceFactors).not.toContain('payload_contract_violation');
  });

  it('an unresolved draft carrying only customerReference also satisfies the contract', async () => {
    // The customerId-or-customerReference `.refine`: the gated draft must be a
    // VALID payload, not a second contract violation.
    const { gateway } = makeGateway(invoiceJson({}));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(
      context({ customerId: undefined, existingEntities: { customerName: 'Henderson' } }),
    );

    expect(validateProposalPayload('draft_invoice', proposal.payload).valid).toBe(true);
    expect(proposal.confidenceFactors).not.toContain('payload_contract_violation');
    // Gated by missingFields, not by a contract failure.
    expect((proposal.sourceContext as Record<string, unknown>).missingFields).toEqual([
      'customerId',
    ]);
  });

  it('a payload with NEITHER a resolved id nor a spoken name fails the refine and is gated', async () => {
    const { gateway } = makeGateway(invoiceJson({ customerId: RFC_EXAMPLE_UUID }));
    const handler = new InvoiceTaskHandler(gateway, groundedCatalog());

    const { proposal } = await handler.handle(
      context({ customerId: undefined, existingEntities: {} }),
    );

    expect(proposal.payload.customerId).toBeUndefined();
    expect(proposal.payload.customerReference).toBeUndefined();
    expect(validateProposalPayload('draft_invoice', proposal.payload).valid).toBe(false);
    expect(proposal.status).toBe('draft');
    expect(proposal.confidenceFactors).toContain('payload_contract_violation');
    expect((proposal.sourceContext as Record<string, unknown>).missingFields).toContain(
      'customerId',
    );
  });
});
