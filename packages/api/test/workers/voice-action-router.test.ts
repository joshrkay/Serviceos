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
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';
import type { SlotConflictCheckerInput } from '../../src/ai/tasks/slot-conflict-checker';

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

  it('P0-035: passes the slotConflictChecker to CreateAppointmentAITaskHandler so the pre-check is wired in production', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.88,
        extractedEntities: { customerName: 'Mrs Lee' },
      } satisfies IntentClassification),
      JSON.stringify({
        customerId: '11111111-1111-1111-1111-111111111111',
        technicianId: '22222222-2222-2222-2222-222222222222',
        scheduledStart: '2026-04-21T21:00:00Z',
        scheduledEnd: '2026-04-21T22:00:00Z',
        confidence_score: 0.92,
      }),
    ]);

    const checker = {
      check: vi.fn(async (_input: SlotConflictCheckerInput) => ({
        ok: false as const,
        conflict: 'technician_busy' as const,
        appointmentId: 'appt-existing',
        conflictWindow: {
          start: new Date('2026-04-21T20:30:00Z'),
          end: new Date('2026-04-21T21:30:00Z'),
        },
      })),
    };

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      slotConflictChecker: checker,
    });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Schedule a follow-up with Mrs Lee at 2pm',
      }),
      silentLogger()
    );

    expect(checker.check).toHaveBeenCalledTimes(1);
    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('voice_clarification');
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
    expect(byTenant[0].status).toBe('draft');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.name).toBe('Acme Corp');
    expect(payload.email).toBe('alex@acme.com');
    expect(payload.phone).toBe('555-0100');
    expect(payload.displayName).toBeUndefined();
  });

  it('emits voice_clarification on low-confidence classification with the guessed intent as a suggestion', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.3,
        reasoning: 'mumbled — could be an invoice or an estimate',
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'um do the thing',
        recordingId: 'rec-1',
        conversationId: 'conv-1',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    const clar = byTenant[0];
    expect(clar.proposalType).toBe('voice_clarification');
    expect(clar.status).toBe('draft');
    const payload = clar.payload as Record<string, unknown>;
    expect(payload.reason).toBe('low_confidence');
    expect(payload.transcript).toBe('um do the thing');
    expect(payload.suggestedIntents).toEqual(['create_invoice']);
    expect(payload.recordingId).toBe('rec-1');
    expect(payload.conversationId).toBe('conv-1');
    expect(typeof payload.classifierConfidence).toBe('number');
  });

  it('emits voice_clarification when the classifier returns unknown intent', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'unknown', confidence: 0.9 }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'send that invoice',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    const clar = byTenant[0];
    expect(clar.proposalType).toBe('voice_clarification');
    expect(clar.status).toBe('draft');
    const payload = clar.payload as Record<string, unknown>;
    expect(payload.reason).toBe('unknown_intent');
    expect(payload.suggestedIntents).toBeUndefined();
    expect(payload.transcript).toBe('send that invoice');
  });

  it('emits voice_clarification with reason=parse_failed when classifier output is junk', async () => {
    const gateway = gatewayReturning(['not valid json']);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'create an invoice for Acme',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    const clar = byTenant[0];
    expect(clar.proposalType).toBe('voice_clarification');
    const payload = clar.payload as Record<string, unknown>;
    expect(payload.reason).toBe('parse_failed');
  });

  it('sanitizes classifier reasoning before persisting to the clarification payload', async () => {
    const longReasoning = 'A'.repeat(500);
    const withControls = `hello\x00\x1bworld${longReasoning}`;
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.3,
        reasoning: withControls,
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'um, thing',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    const payload = byTenant[0].payload as Record<string, unknown>;
    const stored = payload.classifierReasoning as string;
    expect(stored.length).toBeLessThanOrEqual(200);
    expect(stored).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('surfaces invalidEnumFields when classifier returns a bad cancellationType', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.95,
        extractedEntities: {
          appointmentReference: 'tomorrow 3pm',
          cancellationType: 'weather_emergency',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'cancel tomorrow 3pm, weather closed us down',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    const p = byTenant[0].payload as Record<string, unknown>;
    expect(p.cancellationType).toBe('other');
  });

  it('routes reschedule_appointment and marks ISO times as missing when only a description is given', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'reschedule_appointment',
        confidence: 0.92,
        extractedEntities: {
          appointmentReference: 'the Miller job',
          newDateTimeDescription: 'Thursday at 2pm',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Move the Miller job to Thursday at 2pm',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    const p = byTenant[0];
    expect(p.proposalType).toBe('reschedule_appointment');
    expect(p.status).toBe('draft');
    expect(p.sourceContext?.missingFields).toEqual(
      expect.arrayContaining(['newScheduledStart', 'newScheduledEnd'])
    );
    const payload = p.payload as Record<string, unknown>;
    expect(payload.appointmentReference).toBe('the Miller job');
    expect(payload.newDateTimeDescription).toBe('Thursday at 2pm');
  });

  it('routes cancel_appointment and stays in draft even at high confidence (irreversible class)', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.98,
        extractedEntities: {
          appointmentReference: 'tomorrow 3pm',
          cancellationReason: 'customer called out',
          cancellationType: 'customer_request',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: "Cancel tomorrow's 3pm, the customer called out",
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('cancel_appointment');
    expect(byTenant[0].status).toBe('draft');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.cancellationType).toBe('customer_request');
    expect(payload.reason).toBe('customer called out');
  });

  it('routes reassign_appointment with target technician name', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.9,
        extractedEntities: {
          appointmentReference: "Tuesday's Davis job",
          targetTechnicianName: 'Mike',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: "Give Tuesday's Davis job to Mike",
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('reassign_appointment');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.targetTechnicianName).toBe('Mike');
    expect(byTenant[0].sourceContext?.missingFields).toEqual(
      expect.arrayContaining(['toTechnicianId'])
    );
  });

  it('routes add_note with a body and target reference', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'add_note',
        confidence: 0.9,
        extractedEntities: {
          noteBody: 'customer wants a call before arrival',
          noteTargetKind: 'job',
          customerName: 'Rodriguez',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Note on the Rodriguez job: customer wants a call before we arrive',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('add_note');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.body).toBe('customer wants a call before arrival');
    expect(payload.targetKind).toBe('job');
    expect(payload.targetReference).toBe('Rodriguez');
  });

  it('routes send_invoice as comms (draft-only, never auto-approves)', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'send_invoice',
        confidence: 0.95,
        extractedEntities: { jobReference: 'INV-0042', sendChannel: 'email' },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Email invoice INV-0042',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('send_invoice');
    expect(byTenant[0].status).toBe('draft');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.channel).toBe('email');
    expect(payload.invoiceReference).toBe('INV-0042');
  });

  it('routes send_estimate as comms (draft-only, never auto-approves)', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'send_estimate',
        confidence: 0.95,
        extractedEntities: { jobReference: 'EST-0042', sendChannel: 'sms' },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Text estimate EST-0042 to the customer',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('send_estimate');
    expect(byTenant[0].status).toBe('draft');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.channel).toBe('sms');
    expect(payload.estimateReference).toBe('EST-0042');
  });

  it('routes record_payment as money (draft-only) with amount as integer cents', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'record_payment',
        confidence: 0.96,
        extractedEntities: {
          jobReference: 'INV-0042',
          amount: 45000,
          paymentMethod: 'cash',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Mark INV-0042 paid — 450 cash',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('record_payment');
    expect(byTenant[0].status).toBe('draft');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.amountCents).toBe(45000);
    expect(payload.paymentMethod).toBe('cash');
    expect(payload.invoiceReference).toBe('INV-0042');
  });

  it('routes create_job when the classifier returns title + customerName', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_job',
        confidence: 0.9,
        extractedEntities: {
          customerName: 'Smith',
          jobTitle: 'Kitchen drain replacement',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Start a new job for Smith — kitchen drain replacement',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('create_job');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.title).toBe('Kitchen drain replacement');
    expect(payload.customerReference).toBe('Smith');
    expect(byTenant[0].sourceContext?.missingFields).toEqual(
      expect.arrayContaining(['customerId'])
    );
  });

  it('passes tenantId to the gateway in request metadata', async () => {
    const completeMock = vi.fn(async (_request: unknown) => ({
      content: JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 }),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 5, output: 5, total: 10 },
      latencyMs: 1,
    }));
    const gateway = { complete: completeMock } as unknown as LLMGateway;

    const invoiceGateway = gatewayReturning([
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 }),
      JSON.stringify({
        customerId: 'c',
        jobId: 'j',
        lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }],
        confidence_score: 0.9,
      }),
    ]);
    void invoiceGateway;

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker
      .handle(
        msg({
          tenantId: 'tenant-abc',
          userId: 'u-1',
          transcript: 'create an invoice for Acme',
        }),
        silentLogger()
      )
      .catch(() => {
        /* classifier passed; handler may fail without a 2nd mock */
      });

    const firstCallArgs = completeMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstCallArgs).toBeTruthy();
    expect((firstCallArgs as { taskType: string }).taskType).toBe('classify_intent');
    expect((firstCallArgs as { metadata: unknown }).metadata).toEqual({ tenantId: 'tenant-abc' });
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

  // §3B/3D/3E — operator voice path must see the same vertical context
  // that the customer-facing telephony adapter already gets. Without
  // this, the tradesperson saying "draft an estimate for the Johnson
  // water heater" misses HVAC/plumbing-specific entity terms and the
  // classifier is far more likely to bottom out at 'unknown'.
  it('forwards verticalPromptResolver output into the classifier system messages', async () => {
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
    const verticalPromptResolver = vi.fn(
      async (_tenantId: string) => 'Service vertical: HVAC\nEquipment: furnace, AC',
    );

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      verticalPromptResolver,
    });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Create an invoice for Acme for 450 dollars',
      }),
      silentLogger(),
    );

    expect(verticalPromptResolver).toHaveBeenCalledWith('t-1');
    const classifierCall = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemContents = classifierCall.messages
      .filter((m: { role: string }) => m.role === 'system')
      .map((m: { content: string }) => m.content);
    expect(systemContents.some((c: string) => c.includes('Service vertical: HVAC'))).toBe(true);
  });

  // Regression guard: a vertical resolver that throws must not break the
  // classifier turn — the operator's command still routes, just without
  // vertical context. Falling out loudly would create flake on stale
  // pack registrations during cutover.
  it('falls back gracefully when the verticalPromptResolver throws', async () => {
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
    const verticalPromptResolver = vi.fn(async (_tenantId: string): Promise<string | undefined> => {
      throw new Error('pack registry down');
    });

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      verticalPromptResolver,
    });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Create an invoice for Acme for 450 dollars',
      }),
      silentLogger(),
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('draft_invoice');
  });

  it('is idempotent on queue redelivery: the same recordingId never double-books', async () => {
    // The queue is at-least-once. A message redelivered after a worker
    // crash/timeout must NOT create a second proposal — and for the
    // held-slot create_appointment path, must NOT place a second
    // tentative appointment hold (a real double-booking).
    const appointmentResponse = JSON.stringify({
      customerName: 'Mrs Lee',
      jobId: '33333333-3333-3333-3333-333333333333',
      scheduledStart: '2026-04-21T21:00:00Z',
      scheduledEnd: '2026-04-21T22:00:00Z',
      confidence_score: 0.9,
    });
    const classifierResponse = JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.9,
      extractedEntities: { customerName: 'Mrs Lee' },
    } satisfies IntentClassification);
    // Enough responses for two full passes; if dedup works the second
    // delivery short-circuits before any LLM call and these go unused.
    const gateway = gatewayReturning([
      classifierResponse,
      appointmentResponse,
      classifierResponse,
      appointmentResponse,
    ]);
    const appointmentRepo = new InMemoryAppointmentRepository();

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, appointmentRepo });

    const payload = {
      tenantId: 't-1',
      userId: 'u-1',
      transcript: 'Schedule a follow-up with Mrs Lee next Tuesday at 2pm',
      recordingId: 'rec-dedup-1',
    };

    await worker.handle(msg(payload), silentLogger());
    await worker.handle(msg(payload), silentLogger());

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    // The proposal carries the deterministic idempotency key so a concurrent
    // redelivery (one that races past the pre-check) is deduped at the DB layer.
    expect(byTenant[0].idempotencyKey).toBe('voice-proposal:rec-dedup-1');

    const appts = await appointmentRepo.findByDateRange(
      't-1',
      new Date('2000-01-01T00:00:00Z'),
      new Date('2100-01-01T00:00:00Z'),
    );
    expect(appts).toHaveLength(1);
    // The held appointment carries its own key so a concurrent redelivery
    // returns the existing hold instead of inserting a second one.
    expect(appts[0].idempotencyKey).toBe('voice-hold:rec-dedup-1');
  });

  it('concurrent redelivery past the pre-check is deduped by the idempotency key (no throw, one proposal)', async () => {
    // Simulate the race: both deliveries see an EMPTY proposal store at
    // pre-check time (a proposalRepo whose findByTenant always reports empty
    // until the underlying create has happened), so both pass findAlreadyProcessed
    // and both reach create — the second must be swallowed as a dedup, not throw.
    const real = new InMemoryProposalRepository();
    const racingRepo = {
      create: (p: Proposal) => real.create(p),
      findByTenant: async () => [] as Proposal[], // always "nothing processed yet"
    } as unknown as InMemoryProposalRepository;

    const classifierResponse = JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.9,
      extractedEntities: { customerName: 'Mrs Lee' },
    } satisfies IntentClassification);
    const appointmentResponse = JSON.stringify({
      customerName: 'Mrs Lee',
      scheduledStart: '2026-04-21T21:00:00Z',
      scheduledEnd: '2026-04-21T22:00:00Z',
      confidence_score: 0.9,
    });
    // Two full classify+extract passes (both deliveries run end-to-end).
    const gateway = gatewayReturning([
      classifierResponse,
      appointmentResponse,
      classifierResponse,
      appointmentResponse,
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo: racingRepo });
    const payload = {
      tenantId: 't-1',
      userId: 'u-1',
      transcript: 'Schedule a follow-up with Mrs Lee next Tuesday at 2pm',
      recordingId: 'rec-race-1',
    };

    await worker.handle(msg(payload), silentLogger());
    // Second delivery races past the (empty) pre-check and must NOT throw.
    await expect(worker.handle(msg(payload), silentLogger())).resolves.toBeUndefined();

    // Exactly one proposal actually persisted despite two create attempts.
    expect(await real.findByTenant('t-1')).toHaveLength(1);
  });
});
