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
    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-5' });
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
});
