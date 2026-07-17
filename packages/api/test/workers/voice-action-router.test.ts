/**
 * voice-action-router worker unit tests.
 *
 * Covers the full Phase-1 dispatch chain: a transcript enters, the
 * classifier decides which task, the task handler builds a proposal,
 * the proposal gets persisted. Low-confidence transcripts must NOT
 * produce proposals — they get logged and dropped so the user is not
 * surprised by actions they didn't clearly request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository, Proposal } from '../../src/proposals/proposal';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import { complaintSeverity } from '../../src/workers/voice-action-router';
import { assertValidProposalPayload } from '../../src/proposals/contracts';
import { missingFieldsFor } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';
import type { SlotConflictCheckerInput } from '../../src/ai/tasks/slot-conflict-checker';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../src/ai/resolution/entity-resolver';

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

  afterEach(() => {
    // Supervisor presence is a module-level singleton with a 30s cache; reset
    // both so a test that wires a loader can't bleed into the permissive
    // default the other tests rely on.
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
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

  it('does NOT auto-approve a high-confidence voice booking when the tenant is unsupervised', async () => {
    // P0 launch blocker: with no supervisor present, an autonomous,
    // capture-class booking must land in the review queue — never 'approved'
    // (which the execution worker would auto-run after the undo window).
    setSupervisorPresenceLoader(async () => false);
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.97,
        extractedEntities: { customerName: 'Mrs Lee', dateTimeDescription: 'next Tuesday 2pm' },
      } satisfies IntentClassification),
      JSON.stringify({
        customerName: 'Mrs Lee',
        scheduledStart: '2026-04-21T21:00:00Z',
        scheduledEnd: '2026-04-21T22:00:00Z',
        confidence_score: 0.97,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });
    await worker.handle(
      msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-unsup');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].status).toBe('ready_for_review');
    expect(byTenant[0].approvedAt).toBeUndefined();
  });

  it('auto-approves the same high-confidence booking when a supervisor IS present', async () => {
    // Contrast to the unsupervised case: the Phase-12 supervised auto-approve
    // path stays intact when presence is confirmed.
    setSupervisorPresenceLoader(async () => true);
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.97,
        extractedEntities: { customerName: 'Mrs Lee', dateTimeDescription: 'next Tuesday 2pm' },
      } satisfies IntentClassification),
      JSON.stringify({
        customerName: 'Mrs Lee',
        scheduledStart: '2026-04-21T21:00:00Z',
        scheduledEnd: '2026-04-21T22:00:00Z',
        confidence_score: 0.97,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });
    await worker.handle(
      msg({ tenantId: 't-sup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-sup');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].status).toBe('approved');
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

  // ── UB-A3 — standing instructions threaded into drafting prompts ──
  it('injects resolver-supplied standing instructions into the drafting prompt and stamps the intersected marker', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'draft_estimate', confidence: 0.9 }),
      JSON.stringify({
        customerId: 'cust-1',
        lineItems: [{ description: 'Install water heater', quantity: 1, unitPrice: 120000 }],
        confidence_score: 0.9,
        appliedStandingInstructions: ['si-fee', 'si-invented'],
      }),
    ]);

    const base = {
      tenantId: 't-1',
      scope: {},
      active: true,
      source: 'settings' as const,
      createdBy: 'u-1',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-01T00:00:00Z'),
      deactivatedAt: null,
      deactivatedBy: null,
    };
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      standingInstructionsResolver: async () => [
        { ...base, id: 'si-fee', instruction: 'Always add a $50 trip fee line item' },
        // Scoped to a different intent — must NOT reach the estimate prompt.
        { ...base, id: 'si-invoice', instruction: 'Invoice-only rule', scope: { intents: ['create_invoice'] } },
      ],
    });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Draft an estimate for the Johnson water heater job',
      }),
      silentLogger()
    );

    const draftingRequest = (gateway.complete as ReturnType<typeof vi.fn>).mock
      .calls[1][0] as { messages: Array<{ role: string; content: string }> };
    const injected = draftingRequest.messages.filter(
      (m) => m.role === 'system' && m.content.includes('OWNER STANDING INSTRUCTIONS')
    );
    expect(injected).toHaveLength(1);
    expect(injected[0].content).toContain('- [SI:si-fee] Always add a $50 trip fee line item');
    expect(injected[0].content).not.toContain('Invoice-only rule');

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    const meta = (byTenant[0].payload as { _meta: Record<string, unknown> })._meta;
    // Model-invented id intersected away; only the injected id survives.
    expect(meta.appliedStandingInstructions).toEqual([
      { id: 'si-fee', text: 'Always add a $50 trip fee line item' },
    ]);
  });

  it('standing-instructions resolver failure is soft — the task drafts without them', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'draft_estimate', confidence: 0.9 }),
      JSON.stringify({
        customerId: 'cust-1',
        lineItems: [{ description: 'Install water heater', quantity: 1, unitPrice: 120000 }],
        confidence_score: 0.9,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      standingInstructionsResolver: async () => {
        throw new Error('db down');
      },
    });

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
    const draftingRequest = (gateway.complete as ReturnType<typeof vi.fn>).mock
      .calls[1][0] as { messages: Array<{ role: string; content: string }> };
    expect(
      draftingRequest.messages.some((m) => m.content.includes('OWNER STANDING INSTRUCTIONS'))
    ).toBe(false);
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

  it('routes reschedule_appointment, resolves the spoken new time, and holds only on the appointment id', async () => {
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
    // Still draft: we resolved the new TIME, but with no appointmentRepo
    // wired the concrete appointment id is unknown, so it holds for review.
    expect(p.status).toBe('draft');
    const missing = p.sourceContext?.missingFields as string[];
    expect(missing).toContain('appointmentId');
    // The spoken time is now resolved deterministically — no longer missing.
    expect(missing).not.toContain('newScheduledStart');
    expect(missing).not.toContain('newScheduledEnd');
    const payload = p.payload as Record<string, unknown>;
    expect(payload.appointmentReference).toBe('the Miller job');
    expect(payload.newDateTimeDescription).toBe('Thursday at 2pm');
    // Resolved to a concrete UTC instant.
    expect(typeof payload.newScheduledStart).toBe('string');
    expect(Number.isNaN(Date.parse(payload.newScheduledStart as string))).toBe(false);
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
      // The pre-check (findByRecordingId) always reports "nothing processed
      // yet" so both deliveries pass it and race into create; the real repo's
      // idempotency key must swallow the second create rather than throw.
      findByRecordingId: async () => null,
      findByTenant: async () => [] as Proposal[],
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

// ─── P8: entity resolution ("three Bobs") ────────────────────────────────
// The router resolves the classifier's free-text customer/job references
// to verified tenant IDs before drafting. These tests use a fake resolver
// to pin the contract for each EntityResolverResult kind plus failure
// tolerance and the no-resolver regression pin.
describe('voice-action-router entity resolution', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  const BOB_ID = '11111111-1111-1111-1111-111111111111';

  function classifierJson(entities: Record<string, unknown>): string {
    return JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.9,
      extractedEntities: entities,
    } satisfies IntentClassification);
  }

  const invoiceJson = JSON.stringify({
    customerId: BOB_ID,
    jobId: '22222222-2222-2222-2222-222222222222',
    lineItems: [{ description: 'Pipe repair', quantity: 1, unitPrice: 45000 }],
    confidence_score: 0.85,
  });

  function fakeResolver(
    impl: (input: { tenantId: string; reference: string; kind: string }) => Promise<EntityResolverResult>,
  ): EntityResolver {
    return { resolve: vi.fn(impl) } as EntityResolver;
  }

  it('resolved reference → verified UUID rides the drafting context entities', async () => {
    const gateway = gatewayReturning([classifierJson({ customerName: 'Bob' }), invoiceJson]);
    const resolver = fakeResolver(async () => ({
      kind: 'resolved',
      candidate: { id: BOB_ID, kind: 'customer', label: 'Bob Smith (555-0100)', score: 0.95 },
    }));
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Bob for the pipe repair' }),
      silentLogger(),
    );

    expect(await proposalRepo.findByTenant('t-1')).toHaveLength(1);
    // The drafting (second) LLM call must see the resolved UUID, not just free text.
    const draftCall = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(draftCall.messages[1].content).toContain(BOB_ID);
  });

  it('ambiguous reference → voice_clarification with candidates, NO drafting LLM call', async () => {
    const gateway = gatewayReturning([classifierJson({ customerName: 'Bob' }), invoiceJson]);
    const resolver = fakeResolver(async () => ({
      kind: 'ambiguous',
      candidates: [
        { id: 'c-1', kind: 'customer', label: 'Bob Smith (555-0100)', score: 0.9 },
        { id: 'c-2', kind: 'customer', label: 'Bob Stone (555-0200)', hint: 'Last job: May', score: 0.88 },
      ],
    }));
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Bob for the pipe repair' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('voice_clarification');
    const payload = proposals[0].payload as Record<string, unknown>;
    expect(payload.reason).toBe('ambiguous_entity');
    expect(payload.entityReference).toBe('Bob');
    expect(payload.entityCandidates).toEqual([
      { id: 'c-1', label: 'Bob Smith (555-0100)', score: 0.9 },
      { id: 'c-2', label: 'Bob Stone (555-0200)', hint: 'Last job: May', score: 0.88 },
    ]);
    // Classifier call only — the expensive drafting call was skipped.
    expect(gateway.complete).toHaveBeenCalledTimes(1);

    // U1 (E9) — the producer persists the ORIGINAL intent so resolveProposalEntity
    // can re-run the real handler with the chosen id and replace the
    // (non-executable) voice_clarification with the drafted, executable proposal.
    const ctx = proposals[0].sourceContext as Record<string, unknown>;
    expect(ctx.originalIntent).toEqual({
      intentType: 'create_invoice',
      extractedEntities: { customerName: 'Bob' },
    });
  });

  it('U1 (E9): emitClarification on the ambiguity path persists sanitized originalIntent', async () => {
    // The classifier extracts several entity fields; the producer must persist
    // them (sanitized) under sourceContext.originalIntent.
    const classifierWithEntities = JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.9,
      extractedEntities: {
        customerName: 'Bob',
        // A control-char-laden value must be stripped on persist (same
        // treatment as classifierReasoning) — the tab becomes a space.
        jobReference: `water${String.fromCharCode(9)}heater`,
        amount: 45000,
        lineItemDescriptions: ['pipe', 'valve'],
      },
    } satisfies IntentClassification);
    const gateway = gatewayReturning([classifierWithEntities, invoiceJson]);
    const resolver = fakeResolver(async () => ({
      kind: 'ambiguous',
      candidates: [
        { id: 'c-1', kind: 'customer', label: 'Bob Smith', score: 0.9 },
        { id: 'c-2', kind: 'customer', label: 'Bob Stone', score: 0.88 },
      ],
    }));
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Bob for the water heater' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    const ctx = proposals[0].sourceContext as Record<string, unknown>;
    const orig = ctx.originalIntent as Record<string, unknown>;
    expect(orig.intentType).toBe('create_invoice');
    const ee = orig.extractedEntities as Record<string, unknown>;
    expect(ee.customerName).toBe('Bob');
    // Control char stripped (sanitizeReasoning replaces it with a space).
    expect(ee.jobReference).toBe('water heater');
    // Numbers pass through; string arrays sanitized element-wise.
    expect(ee.amount).toBe(45000);
    expect(ee.lineItemDescriptions).toEqual(['pipe', 'valve']);
  });

  it('not_found reference → proposal persists with sourceContext.pendingReference', async () => {
    const gateway = gatewayReturning([classifierJson({ customerName: 'Zelda' }), invoiceJson]);
    const resolver = fakeResolver(async () => ({ kind: 'not_found', reference: 'Zelda' }));
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Zelda for the pipe repair' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('draft_invoice');
    const ctx = proposals[0].sourceContext as Record<string, unknown>;
    expect(ctx.pendingReference).toEqual([{ kind: 'customer', reference: 'Zelda' }]);
  });

  it('resolver throw is non-fatal — proposal still created, unannotated', async () => {
    const gateway = gatewayReturning([classifierJson({ customerName: 'Bob' }), invoiceJson]);
    const resolver = fakeResolver(async () => {
      throw new Error('pg down');
    });
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Bob for the pipe repair' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('draft_invoice');
    expect((proposals[0].sourceContext as Record<string, unknown> | undefined)?.pendingReference)
      .toBeUndefined();
  });

  it('verified caller-ID customerId wins — spoken name is never resolved over it', async () => {
    const gateway = gatewayReturning([classifierJson({ customerName: 'Bob' }), invoiceJson]);
    const resolve = vi.fn(async () => ({
      kind: 'resolved' as const,
      candidate: { id: 'WRONG', kind: 'customer' as const, label: 'Bob Imposter', score: 0.99 },
    }));
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      entityResolver: { resolve } as EntityResolver,
    });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Invoice Bob for the pipe repair',
        customerId: 'verified-caller-id',
      }),
      silentLogger(),
    );

    // No customer lookup attempted (no job reference either → zero calls).
    expect(resolve).not.toHaveBeenCalled();
    expect(await proposalRepo.findByTenant('t-1')).toHaveLength(1);
  });

  it('job references resolve independently of customer references', async () => {
    const gateway = gatewayReturning([
      classifierJson({ customerName: 'Bob', jobReference: 'the Rodriguez job' }),
      invoiceJson,
    ]);
    const seen: string[] = [];
    const resolver = fakeResolver(async ({ kind }) => {
      seen.push(kind);
      if (kind === 'customer') {
        return {
          kind: 'resolved',
          candidate: { id: BOB_ID, kind: 'customer', label: 'Bob Smith', score: 0.95 },
        };
      }
      return { kind: 'not_found', reference: 'the Rodriguez job' };
    });
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Bob for the Rodriguez job' }),
      silentLogger(),
    );

    expect(seen.sort()).toEqual(['customer', 'job']);
    const proposals = await proposalRepo.findByTenant('t-1');
    const ctx = proposals[0].sourceContext as Record<string, unknown>;
    expect(ctx.pendingReference).toEqual([{ kind: 'job', reference: 'the Rodriguez job' }]);
  });

  it('without an entityResolver dep, behavior is unchanged (regression pin)', async () => {
    const gateway = gatewayReturning([classifierJson({ customerName: 'Bob' }), invoiceJson]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Bob for the pipe repair' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('draft_invoice');
    expect((proposals[0].sourceContext as Record<string, unknown> | undefined)?.pendingReference)
      .toBeUndefined();
  });

  it('TWO ambiguous references in the same utterance: both are surfaced, neither is silently downgraded', async () => {
    // customerName ("Bob") and jobReference ("the water heater job") are
    // BOTH ambiguous. Before this change the resolver loop returned as soon
    // as it hit the FIRST ambiguity — the job lookup was never even
    // attempted, so the second reference vanished with no trace. It must
    // now be tracked and persisted rather than silently dropped.
    const gateway = gatewayReturning([
      classifierJson({ customerName: 'Bob', jobReference: 'the water heater job' }),
      invoiceJson,
    ]);
    const resolver = fakeResolver(async ({ kind }) => {
      if (kind === 'customer') {
        return {
          kind: 'ambiguous',
          candidates: [
            { id: 'cust-1', kind: 'customer', label: 'Bob Smith (555-0100)', score: 0.9 },
            { id: 'cust-2', kind: 'customer', label: 'Bob Stone (555-0200)', score: 0.88 },
          ],
        };
      }
      return {
        kind: 'ambiguous',
        candidates: [
          { id: 'job-1', kind: 'job', label: 'Water heater — 12 Elm St', score: 0.85 },
          { id: 'job-2', kind: 'job', label: 'Water heater — 40 Oak Ave', score: 0.82 },
        ],
      };
    });
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Invoice Bob for the water heater job' }),
      silentLogger(),
    );

    // Exactly ONE clarification proposal — the voice_clarification payload
    // contract carries a single entity's candidate list — but it must carry
    // BOTH ambiguities so the operator's second answer isn't stalled behind
    // a reference that quietly turned into a guess or a dropped not_found.
    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('voice_clarification');
    // The classifier call only — drafting never ran (same as the
    // single-ambiguity case above).
    expect(gateway.complete).toHaveBeenCalledTimes(1);

    // The FIRST ambiguity (customer — lookup order: customer, job,
    // technician) is what the payload's one-tap picker renders.
    const payload = proposals[0].payload as Record<string, unknown>;
    expect(payload.reason).toBe('ambiguous_entity');
    expect(payload.entityReference).toBe('Bob');
    expect(payload.entityCandidates).toEqual([
      { id: 'cust-1', label: 'Bob Smith (555-0100)', score: 0.9 },
      { id: 'cust-2', label: 'Bob Stone (555-0200)', score: 0.88 },
    ]);

    // The SECOND ambiguity (job) is never dropped or downgraded to
    // not_found: it's persisted on sourceContext so a redraft after this
    // clarification resolves can immediately re-surface it instead of
    // stalling silently.
    const ctx = proposals[0].sourceContext as Record<string, unknown>;
    expect(ctx.originalIntent).toBeTruthy();
    expect(ctx.pendingEntityAmbiguities).toEqual([
      {
        entityKind: 'job',
        reference: 'the water heater job',
        candidates: [
          { id: 'job-1', kind: 'job', label: 'Water heater — 12 Elm St', score: 0.85 },
          { id: 'job-2', kind: 'job', label: 'Water heater — 40 Oak Ave', score: 0.82 },
        ],
      },
    ]);
    // The not_found bucket must stay empty — this is an ambiguity, not a miss.
    expect(ctx.pendingReference).toBeUndefined();
  });
});

describe('P8/latency — per-segment resolver reads run concurrently', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  const JOB_ID = '33333333-3333-3333-3333-333333333333';

  function bookingGateway(): LLMGateway {
    return gatewayReturning([
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.9,
        extractedEntities: { dateTimeDescription: 'tomorrow at 2pm' },
      } satisfies IntentClassification),
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        jobId: JOB_ID,
        summary: 'AC repair',
        confidence_score: 0.9,
      }),
    ]);
  }

  it('a rejecting thresholdResolver/autonomousBookingResolver does not poison the sibling reads run in the same Promise.all batch', async () => {
    setSupervisorPresenceLoader(async () => true);
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(),
      proposalRepo,
      // Both reject outright (not just resolve to undefined) — proving the
      // per-call `.catch(() => undefined)` still applies INSIDE the
      // Promise.all batch rather than letting the rejection propagate and
      // take down the other concurrent reads.
      thresholdResolver: async () => {
        throw new Error('settings db down');
      },
      autonomousBookingResolver: async () => {
        throw new Error('settings db down');
      },
      // Resolves fine — must come through untouched despite its two
      // Promise.all siblings rejecting.
      tenantSchedulingResolver: async () => ({ timezone: 'America/Denver' }),
    });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Book the AC repair tomorrow at 2pm' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_appointment');

    // The scheduling resolver's result rode through the parallel batch
    // intact — degraded reads on the other two promises didn't blank it.
    const payload = proposals[0].payload as Record<string, unknown>;
    expect(payload.timezone).toBe('America/Denver');
    // The 4th parallel read (isSupervisorPresent, which never rejects) also
    // came through correctly and drove the auto-approve decision — proving
    // the two rejecting siblings didn't stall or corrupt it either.
    expect(proposals[0].status).toBe('approved');
  });

  it('all four resolvers succeed: context reflects every one of them (parallelization is behavior-preserving on the happy path)', async () => {
    // Unsupervised (false) — combined with the other three resolvers all
    // succeeding, this proves every one of the four concurrent reads landed
    // in the right place: an unsupervised tenant's booking is held for
    // review (not auto-approved) even though confidence (0.9) clears the
    // legacy auto-approve bar, AND the scheduling resolver's timezone still
    // rode through in the same batch.
    setSupervisorPresenceLoader(async () => false);
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(),
      proposalRepo,
      thresholdResolver: async () => ({ tech: 0.7 }),
      tenantSchedulingResolver: async () => ({ timezone: 'America/Chicago' }),
      autonomousBookingResolver: async () => ({ enabled: false }),
    });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Book the AC repair tomorrow at 2pm' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    const payload = proposals[0].payload as Record<string, unknown>;
    expect(payload.timezone).toBe('America/Chicago');
    expect(proposals[0].status).toBe('ready_for_review');
  });
});

// ─── RV-071 / RV-225 — owner approval & edit intents are NOT routable here ───
//
// approve_proposal / reject_proposal / edit_proposal are only actionable
// on a live, verified owner call (telephony FSM, RV-070 ownerSession).
// This worker processes recorded memos with no caller-ID identity and no
// confirm turn — even a classifier that returns the intent at 0.99 must
// produce NO proposal and NO mutation here (Track E: edit_proposal joins
// the same loud-warn refusal).
//
// WS4 — this is the "operator dictation" half of the approval-loop
// invariant: a transcript like "approve the Henderson estimate" must
// NEVER fall through to a generic draft proposal here. The other half —
// the SAME phrase on a verified owner telephone call actually driving
// `startVoiceApproval`/`continueVoiceApproval` end-to-end (readback →
// confirm → approved) — is pinned in
// test/telephony/voice-approval-gather.test.ts. Together they prove
// voice approval is reachable from exactly one place: the owner-verified
// telephony channel, never a recorded/dictated transcript.

describe('RV-071 / RV-225 — voice-action-router refuses owner approval/edit intents', () => {
  it.each(['approve_proposal', 'reject_proposal', 'edit_proposal'])(
    'a high-confidence %s classification produces no proposal and no mutation',
    async (intentType) => {
      const proposalRepo = new InMemoryProposalRepository();
      const seeded = await proposalRepo.create(
        // A pending proposal that a mis-route could have approved.
        (await import('../../src/proposals/proposal')).createProposal({
          tenantId: 'tenant-1',
          proposalType: 'draft_estimate',
          payload: { customerName: 'Henderson', lineItems: [], totalCents: 45000 },
          summary: 'Estimate for Henderson',
          createdBy: 'voice',
        }),
      );

      const gateway = gatewayReturning([
        JSON.stringify({
          intentType,
          confidence: 0.99,
          reasoning: 'owner-style command',
          extractedEntities: { proposalReference: 'the Henderson estimate' },
        }),
      ]);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

      await worker.handle(
        msg({
          tenantId: 'tenant-1',
          userId: 'user-1',
          transcript: 'approve the Henderson estimate',
        }),
        silentLogger(),
      );

      const all = await proposalRepo.findByTenant('tenant-1');
      // No new proposal was created (no clarification either — skipped).
      expect(all).toHaveLength(1);
      // And the seeded proposal was not touched.
      const stored = await proposalRepo.findById('tenant-1', seeded.id);
      expect(stored?.status).toBe(seeded.status);
    },
  );
});

describe('Phase-2 Track A — extended intents routing', () => {
  it.each(['lookup_day_overview', 'lookup_digest', 'lookup_pending_items'])(
    '%s without opt-in: belt-and-braces gate emits a clarification (auditable refused extended intent)',
    async (intentType) => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType,
        confidence: 0.95,
        reasoning: 'owner asked for a read-only overview',
      }),
    ]);
    // No extendedIntentsEnabled dep → gate refuses the extended intent.
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 'tenant-1',
        userId: 'user-1',
        transcript: 'morning rundown please',
      }),
      silentLogger(),
    );

    // Belt-and-braces gate: hallucinated extended intent on a non-opted surface
    // produces a voice_clarification (auditable) rather than a silent skip.
    const all = await proposalRepo.findByTenant('tenant-1');
    expect(all.filter((p) => p.proposalType === 'voice_clarification')).toHaveLength(1);
    // Only the classifier ran — no drafting LLM call.
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['lookup_day_overview', 'lookup_digest', 'lookup_pending_items'])(
    '%s with opt-in: read-only, skipped (no proposal, no clarification)',
    async (intentType) => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType,
        confidence: 0.95,
        reasoning: 'owner asked for a read-only overview',
      }),
    ]);
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      extendedIntentsEnabled: async () => true,
    });

    await worker.handle(
      msg({
        tenantId: 'tenant-1',
        userId: 'user-1',
        transcript: 'morning rundown please',
      }),
      silentLogger(),
    );

    // With opt-in, the extended lookup intent passes the gate and is
    // then silently skipped (read-only — this worker has no voice back-channel).
    expect(await proposalRepo.findByTenant('tenant-1')).toHaveLength(0);
    // Only the classifier ran — no drafting LLM call.
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    },
  );

  it('sibling lookup intents get the same skip treatment (regression pin)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({ intentType: 'lookup_appointments', confidence: 0.95 }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({ tenantId: 'tenant-1', userId: 'user-1', transcript: 'when is my next appointment' }),
      silentLogger(),
    );

    expect(await proposalRepo.findByTenant('tenant-1')).toHaveLength(0);
  });

  it('extendedIntentsEnabled: deterministic phrase routes with NO LLM call at all', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning(['{"intentType":"unknown","confidence":0.1}']);
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      extendedIntentsEnabled: async () => true,
    });

    await worker.handle(
      msg({
        tenantId: 'tenant-1',
        userId: 'user-1',
        transcript: "What's my day look like?",
      }),
      silentLogger(),
    );

    // Deterministic short-circuit: classified as lookup_day_overview
    // without touching the gateway, then skipped (read-only).
    expect(gateway.complete).not.toHaveBeenCalled();
    expect(await proposalRepo.findByTenant('tenant-1')).toHaveLength(0);
  });

  it('without the opt-in dep, classifier prompt messages keep the legacy single-system-message shape', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning(['{"intentType":"unknown","confidence":0.9}']);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({ tenantId: 'tenant-1', userId: 'user-1', transcript: "What's my day look like?" }),
      silentLogger(),
    );

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).not.toContain('lookup_day_overview');
  });

  it('extendedIntentsEnabled resolver failure is non-fatal (falls back to legacy prompt)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.9,
        extractedEntities: { customerName: 'Acme' },
      }),
      JSON.stringify({
        customerId: '11111111-1111-4111-8111-111111111111',
        jobId: '22222222-2222-4222-8222-222222222222',
        lineItems: [{ description: 'Service call', quantity: 1, unitPriceCents: 45000 }],
      }),
    ]);
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      extendedIntentsEnabled: async () => {
        throw new Error('flag store down');
      },
    });

    await worker.handle(
      msg({ tenantId: 'tenant-1', userId: 'user-1', transcript: 'create an invoice for Acme' }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('tenant-1');
    expect(all).toHaveLength(1);
    expect(all[0].proposalType).toBe('draft_invoice');
  });
});

describe('RV-051 — voice clock-in confirmation through the router', () => {
  const PATEL_JOB_ID = '44444444-4444-4444-8444-444444444444';

  it('resolves the spoken job name to a verified jobId and reads back the confirmation', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'log_time_entry',
        confidence: 0.92,
        extractedEntities: { jobReference: 'the Patel job', timeEntryType: 'job' },
      }),
    ]);
    const resolver: EntityResolver = {
      resolve: vi.fn(async () => ({
        kind: 'resolved' as const,
        candidate: { id: PATEL_JOB_ID, kind: 'job' as const, label: 'JOB-0042 Patel', score: 0.95 },
      })),
    };
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'tech-1', transcript: 'Clock me in on the Patel job' }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('t-1');
    expect(all).toHaveLength(1);
    const proposal = all[0];
    expect(proposal.proposalType).toBe('log_time_entry');
    // The execution handler clocks in by payload.jobId — the resolved id
    // must land there, not just the free-text reference.
    expect(proposal.payload.jobId).toBe(PATEL_JOB_ID);
    expect(proposal.payload.jobReference).toBe('the Patel job');
    expect(proposal.summary).toBe('Clocking you in on the Patel job — right?');
    // The confirm gate: draft until a human says yes.
    expect(proposal.status).toBe('draft');
  });

  it('an ambiguous job name becomes a voice_clarification, never a guessed clock-in', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'log_time_entry',
        confidence: 0.92,
        extractedEntities: { jobReference: 'the Patel job', timeEntryType: 'job' },
      }),
    ]);
    const resolver: EntityResolver = {
      resolve: vi.fn(async () => ({
        kind: 'ambiguous' as const,
        candidates: [
          { id: PATEL_JOB_ID, kind: 'job' as const, label: 'JOB-0042 Patel (kitchen)', score: 0.9 },
          { id: '55555555-5555-4555-8555-555555555555', kind: 'job' as const, label: 'JOB-0050 Patel (bath)', score: 0.88 },
        ],
      })),
    };
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: resolver });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'tech-1', transcript: 'Clock me in on the Patel job' }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('t-1');
    expect(all).toHaveLength(1);
    expect(all[0].proposalType).toBe('voice_clarification');
    expect(all[0].payload.reason).toBe('ambiguous_entity');
  });
});

describe('RV-080 — complaint intent routing', () => {
  function complaintClassification(entities: Record<string, unknown> = {}): string {
    return JSON.stringify({
      intentType: 'complaint',
      confidence: 0.9,
      reasoning: 'caller is reporting dissatisfaction',
      extractedEntities: entities,
    });
  }

  it('creates a [COMPLAINT]-prefixed add_note AND a callback proposal — no new proposal types', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      complaintClassification({
        customerName: 'Mrs. Patel',
        noteBody: 'the leak came back two days after the repair',
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, extendedIntentsEnabled: async () => true });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'op-1',
        transcript: 'Mrs. Patel called, really unhappy — the leak came back two days after the repair',
        conversationId: 'conv-1',
      }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('t-1');
    expect(all.map((p) => p.proposalType).sort()).toEqual(['add_note', 'callback']);

    const note = all.find((p) => p.proposalType === 'add_note')!;
    expect(note.payload.body).toBe('[COMPLAINT] the leak came back two days after the repair');
    expect(note.payload.targetKind).toBe('customer');
    expect(note.payload.targetReference).toBe('Mrs. Patel');
    expect(note.summary).toBe('Complaint from Mrs. Patel');
    // Capture-class, no trust tier → always human-confirmed.
    expect(note.status).toBe('draft');
    // Contract-valid against the EXISTING add_note schema.
    expect(() => assertValidProposalPayload('add_note', note.payload)).not.toThrow();

    const callback = all.find((p) => p.proposalType === 'callback')!;
    expect(callback.payload.reason).toBe('customer_complaint_followup');
    expect(callback.payload.transcript).toContain('the leak came back');
    expect(callback.summary).toBe('Complaint follow-up — call Mrs. Patel back');
    expect(callback.status).toBe('draft');
    expect(() => assertValidProposalPayload('callback', callback.payload)).not.toThrow();
    // Normal severity: no _meta markers on either payload.
    expect(note.payload._meta).toBeUndefined();
    expect(callback.payload._meta).toBeUndefined();
  });

  it('high-severity wording flags _meta.markers with reason complaint_high_severity on BOTH proposals', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      complaintClassification({ customerName: 'Mr. Jones' }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, extendedIntentsEnabled: async () => true });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'op-1',
        transcript: 'Mr. Jones says the job was botched and he wants a refund or he is calling his lawyer',
      }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('t-1');
    const note = all.find((p) => p.proposalType === 'add_note')!;
    const callback = all.find((p) => p.proposalType === 'callback')!;
    for (const proposal of [note, callback]) {
      const meta = proposal.payload._meta as { markers?: Array<{ reason: string }> };
      expect(meta?.markers?.[0]?.reason).toBe('complaint_high_severity');
      // The marker must survive the contract gate.
      expect(() => assertValidProposalPayload(proposal.proposalType, proposal.payload)).not.toThrow();
      // Still draft — severity never auto-executes anything.
      expect(proposal.status).toBe('draft');
    }
    expect(note.summary).toBe('HIGH-SEVERITY complaint from Mr. Jones');
    expect(callback.summary).toBe('HIGH-SEVERITY complaint — call Mr. Jones back');
  });

  it('verified caller-ID identity pins the note to the caller (targetId, customer)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([complaintClassification({})]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, extendedIntentsEnabled: async () => true });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'op-1',
        transcript: 'I want to file a complaint about the install',
        customerId: 'cust-verified-1',
      }),
      silentLogger(),
    );

    const note = (await proposalRepo.findByTenant('t-1')).find((p) => p.proposalType === 'add_note')!;
    expect(note.payload.targetKind).toBe('customer');
    expect(note.payload.targetId).toBe('cust-verified-1');
    // Note body falls back to the transcript when the classifier extracted no noteBody.
    expect(note.payload.body).toBe('[COMPLAINT] I want to file a complaint about the install');
  });

  it('no resolvable target → note holds in draft with targetId flagged missing', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([complaintClassification({})]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, extendedIntentsEnabled: async () => true });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'op-1', transcript: 'someone called to complain about a job' }),
      silentLogger(),
    );

    const note = (await proposalRepo.findByTenant('t-1')).find((p) => p.proposalType === 'add_note')!;
    expect(note.status).toBe('draft');
    expect(missingFieldsFor(note)).toContain('targetId');
  });

  it('complaintSeverity: deterministic keyword branch', () => {
    expect(complaintSeverity('I want my money back, this is going to my attorney')).toBe('high');
    expect(complaintSeverity('I will report you to the Better Business Bureau')).toBe('high');
    expect(complaintSeverity('he threatened legal action')).toBe('high');
    expect(complaintSeverity('the tech left mud on the carpet, please send someone')).toBe('normal');
    expect(complaintSeverity('')).toBe('normal');
  });

  it('complaintSeverity: BBB regex matches title-case "Better Business Bureau"', () => {
    // Fix #1: the phrase part must be case-insensitive so title-case matches.
    expect(complaintSeverity('I will report you to the Better Business Bureau')).toBe('high');
    // All-caps variant must still match (bare BBB pattern has no i flag, intentionally).
    expect(complaintSeverity('filing a report with the BBB tomorrow')).toBe('high');
    // All-lowercase must also match now that the phrase regex carries /i.
    expect(complaintSeverity('reporting to better business bureau today')).toBe('high');
  });

  it('callback dedup: companion callback carries idempotency key voice-complaint-callback:<recordingId>', async () => {
    // Fix #5: the callback proposal carries a stable idempotency key derived
    // from recordingId so concurrent-style redelivery is idempotent — if the
    // callback create races, the unique-key constraint lets exactly one win.
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'complaint',
        confidence: 0.9,
        extractedEntities: { customerName: 'Mrs. Chan' },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, extendedIntentsEnabled: async () => true });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'op-1', transcript: 'Mrs. Chan complained', recordingId: 'rec-123' }),
      silentLogger(),
    );
    const all = await proposalRepo.findByTenant('t-1');
    const callback = all.find((p) => p.proposalType === 'callback')!;
    expect(callback).toBeDefined();
    expect(callback.idempotencyKey).toBe('voice-complaint-callback:rec-123');

    // Concurrent-style redelivery: a second create with the same key must be
    // rejected by the idempotency gate (simulating what the DB constraint does
    // in production when two deliveries race past the sequential pre-check).
    await expect(proposalRepo.create(callback)).rejects.toThrow(/idempotency/i);
  });

  it('callback dedup: no recordingId — callback is created without an idempotency key', async () => {
    // Fix #5: keyless only when recordingId is genuinely absent (synthetic / test-mode).
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'complaint',
        confidence: 0.9,
        extractedEntities: {},
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, extendedIntentsEnabled: async () => true });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'op-1', transcript: 'someone complained' }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('t-1');
    const callback = all.find((p) => p.proposalType === 'callback')!;
    expect(callback).toBeDefined();
    expect(callback.idempotencyKey).toBeUndefined();
  });
});

describe('RV-080 — belt-and-braces extended intent dispatch gate', () => {
  function extendedIntentClassification(intentType: string): string {
    return JSON.stringify({ intentType, confidence: 0.9 });
  }

  const EXTENDED_INTENTS = ['complaint', 'lookup_day_overview', 'lookup_digest', 'lookup_pending_items'] as const;

  for (const intentType of EXTENDED_INTENTS) {
    it(`${intentType}: routes to clarification when extendedIntentsEnabled is absent`, async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([extendedIntentClassification(intentType)]);
      // No extendedIntentsEnabled dep → flag is false.
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

      await worker.handle(
        msg({ tenantId: 't-1', userId: 'op-1', transcript: 'what is my day looking like today' }),
        silentLogger(),
      );

      // No proposals created — the LLM-hallucinated extended intent was refused.
      const all = await proposalRepo.findByTenant('t-1');
      expect(all.filter((p) => p.proposalType === 'callback' || p.proposalType === 'add_note')).toHaveLength(0);
      // A voice_clarification is emitted instead.
      const clarifications = all.filter((p) => p.proposalType === 'voice_clarification');
      expect(clarifications).toHaveLength(1);
    });
  }

  it('complaint: dispatches normally when extendedIntentsEnabled returns true', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([extendedIntentClassification('complaint')]);
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      extendedIntentsEnabled: async () => true,
    });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'op-1', transcript: 'I want to file a complaint' }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('t-1');
    expect(all.some((p) => p.proposalType === 'add_note')).toBe(true);
    expect(all.some((p) => p.proposalType === 'callback')).toBe(true);
  });
});
