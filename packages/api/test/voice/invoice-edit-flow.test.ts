/**
 * End-to-end integration for Phase 2.
 *
 * Voice transcript → classifier → InvoiceEditTaskHandler → proposal
 * persisted → UpdateInvoiceExecutionHandler runs → real InMemory
 * invoice mutated.
 *
 * Only the LLM is mocked. Every other seam is production code.
 * The test drives the execution handler directly with the invoiceId
 * substituted in — the proposal's raw payload carries an
 * invoiceReference (a text hint from the operator) that the real
 * review UI resolves to an id. This test verifies the execution path
 * once resolution has happened.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createVoiceActionRouterWorker,
  VoiceActionRouterPayload,
} from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  InMemoryInvoiceRepository,
  Invoice,
} from '../../src/invoices/invoice';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import { UpdateInvoiceExecutionHandler } from '../../src/proposals/execution/update-invoice-handler';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

function silentLogger(): Logger {
  const noop = () => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function routerMsg<T>(payload: T): QueueMessage<T> {
  return {
    id: 'msg-1',
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
  };
}

function seedInvoice(): Invoice {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Diagnostic visit', 1, 12500, 0, true, 'labor'),
    buildLineItem('li-2', 'Replacement filter', 2, 3500, 1, true, 'material'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: 'inv-42',
    tenantId: 't-1',
    jobId: 'job-1',
    invoiceNumber: 'INV-0042',
    status: 'draft',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
  };
}

describe('integration — voice "add trip fee to invoice" → proposal → executed', () => {
  it('classifies the transcript, creates update_invoice proposal, executes against live invoice', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(seedInvoice());

    // Two LLM calls: classifier + invoice-edit task.
    const { gateway, provider } = createMockLLMGateway(
      JSON.stringify({ intentType: 'update_invoice', confidence: 0.92 })
    );
    const responses = [
      JSON.stringify({
        intentType: 'update_invoice',
        confidence: 0.92,
        extractedEntities: { jobReference: 'INV-0042', lineItemDescriptions: ['trip fee'] },
      }),
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: {
              description: 'Trip fee',
              quantity: 1,
              unitPrice: 7500,
              category: 'labor',
            },
          },
        ],
        confidence_score: 0.92,
      }),
    ];
    let call = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async () => ({
      content: responses[Math.min(call++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }));

    const router = createVoiceActionRouterWorker({ gateway, proposalRepo });
    await router.handle(
      routerMsg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Add a trip fee for 75 to invoice INV-0042',
      } satisfies VoiceActionRouterPayload),
      silentLogger()
    );

    // One proposal now in the repo.
    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal.proposalType).toBe('update_invoice');

    const classifierPayload = proposal.payload as Record<string, unknown>;
    expect(classifierPayload.invoiceReference).toBe('INV-0042');

    // Step: operator reviews and resolves the reference to a real id.
    // We simulate this by rewriting the proposal payload in the repo
    // before execution — in the real app the review UI does this and
    // the updated proposal is what the executor sees on approval.
    const executablePayload: Record<string, unknown> = {
      invoiceId: 'inv-42',
      editActions: classifierPayload.editActions,
    };
    const resolvedProposal = { ...proposal, payload: executablePayload };

    const executor = new UpdateInvoiceExecutionHandler(invoiceRepo);
    const result = await executor.execute(resolvedProposal, {
      tenantId: 't-1',
      executedBy: 'u-1',
    });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('inv-42');

    const updated = await invoiceRepo.findById('t-1', 'inv-42');
    expect(updated!.lineItems).toHaveLength(3);
    expect(updated!.lineItems[2].description).toBe('Trip fee');
    expect(updated!.totals.subtotalCents).toBe(12500 + 7000 + 7500);
    expect(updated!.amountDueCents).toBe(12500 + 7000 + 7500);
  });

  it('executes a remove_line_item on the real invoice', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(seedInvoice());

    const { gateway, provider } = createMockLLMGateway('{}');
    const responses = [
      JSON.stringify({
        intentType: 'update_invoice',
        confidence: 0.9,
        extractedEntities: { jobReference: 'INV-0042' },
      }),
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [{ type: 'remove_line_item', description: 'filter' }],
        confidence_score: 0.9,
      }),
    ];
    let call = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async () => ({
      content: responses[Math.min(call++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }));

    const router = createVoiceActionRouterWorker({ gateway, proposalRepo });
    await router.handle(
      routerMsg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Remove the filter from invoice INV-0042',
      } satisfies VoiceActionRouterPayload),
      silentLogger()
    );

    const proposal = (await proposalRepo.findByTenant('t-1'))[0];
    // Again the review UI resolves the description hint to a concrete
    // index before execution.
    const executor = new UpdateInvoiceExecutionHandler(invoiceRepo);
    const result = await executor.execute(
      {
        ...proposal,
        payload: {
          invoiceId: 'inv-42',
          editActions: [{ type: 'remove_line_item', index: 1 }],
        },
      },
      { tenantId: 't-1', executedBy: 'u-1' }
    );
    expect(result.success).toBe(true);

    const updated = await invoiceRepo.findById('t-1', 'inv-42');
    expect(updated!.lineItems).toHaveLength(1);
    expect(updated!.lineItems[0].description).toBe('Diagnostic visit');
  });
});
