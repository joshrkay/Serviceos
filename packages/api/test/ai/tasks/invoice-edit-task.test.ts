/**
 * InvoiceEditTaskHandler unit tests.
 *
 * AI task that takes a voice transcript describing an invoice edit
 * ("add a water heater install to invoice INV-0042") and produces a
 * proposal with a structured editActions payload.
 *
 * The invoice resolution step (transcript reference → real invoice id)
 * is deferred to the execution handler / operator review. At the
 * proposal-creation stage the task simply records what the LLM parsed
 * out. If the LLM can't extract enough, confidence drops and the
 * operator sees a low-confidence proposal to disambiguate.
 */
import { describe, it, expect, vi } from 'vitest';
import { InvoiceEditTaskHandler } from '../../../src/ai/tasks/invoice-edit-task';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import type { Invoice } from '../../../src/invoices/invoice';
import { calculateDocumentTotals } from '../../../src/shared/billing-engine';
import { approveProposal } from '../../../src/proposals/actions';
import { InMemoryProposalRepository, missingFieldsFor } from '../../../src/proposals/proposal';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 100, output: 60, total: 160 },
      latencyMs: 44,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

describe('InvoiceEditTaskHandler', () => {
  const tenantId = 't-1';
  const userId = 'u-1';

  it('produces an update_invoice proposal with a single add_line_item', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Water heater install', quantity: 1, unitPrice: 85000 },
          },
        ],
        confidence_score: 0.9,
      })
    );

    const handler = new InvoiceEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Add a water heater install for 850 dollars to invoice INV-0042',
    });

    expect(result.taskType).toBe('update_invoice');
    expect(result.proposal.proposalType).toBe('update_invoice');
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.invoiceReference).toBe('INV-0042');
    expect(Array.isArray(payload.editActions)).toBe(true);
    expect((payload.editActions as unknown[]).length).toBe(1);
  });

  it('produces a remove_line_item action when asked to remove', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          { type: 'remove_line_item', description: 'plumbing repair' },
        ],
        confidence_score: 0.85,
      })
    );
    const handler = new InvoiceEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Remove the plumbing repair from invoice INV-0042',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    const actions = payload.editActions as Array<Record<string, unknown>>;
    expect(actions[0].type).toBe('remove_line_item');
    expect(actions[0].description).toBe('plumbing repair');
  });

  it('supports multiple edit actions in a single transcript', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 },
          },
          { type: 'remove_line_item', description: 'diagnostic' },
        ],
        confidence_score: 0.82,
      })
    );
    const handler = new InvoiceEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Add a trip fee and remove the diagnostic from INV-0042',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect((payload.editActions as unknown[]).length).toBe(2);
  });

  it('falls back to empty editActions when LLM output is unparseable', async () => {
    const gateway = mockGateway('not json');
    const handler = new InvoiceEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'do something to the invoice',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.editActions).toEqual([]);
    // Operator will see this as low confidence and discard.
    expect(result.proposal.confidenceScore ?? 1).toBeLessThan(0.9);
  });

  it('threads conversationId into sourceContext', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'fee', quantity: 1, unitPrice: 500 },
          },
        ],
        confidence_score: 0.9,
      })
    );
    const handler = new InvoiceEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'add a fee',
      conversationId: 'conv-5',
    });
    // PR review finding (2026-07): a free-text invoiceReference with no
    // invoiceRepo wired now gates missingFields — this proposal used to be
    // silently approvable and then fail at execution (doomed-approval →
    // gated is strictly safer; see the "invoiceId resolution" describe
    // block below).
    expect(result.proposal.sourceContext).toEqual({
      conversationId: 'conv-5',
      missingFields: ['invoiceId'],
    });
  });

  it('sends update_invoice as the LLM task type', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'fee', quantity: 1, unitPrice: 500 },
          },
        ],
        confidence_score: 0.9,
      })
    );
    const handler = new InvoiceEditTaskHandler(gateway);
    await handler.handle({ tenantId, userId, message: 'add a fee' });
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.taskType).toBe('update_invoice');
    expect(call.responseFormat).toBe('json');
  });

  // PR review finding (2026-07): UpdateInvoiceExecutionHandler
  // (proposals/execution/update-invoice-handler.ts) strictly requires
  // payload.invoiceId to already be a string id and has no reference
  // resolution of its own. Previously this handler never set invoiceId and
  // never gated missingFields, so "add a trip fee to invoice INV-0042" was
  // approvable straight from drafting and execution then failed on the
  // unresolved reference. Mirrors the send_invoice fix
  // (voice-extended-tasks.ts): reference resolution now runs at drafting
  // time and an unresolved reference gates the proposal.
  describe('invoiceId resolution / missingFields gating', () => {
    function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
      const lineItems = [
        {
          id: 'li-1',
          description: 'Service call',
          quantity: 1,
          unitPriceCents: 12500,
          totalCents: 12500,
          taxable: true,
        },
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 0);
      return {
        id: 'inv-1',
        tenantId,
        jobId: 'job-1',
        invoiceNumber: 'INV-0042',
        status: 'draft',
        lineItems,
        totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: userId,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
        ...overrides,
      };
    }

    function editGateway(invoiceReference = 'INV-0042'): LLMGateway {
      return mockGateway(
        JSON.stringify({
          invoiceReference,
          editActions: [
            { type: 'add_line_item', lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 } },
          ],
          confidence_score: 0.9,
        }),
      );
    }

    it('an unresolvable free-text reference (no invoiceRepo wired) gates missingFields and blocks approval', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const handler = new InvoiceEditTaskHandler(editGateway(), {});
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to invoice INV-0042',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.invoiceId).toBeUndefined();
      expect(payload.invoiceReference).toBe('INV-0042');
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['invoiceId'] });

      await proposalRepo.create(result.proposal);
      await expect(
        approveProposal(proposalRepo, tenantId, result.proposal.id, userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    });

    it('a reference that resolves to exactly one invoice via invoiceRepo search is stamped onto payload.invoiceId, but STAYS gated', async () => {
      // See resolveInvoiceId's doc comment in invoice-edit-task.ts: a
      // search-resolved id is deliberately still gated because
      // assistant.ts's dropUnverifiedIds strips any id-shaped payload
      // field that isn't literally present in the operator's raw text —
      // a DB-resolved id from a free-text search never is. Only a
      // reference that is already a literal UUID is trusted to bypass
      // review (next test).
      const invoiceRepo = new InMemoryInvoiceRepository();
      const invoice = await invoiceRepo.create(makeInvoice());

      const proposalRepo = new InMemoryProposalRepository();
      const handler = new InvoiceEditTaskHandler(editGateway(), { invoiceRepo });
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to invoice INV-0042',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.invoiceId).toBe(invoice.id);
      expect(payload.invoiceReference).toBe('INV-0042');
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['invoiceId'] });

      await proposalRepo.create(result.proposal);
      await expect(
        approveProposal(proposalRepo, tenantId, result.proposal.id, userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    });

    it('an ambiguous reference (>1 match via invoiceRepo search) gates missingFields and does not set invoiceId', async () => {
      const invoiceRepo = new InMemoryInvoiceRepository();
      // Same invoice number on two rows is the simplest way to force >1
      // search hits for this in-memory repo's ILIKE-style match.
      await invoiceRepo.create(makeInvoice({ id: 'inv-1', invoiceNumber: 'INV-0042' }));
      await invoiceRepo.create(makeInvoice({ id: 'inv-2', invoiceNumber: 'INV-0042' }));

      const handler = new InvoiceEditTaskHandler(editGateway(), { invoiceRepo });
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to invoice INV-0042',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.invoiceId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['invoiceId'] });
    });

    it('an already-UUID reference lands directly on payload.invoiceId with no gate', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const uuidRef = '00000000-0000-4000-8000-000000000042';
      const handler = new InvoiceEditTaskHandler(editGateway(uuidRef), {});
      const result = await handler.handle({
        tenantId,
        userId,
        message: `Add a trip fee to invoice ${uuidRef}`,
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.invoiceId).toBe(uuidRef);
      expect(result.proposal.sourceContext ?? {}).not.toHaveProperty('missingFields');

      // Approval is not blocked by a missing invoiceId (may still be
      // gated by other rules, e.g. uncatalogued pricing — not the concern
      // of this test); the key assertion is missingFields is absent.
      await proposalRepo.create(result.proposal);
    });

    it('a reference that matches zero invoices gates missingFields and does not set invoiceId', async () => {
      const invoiceRepo = new InMemoryInvoiceRepository();
      // Repo has invoices, but none matching "INV-0042".
      await invoiceRepo.create(makeInvoice({ id: 'inv-9', invoiceNumber: 'INV-9999' }));

      const handler = new InvoiceEditTaskHandler(editGateway(), { invoiceRepo });
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to invoice INV-0042',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.invoiceId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['invoiceId'] });
    });

    // B2 — the same search that identifies (or fails to identify) a single
    // unambiguous match now also doubles as the AmbiguityPicker's candidate
    // list. The gate above is untouched by any of this.
    describe('B2 candidatesForReference', () => {
      it('an ambiguous reference (>1 match) records candidates on sourceContext while staying gated', async () => {
        const invoiceRepo = new InMemoryInvoiceRepository();
        const invA = await invoiceRepo.create(makeInvoice({ id: 'inv-1', invoiceNumber: 'INV-0042' }));
        const invB = await invoiceRepo.create(makeInvoice({ id: 'inv-2', invoiceNumber: 'INV-0042' }));

        const handler = new InvoiceEditTaskHandler(editGateway(), { invoiceRepo });
        const result = await handler.handle({
          tenantId,
          userId,
          message: 'Add a trip fee to invoice INV-0042',
        });

        const payload = result.proposal.payload as Record<string, unknown>;
        expect(payload.invoiceId).toBeUndefined();
        expect(missingFieldsFor(result.proposal)).toContain('invoiceId');

        const sc = result.proposal.sourceContext as Record<string, unknown>;
        expect(sc.entityKind).toBe('invoice');
        expect(sc.entityReference).toBe('INV-0042');
        const candidates = sc.entityCandidates as Array<Record<string, unknown>>;
        expect(candidates.map((c) => c.id).sort()).toEqual([invA.id, invB.id].sort());
        expect(candidates.every((c) => c.kind === 'invoice')).toBe(true);
      });

      it('a single unambiguous match records ONE candidate while STAYING gated (search-resolved ≠ ungated)', async () => {
        const invoiceRepo = new InMemoryInvoiceRepository();
        const invoice = await invoiceRepo.create(makeInvoice());

        const handler = new InvoiceEditTaskHandler(editGateway(), { invoiceRepo });
        const result = await handler.handle({
          tenantId,
          userId,
          message: 'Add a trip fee to invoice INV-0042',
        });

        expect(missingFieldsFor(result.proposal)).toContain('invoiceId');
        const sc = result.proposal.sourceContext as Record<string, unknown>;
        expect(sc.entityCandidates).toEqual([
          expect.objectContaining({ id: invoice.id, kind: 'invoice', label: 'INV-0042' }),
        ]);
      });

      it('zero-match search → gate present, no candidates recorded', async () => {
        const invoiceRepo = new InMemoryInvoiceRepository();
        await invoiceRepo.create(makeInvoice({ id: 'inv-9', invoiceNumber: 'INV-9999' }));

        const handler = new InvoiceEditTaskHandler(editGateway(), { invoiceRepo });
        const result = await handler.handle({
          tenantId,
          userId,
          message: 'Add a trip fee to invoice INV-0042',
        });

        expect(missingFieldsFor(result.proposal)).toContain('invoiceId');
        const sc = result.proposal.sourceContext as Record<string, unknown> | undefined;
        expect(sc?.entityCandidates).toBeUndefined();
      });

      it('a non-UUID reference with no invoiceRepo wired stays gated with no candidates', async () => {
        const handler = new InvoiceEditTaskHandler(editGateway(), {});
        const result = await handler.handle({
          tenantId,
          userId,
          message: 'Add a trip fee to invoice INV-0042',
        });

        expect(missingFieldsFor(result.proposal)).toContain('invoiceId');
        const sc = result.proposal.sourceContext as Record<string, unknown> | undefined;
        expect(sc?.entityCandidates).toBeUndefined();
      });

      it('an already-UUID reference bypasses the gate — no candidate search attempted', async () => {
        const uuidRef = '00000000-0000-4000-8000-000000000042';
        const invoiceRepo = new InMemoryInvoiceRepository();
        const findByTenantSpy = vi.spyOn(invoiceRepo, 'findByTenant');

        const handler = new InvoiceEditTaskHandler(editGateway(uuidRef), { invoiceRepo });
        const result = await handler.handle({
          tenantId,
          userId,
          message: `Add a trip fee to invoice ${uuidRef}`,
        });

        expect(findByTenantSpy).not.toHaveBeenCalled();
        expect(result.proposal.sourceContext ?? {}).not.toHaveProperty('entityCandidates');
        expect(missingFieldsFor(result.proposal)).not.toContain('invoiceId');
      });
    });
  });
});
