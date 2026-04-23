/**
 * voice-action-router worker unit tests.
 *
 * Covers the full Phase-1 dispatch chain: a transcript enters, the
 * classifier decides which task, the task handler builds a proposal,
 * the proposal gets persisted. Low-confidence transcripts must NOT
 * produce proposals — they get logged and dropped so the user is not
 * surprised by actions they didn't clearly request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository, Proposal } from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function gatewayReturning(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[i++] ?? responses[responses.length - 1];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 10, output: 10, total: 20 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function msg<T>(payload: T): QueueMessage<T> {
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

describe('voice-action-router worker', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  it('classifies "create invoice" transcript and persists a draft_invoice proposal', async () => {
    // First LLM call = classifier; second = invoice task.
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.9,
        extractedEntities: { customerName: 'Acme' },
      } satisfies IntentClassification),
      JSON.stringify({
        customerId: 'cust-1',
        jobId: 'job-1',
        lineItems: [{ description: 'Pipe repair', quantity: 1, unitPrice: 45000 }],
        confidence_score: 0.9,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Create an invoice for Acme for 450 dollars',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('draft_invoice');
  });

  it('classifies "schedule follow-up" and persists a create_appointment proposal', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.88,
        extractedEntities: { customerName: 'Mrs Lee', dateTimeDescription: 'next Tuesday 2pm' },
      } satisfies IntentClassification),
      JSON.stringify({
        customerName: 'Mrs Lee',
        scheduledStart: '2026-04-21T21:00:00Z',
        scheduledEnd: '2026-04-21T22:00:00Z',
        confidence_score: 0.88,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Schedule a follow-up with Mrs Lee next Tuesday at 2pm',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('create_appointment');
  });

  it('classifies "add item to invoice" and persists an update_invoice proposal', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'update_invoice',
        confidence: 0.9,
        extractedEntities: { jobReference: 'INV-0042', lineItemDescriptions: ['trip fee'] },
      }),
      JSON.stringify({
        invoiceReference: 'INV-0042',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 },
          },
        ],
        confidence_score: 0.9,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Add a trip fee for 75 to invoice INV-0042',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('update_invoice');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.invoiceReference).toBe('INV-0042');
  });

  it('classifies "add item to estimate" and persists an update_estimate proposal', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'update_estimate',
        confidence: 0.9,
        extractedEntities: { jobReference: 'EST-0001', lineItemDescriptions: ['site visit'] },
      }),
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Site visit', quantity: 1, unitPrice: 15000 },
          },
        ],
        confidence_score: 0.9,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Add a site visit for 150 to estimate EST-0001',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('update_estimate');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.estimateReference).toBe('EST-0001');
  });

  it('classifies "draft estimate" and persists a draft_estimate proposal', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'draft_estimate', confidence: 0.9 }),
      JSON.stringify({
        customerId: 'cust-1',
        lineItems: [{ description: 'Install water heater', quantity: 1, unitPrice: 120000 }],
        confidence_score: 0.9,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Draft an estimate for the Johnson water heater job',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('draft_estimate');
  });

  it('classifies "create customer" and persists a create_customer proposal with mapped name', async () => {
    // Only one LLM call — the customer task handler is a pure passthrough,
    // no second provider round-trip needed.
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.93,
        extractedEntities: {
          displayName: 'Acme Corp',
          email: 'alex@acme.com',
          phone: '555-0100',
        },
      } satisfies IntentClassification),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Add customer Acme Corp, email alex@acme.com, phone 555-0100',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('create_customer');
    expect(byTenant[0].status).toBe('draft'); // human approval required — no auto-execute
    const payload = byTenant[0].payload as Record<string, unknown>;
    // Router maps classifier's `displayName` to the contract's `name`.
    expect(payload.name).toBe('Acme Corp');
    expect(payload.email).toBe('alex@acme.com');
    expect(payload.phone).toBe('555-0100');
    expect(payload.displayName).toBeUndefined();
  });

  it('drops low-confidence classifications without creating a proposal', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.3 }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'um do the thing',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(0);
  });

  it('drops transcripts that classify as unknown', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'unknown', confidence: 0.9 }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'send that invoice', // Phase 3, not supported yet
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(0);
  });

  it('skips empty transcripts without calling the classifier', async () => {
    const gateway = gatewayReturning(['']);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: '   ',
      }),
      silentLogger()
    );

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(0);
  });

  it('propagates proposalRepo errors so the queue can retry', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 }),
      JSON.stringify({ customerId: 'c', jobId: 'j', lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }], confidence_score: 0.9 }),
    ]);
    const failingRepo = {
      ...proposalRepo,
      create: vi.fn(async (_p: Proposal) => {
        throw new Error('db down');
      }),
    } as unknown as InMemoryProposalRepository;

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo: failingRepo });

    await expect(
      worker.handle(
        msg({ tenantId: 't-1', userId: 'u-1', transcript: 'create an invoice for Acme' }),
        silentLogger()
      )
    ).rejects.toThrow(/db down/);
  });
});
