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

// OBS — capture recordVoiceError calls without touching the real PostHog SDK.
const recordVoiceErrorMock = vi.fn();
vi.mock('../../src/analytics/posthog', () => ({
  recordVoiceError: (...args: unknown[]) => recordVoiceErrorMock(...args),
}));

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
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryLeadRepository, type Lead } from '../../src/leads/lead';
import {
  createCatalogItem,
  InMemoryCatalogItemRepository,
} from '../../src/catalog/catalog-item';
import { InMemoryMaterialItemRepository } from '../../src/materials/material-item';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryUserRepository } from '../../src/users/user';
import type { Appointment } from '../../src/appointments/appointment';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';
import type { SlotConflictCheckerInput } from '../../src/ai/tasks/slot-conflict-checker';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../src/ai/resolution/entity-resolver';

/**
 * Every real deployment resolves a tenant zone (app.ts always wires
 * `tenantSchedulingResolver` off `tenant_settings.timezone`), and a booking
 * without one no longer guesses at America/New_York — it emits a
 * `voice_clarification` asking the operator to set the business timezone.
 * Booking fixtures therefore have to supply a zone the way production does.
 * Deliberately NOT Eastern, so a reintroduced US-East default fails here.
 */
const TZ_RESOLVER = async () => ({ timezone: 'America/Phoenix' });

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
    recordVoiceErrorMock.mockClear();
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

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, tenantSchedulingResolver: TZ_RESOLVER });

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

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, tenantSchedulingResolver: TZ_RESOLVER });
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

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, tenantSchedulingResolver: TZ_RESOLVER });
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
      tenantSchedulingResolver: TZ_RESOLVER,
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

  // B8 (feat: voice-transcript-and-agent-paths) — the worker now routes
  // create_customer through the SAME dedup-aware handler the telephony FSM
  // uses (CreateCustomerVoiceTaskHandler via the shared handler-registry),
  // instead of the thin passthrough. A near-duplicate customer must surface
  // an advisory `_meta.markers` entry on the draft, before approval.
  describe('B8 — create_customer draft-time duplicate detection', () => {
    it('stamps an advisory duplicate marker when a near-duplicate customer already exists — draft stays approvable', async () => {
      const customerRepo = new InMemoryCustomerRepository();
      await customerRepo.create({
        id: 'existing-cust-1',
        tenantId: 't-1',
        firstName: 'Acme',
        lastName: 'Corp',
        displayName: 'Acme Corp',
        primaryPhone: '555-0100',
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: 'u-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.93,
          extractedEntities: {
            displayName: 'Acme Corp',
            phone: '555-0100',
          },
        } satisfies IntentClassification),
      ]);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, customerRepo });

      await worker.handle(
        msg({
          tenantId: 't-1',
          userId: 'u-1',
          transcript: 'Add customer Acme Corp, phone 555-0100',
        }),
        silentLogger(),
      );

      const byTenant = await proposalRepo.findByTenant('t-1');
      expect(byTenant).toHaveLength(1);
      expect(byTenant[0].proposalType).toBe('create_customer');
      // Advisory only — never blocks. Still 'draft', same as an unflagged
      // create_customer proposal (create_customer never auto-approves).
      expect(byTenant[0].status).toBe('draft');
      const payload = byTenant[0].payload as Record<string, unknown>;
      const meta = payload._meta as { markers?: Array<{ path: string; reason: string }> } | undefined;
      expect(meta?.markers?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(meta!.markers![0].reason).toMatch(/duplicate|match/i);
    });

    it('drafts cleanly (no marker) when no near-duplicate exists', async () => {
      const customerRepo = new InMemoryCustomerRepository();
      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.93,
          extractedEntities: { displayName: 'Brand New Co', phone: '555-9999' },
        } satisfies IntentClassification),
      ]);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, customerRepo });

      await worker.handle(
        msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Add customer Brand New Co, phone 555-9999' }),
        silentLogger(),
      );

      const byTenant = await proposalRepo.findByTenant('t-1');
      expect(byTenant).toHaveLength(1);
      const payload = byTenant[0].payload as Record<string, unknown>;
      expect(payload._meta).toBeUndefined();
    });

    it('omits the marker (failure-soft) when the customerRepo dedup lookup throws', async () => {
      const customerRepo = new InMemoryCustomerRepository();
      // Force findDuplicates to throw so checkCustomerDuplicatesPg's catch
      // path is exercised — the create_customer draft must still succeed.
      vi.spyOn(customerRepo, 'findDuplicates').mockRejectedValue(new Error('db down'));

      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.93,
          extractedEntities: { displayName: 'Acme Corp', phone: '555-0100' },
        } satisfies IntentClassification),
      ]);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, customerRepo });

      await worker.handle(
        msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Add customer Acme Corp, phone 555-0100' }),
        silentLogger(),
      );

      const byTenant = await proposalRepo.findByTenant('t-1');
      expect(byTenant).toHaveLength(1);
      expect(byTenant[0].proposalType).toBe('create_customer');
      const payload = byTenant[0].payload as Record<string, unknown>;
      expect(payload._meta).toBeUndefined();
    });

    it('drafts a phone-less create_customer proposal instead of a needs_callback clarification (no caller-ID on this surface)', async () => {
      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.9,
          extractedEntities: { displayName: 'Sarah' },
        } satisfies IntentClassification),
      ]);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

      await worker.handle(
        msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Add customer Sarah' }),
        silentLogger(),
      );

      const byTenant = await proposalRepo.findByTenant('t-1');
      expect(byTenant).toHaveLength(1);
      expect(byTenant[0].proposalType).toBe('create_customer');
      const payload = byTenant[0].payload as Record<string, unknown>;
      expect(payload.name).toBe('Sarah');
      expect(payload.phone).toBeUndefined();
    });
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
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, tenantSchedulingResolver: TZ_RESOLVER });

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

  // B4 (feat: voice-transcript-and-agent-paths) — the worker's issue_invoice
  // now routes through the SAME handler the assistant surface uses
  // (ai/orchestration/task-router.ts's IssueInvoiceTaskHandler), built by the
  // shared registry with proposalRepo threaded through. Before this unit the
  // worker's local handler had NO missingFields gate at all: an unresolvable
  // "issue the invoice" landed with an empty payload and status draft/
  // ready_for_review with nothing blocking Approve, so approval succeeded
  // and execution then failed on the empty invoiceId. This is a deliberate
  // BEHAVIOR CHANGE: the same case now lands gated.
  describe('issue_invoice — unified handler parity with the assistant surface', () => {
    it('an INV-number reference resolves ungated (rung 1)', async () => {
      const gateway = gatewayReturning([
        JSON.stringify({
          intentType: 'issue_invoice',
          confidence: 0.95,
          extractedEntities: { jobReference: 'INV-0042' },
        }),
      ]);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

      await worker.handle(
        msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Issue invoice INV-0042' }),
        silentLogger(),
      );

      const byTenant = await proposalRepo.findByTenant('t-1');
      expect(byTenant).toHaveLength(1);
      expect(byTenant[0].proposalType).toBe('issue_invoice');
      expect(missingFieldsFor(byTenant[0])).toEqual([]);
      expect((byTenant[0].payload as Record<string, unknown>).invoiceId).toBe('INV-0042');
    });

    // BEHAVIOR CHANGE (see describe-block comment): previously ungated.
    it('an unresolvable reference ("issue the invoice", no conversation match) now lands GATED, not ungated-and-doomed', async () => {
      const gateway = gatewayReturning([
        JSON.stringify({ intentType: 'issue_invoice', confidence: 0.9, extractedEntities: {} }),
      ]);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

      await worker.handle(
        msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Issue the invoice' }),
        silentLogger(),
      );

      const byTenant = await proposalRepo.findByTenant('t-1');
      expect(byTenant).toHaveLength(1);
      expect(byTenant[0].proposalType).toBe('issue_invoice');
      expect(byTenant[0].payload).toEqual({});
      expect(missingFieldsFor(byTenant[0])).toEqual(['invoiceId']);
      expect(byTenant[0].status).toBe('draft');
    });

    it('"the one we just drafted" resolves from same-conversation draft_invoice history — ungated, verifiedIds stamped', async () => {
      const draftGateway = gatewayReturning([
        JSON.stringify({
          intentType: 'create_invoice',
          confidence: 0.9,
          extractedEntities: { customerName: 'Acme' },
        }),
        JSON.stringify({
          customerId: 'cust-1',
          jobId: 'job-1',
          lineItems: [{ description: 'Pipe repair', quantity: 1, unitPrice: 45000 }],
          confidence_score: 0.9,
        }),
      ]);
      const draftWorker = createVoiceActionRouterWorker({ gateway: draftGateway, proposalRepo });
      await draftWorker.handle(
        msg({
          tenantId: 't-1',
          userId: 'u-1',
          transcript: 'Create an invoice for Acme for 450 dollars',
          conversationId: 'conv-1',
        }),
        silentLogger(),
      );
      const drafted = (await proposalRepo.findByTenant('t-1')).find((p) => p.proposalType === 'draft_invoice')!;
      expect(drafted).toBeDefined();
      // The execution handler stamps resultEntityId on approve/execute — this
      // unit only tests drafting, so simulate that stamp directly (mirrors
      // how other worker tests seed prior conversation state).
      await proposalRepo.update('t-1', drafted.id, { resultEntityId: 'invoice-drafted-123' });

      const issueGateway = gatewayReturning([
        JSON.stringify({ intentType: 'issue_invoice', confidence: 0.9, extractedEntities: {} }),
      ]);
      const issueWorker = createVoiceActionRouterWorker({ gateway: issueGateway, proposalRepo });
      await issueWorker.handle(
        msg({
          tenantId: 't-1',
          userId: 'u-1',
          transcript: 'Issue the invoice we just drafted',
          conversationId: 'conv-1',
        }),
        silentLogger(),
      );

      const issued = (await proposalRepo.findByTenant('t-1')).find(
        (p) => p.proposalType === 'issue_invoice',
      )!;
      expect(issued).toBeDefined();
      expect(missingFieldsFor(issued)).toEqual([]);
      expect((issued.payload as Record<string, unknown>).invoiceId).toBe('invoice-drafted-123');
      expect(issued.sourceContext?.verifiedIds).toEqual({ invoiceId: 'invoice-drafted-123' });
    });
  });

  it('routes send_estimate as comms (draft-only, never auto-approves) and gates free-text estimateId', async () => {
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
    // Free-text refs must stay gated — execution requires a UUID estimateId
    // and has no reference-resolution step of its own (doomed-approval fix).
    expect(missingFieldsFor(byTenant[0])).toEqual(['estimateId']);
    expect(payload).not.toHaveProperty('estimateId');
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

  // B7 (feat: voice-transcript-and-agent-paths) — update_job. The task
  // handler makes its own dedicated LLM call to extract the field delta, so
  // this needs a SECOND scripted gateway response after classify_intent.
  it('routes update_job when the classifier returns a jobReference, gated on jobId (no jobRepo wired)', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'update_job',
        confidence: 0.9,
        extractedEntities: { jobReference: 'the Henderson job' },
      }),
      JSON.stringify({
        jobReference: 'the Henderson job',
        status: 'in_progress',
        confidence_score: 0.9,
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Mark the Henderson job in progress',
      }),
      silentLogger()
    );

    const byTenant = await proposalRepo.findByTenant('t-1');
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0].proposalType).toBe('update_job');
    const payload = byTenant[0].payload as Record<string, unknown>;
    expect(payload.status).toBe('in_progress');
    expect(byTenant[0].sourceContext?.missingFields).toEqual(
      expect.arrayContaining(['jobId'])
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
    // OBS — fired before the rethrow above; the queue-retry behavior pinned
    // by the assertion above is unchanged by adding this analytics call.
    expect(recordVoiceErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: 'action_router_failed',
        channel: 'worker',
        tenantId: 't-1',
        taskType: 'draft_invoice',
      }),
    );
  });

  it('propagates classifier/gateway errors so the queue can retry, and fires voice_error(action_router_failed)', async () => {
    const gateway = {
      complete: vi.fn().mockRejectedValue(new Error('gateway timeout')),
    } as unknown as LLMGateway;
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await expect(
      worker.handle(
        msg({ tenantId: 't-2', userId: 'u-1', transcript: 'create an invoice for Acme' }),
        silentLogger()
      )
    ).rejects.toThrow(/gateway timeout/);
    expect(recordVoiceErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: 'action_router_failed',
        channel: 'worker',
        tenantId: 't-2',
      }),
    );
    // No proposal was persisted for the failed classification.
    expect(await proposalRepo.findByTenant('t-2')).toHaveLength(0);
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

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, appointmentRepo, tenantSchedulingResolver: TZ_RESOLVER });

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

  it('without the owner opt-in dep, classifier still gets customer protection but not owner lookups', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning(['{"intentType":"unknown","confidence":0.9}']);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({ tenantId: 'tenant-1', userId: 'user-1', transcript: "What's my day look like?" }),
      silentLogger(),
    );

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    // base + customer protection (router always enables protection)
    expect(systemMessages.length).toBe(2);
    expect(systemMessages.some((m: { content: string }) => m.content.includes('negotiation'))).toBe(
      true,
    );
    expect(
      systemMessages.some((m: { content: string }) => m.content.includes('lookup_day_overview')),
    ).toBe(false);
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

  // Owner extended LOOKUPS still require extendedIntentsEnabled.
  const OWNER_LOOKUPS = ['lookup_day_overview', 'lookup_digest', 'lookup_pending_items'] as const;

  for (const intentType of OWNER_LOOKUPS) {
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

  it('complaint: dispatches without extendedIntentsEnabled (customer protection always on)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([extendedIntentClassification('complaint')]);
    // No extendedIntentsEnabled — protection intents still act.
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'op-1', transcript: 'I want to file a complaint' }),
      silentLogger(),
    );

    const all = await proposalRepo.findByTenant('t-1');
    expect(all.some((p) => p.proposalType === 'add_note')).toBe(true);
  });

  it('complaint: still dispatches when extendedIntentsEnabled returns true', async () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// U3 (iOS blueprint) — E-lane answers on the recorded-memo path. The lookup
// branch executes the skill via the per-skill adapter, persists the routed
// outcome on the recording (answer_status + answer), emits lookup_events, and
// NEVER mints a proposal for an executed lookup.
// ─────────────────────────────────────────────────────────────────────────────
describe('voice-action-router U3 lookup answers (recorded-memo path)', () => {
  const TENANT = 't-1';
  const RECORDING_ID = '7d3f8a52-1234-4cde-9f00-aaaaaaaaaaaa';
  const CUSTOMER_ID = '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1';

  function classify(intentType: string, extractedEntities?: Record<string, unknown>): string {
    return JSON.stringify({ intentType, confidence: 0.95, extractedEntities });
  }

  function seededVoiceRepo(createdBy = 'user-owner'): InMemoryVoiceRepository {
    const repo = new InMemoryVoiceRepository();
    void repo.create({
      id: RECORDING_ID,
      tenantId: TENANT,
      fileId: 'file-1',
      status: 'completed',
      transcript: 'spoken memo',
      answerStatus: 'pending',
      createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return repo;
  }

  function resolverResolving(customerId: string): EntityResolver {
    return {
      resolve: vi.fn(async () => ({
        kind: 'resolved',
        candidate: { id: customerId, kind: 'customer', label: 'Henderson', score: 0.99 },
      })) as unknown as EntityResolver['resolve'],
    };
  }

  function lookupEventsSpy() {
    return { record: vi.fn(async () => ({}) as never) };
  }

  it('executes the lookup skill, stores the answer, emits lookup_events, and mints NO proposal', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo();
    const lookupEvents = lookupEventsSpy();
    const gateway = gatewayReturning([
      classify('lookup_balance', { customerName: 'Henderson' }),
    ]);
    const jobRepo = {
      findByCustomer: vi.fn(async () => [{ id: 'job-1' }]),
    };
    const invoiceRepo = {
      findByJob: vi.fn(async () => [
        { id: 'inv-1', amountDueCents: 12300, dueDate: new Date('2026-07-28T00:00:00Z') },
      ]),
    };

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      entityResolver: resolverResolving(CUSTOMER_ID),
      jobRepo: jobRepo as never,
      lookupAnswers: {
        invoiceRepo: invoiceRepo as never,
        lookupEvents: lookupEvents as never,
      },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: "what's the Henderson balance",
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    // No proposal minted for an executed lookup.
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('answered');
    expect(rec?.answer).toMatchObject({
      version: 1,
      intent: 'lookup_balance',
      result: 'found',
      entityRef: { kind: 'customer', id: CUSTOMER_ID },
    });
    // Money rides the answer as INTEGER CENTS.
    expect(rec?.answer?.rows).toContainEqual({
      kind: 'money',
      label: 'Outstanding balance',
      amountCents: 12300,
    });
    // Analytics row written on the memo path, keyed by the recording id.
    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        intent: 'lookup_balance',
        sessionId: RECORDING_ID,
        resultStatus: 'found',
      }),
    );
  });

  it('ambiguous customer reference mints a voice_clarification and stamps clarification', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo();
    const gateway = gatewayReturning([classify('lookup_balance', { customerName: 'Bob' })]);
    const ambiguousResolver: EntityResolver = {
      resolve: vi.fn(async () => ({
        kind: 'ambiguous',
        candidates: [
          { id: 'c-1', kind: 'customer', label: 'Bob Smith', score: 0.9 },
          { id: 'c-2', kind: 'customer', label: 'Bob Jones', score: 0.88 },
        ],
      })) as unknown as EntityResolver['resolve'],
    };

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      entityResolver: ambiguousResolver,
      jobRepo: { findByCustomer: vi.fn(async () => []) } as never,
      lookupAnswers: { invoiceRepo: { findByJob: vi.fn(async () => []) } as never },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: "what's Bob's balance",
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('voice_clarification');
    expect((proposals[0].payload as { reason?: string }).reason).toBe('ambiguous_entity');

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('clarification');
    expect(rec?.answer).toBeUndefined();
  });

  it('technician-recorded revenue ask gets a refusal answer, never data', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo('user-tech');
    const gateway = gatewayReturning([classify('lookup_revenue')]);
    const query = vi.fn(async () => ({ revenueCents: 500000, outstandingCents: 10000 }));
    const resolveMemberRole = vi.fn(async () => 'technician');

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      lookupAnswers: {
        moneyDashboardRepo: { query } as never,
        resolveMemberRole,
      },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: "how's revenue this month",
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    // Role resolved from the RECORDING's creator, not the payload userId.
    expect(resolveMemberRole).toHaveBeenCalledWith(TENANT, 'user-tech');
    // The refusal short-circuits BEFORE the skill — no data read at all.
    expect(query).not.toHaveBeenCalled();

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('answered');
    expect(rec?.answer?.result).toBe('refused');
    expect(rec?.answer?.rows).toEqual([]);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('owner-recorded revenue ask answers with integer-cents rows', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo('user-owner');
    const gateway = gatewayReturning([classify('lookup_revenue')]);

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      lookupAnswers: {
        moneyDashboardRepo: {
          query: vi.fn(async () => ({ revenueCents: 500000, outstandingCents: 10000 })),
        } as never,
        resolveMemberRole: vi.fn(async () => 'owner'),
      },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: "how's revenue this month",
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('answered');
    expect(rec?.answer?.result).toBe('found');
    expect(rec?.answer?.rows).toContainEqual({
      kind: 'money',
      label: 'Revenue this month',
      amountCents: 500000,
    });
  });

  it('non-opted tenant extended lookup keeps the clarification behavior (no answer)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo();
    const gateway = gatewayReturning([classify('lookup_pending_items')]);
    const digestQuery = vi.fn(async () => []);

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      // extendedIntentsEnabled ABSENT → tenant not opted in.
      lookupAnswers: {
        estimateRepo: { findByTenant: digestQuery } as never,
        invoiceRepo: { findByTenant: digestQuery } as never,
        resolveMemberRole: vi.fn(async () => 'owner'),
      },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: 'what needs my approval',
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('voice_clarification');
    expect(digestQuery).not.toHaveBeenCalled();

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('clarification');
  });

  it('opted-in tenant extended lookup executes and answers (digest)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo();
    const gateway = gatewayReturning([classify('lookup_digest')]);

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      extendedIntentsEnabled: async () => true,
      lookupAnswers: {
        dailyDigestRepo: {
          findByTenantAndDate: vi.fn(async () => ({
            digestDate: '2026-07-20',
            narrative: 'Two jobs completed; one invoice paid.',
            payload: {},
          })),
          findLatest: vi.fn(async () => null),
        } as never,
        resolveMemberRole: vi.fn(async () => 'owner'),
      },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: 'read me the digest',
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('answered');
    expect(rec?.answer?.result).toBe('found');
    expect(rec?.answer?.summary).toMatch(/Two jobs completed/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('skill failure stamps answer_status=failed with no answer payload', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo();
    const gateway = gatewayReturning([classify('lookup_revenue')]);

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      lookupAnswers: {
        moneyDashboardRepo: {
          query: vi.fn(async () => {
            throw new Error('db down');
          }),
        } as never,
        resolveMemberRole: vi.fn(async () => 'owner'),
      },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: "how's revenue",
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('failed');
    expect(rec?.answer).toBeUndefined();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('keeps the read-only skip on paths without a recordingId (eval harness / in-app text)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const recordAnswer = vi.spyOn(voiceRepo, 'recordAnswer');
    const gateway = gatewayReturning([classify('lookup_balance', { customerName: 'Henderson' })]);

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      entityResolver: resolverResolving(CUSTOMER_ID),
      jobRepo: { findByCustomer: vi.fn(async () => []) } as never,
      lookupAnswers: { invoiceRepo: { findByJob: vi.fn(async () => []) } as never },
    });

    await worker.handle(
      msg({ tenantId: TENANT, userId: 'u-1', transcript: "what's the Henderson balance" }),
      silentLogger(),
    );

    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it('customer-scoped ask with no resolvable customer answers "nothing found" (no guess)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo();
    const gateway = gatewayReturning([classify('lookup_balance', { customerName: 'Zzyzx' })]);
    const notFoundResolver: EntityResolver = {
      resolve: vi.fn(async () => ({ kind: 'not_found', reference: 'Zzyzx' })) as never,
    };

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      voiceRepo,
      entityResolver: notFoundResolver,
      jobRepo: { findByCustomer: vi.fn(async () => []) } as never,
      lookupAnswers: { invoiceRepo: { findByJob: vi.fn(async () => []) } as never },
    });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'system',
        transcript: "what's the Zzyzx balance",
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('answered');
    expect(rec?.answer?.result).toBe('none');
    expect(rec?.answer?.summary).toMatch(/Zzyzx/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('stamps proposal on the recording when a drafting intent lands (two-phase contract)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const voiceRepo = seededVoiceRepo();
    const gateway = gatewayReturning([
      classify('create_invoice', { customerName: 'Acme' }),
      JSON.stringify({
        customerId: 'cust-1',
        jobId: 'job-1',
        lineItems: [{ description: 'Pipe repair', quantity: 1, unitPrice: 45000 }],
        confidence_score: 0.9,
      }),
    ]);

    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, voiceRepo });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'u-1',
        transcript: 'Invoice Acme 450 dollars',
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );

    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
    const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
    expect(rec?.answerStatus).toBe('proposal');
  });

  // U7 — operator-surface lookup parity: lookup_leads / lookup_catalog now
  // answer on the memo path via the SAME shared skills telephony calls,
  // instead of falling through to the `unsupported` skip.
  describe('U7 operator-surface lookup parity (leads, catalog)', () => {
    function lead(id: string, stage: Lead['stage']): Lead {
      const now = new Date();
      return {
        id,
        tenantId: TENANT,
        firstName: 'Lead',
        lastName: id,
        source: 'phone_call',
        stage,
        createdBy: 'user-owner',
        createdAt: now,
        updatedAt: now,
      };
    }

    function seededCatalogRepo(): InMemoryCatalogItemRepository {
      const repo = new InMemoryCatalogItemRepository();
      void repo.create(
        createCatalogItem({
          tenantId: TENANT,
          name: 'Drain cleaning',
          category: 'Labor',
          unit: 'hour',
          unitPriceCents: 22500,
        }),
      );
      void repo.create(
        createCatalogItem({
          tenantId: TENANT,
          name: 'Water heater flush',
          category: 'Labor',
          unit: 'each',
          unitPriceCents: 14900,
        }),
      );
      return repo;
    }

    it('lookup_leads answers on the memo path and emits the voice_lookup_answered audit event', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo('user-tech');
      const auditRepo = new InMemoryAuditRepository();
      const lookupEvents = lookupEventsSpy();
      const gateway = gatewayReturning([classify('lookup_leads')]);
      const leadRepo = new InMemoryLeadRepository();
      await leadRepo.create(lead('lead-1', 'new'));
      await leadRepo.create(lead('lead-2', 'qualified'));
      await leadRepo.create(lead('lead-3', 'won')); // closed — not "open"
      // Technicians hold `customers:view` (the GET /api/leads gate), so the
      // same role that can open the leads screen gets the spoken answer.
      const resolveMemberRole = vi.fn(async () => 'technician');

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        auditRepo,
        lookupAnswers: {
          leadRepo,
          lookupEvents: lookupEvents as never,
          resolveMemberRole,
        },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'how many open leads do we have',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      // Role resolved from the RECORDING's creator, like the owner reports.
      expect(resolveMemberRole).toHaveBeenCalledWith(TENANT, 'user-tech');

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('answered');
      expect(rec?.answer?.result).toBe('found');
      // The skill's real data-derived copy — won/lost leads excluded.
      expect(rec?.answer?.summary).toBe('There are 2 open leads in the pipeline.');
      expect(rec?.answer?.rows).toContainEqual({ kind: 'count', label: 'Open leads', count: 2 });
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

      // voice_lookup_answered parity with the other lookups (router :2429).
      const audited = (await auditRepo.findByEntity(TENANT, 'voice_recording', RECORDING_ID)).filter(
        (e) => e.eventType === 'voice_lookup_answered',
      );
      expect(audited).toHaveLength(1);
      expect(audited[0].metadata).toMatchObject({
        intent: 'lookup_leads',
        answerStatus: 'answered',
        result: 'found',
      });
      // Same lookup_events analytics row telephony writes.
      expect(lookupEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          intent: 'lookup_leads',
          sessionId: RECORDING_ID,
          resultStatus: 'found',
        }),
      );
    });

    it('empty lead pipeline answers honestly with result=none (no fabrication)', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo();
      const gateway = gatewayReturning([classify('lookup_leads')]);

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: {
          leadRepo: new InMemoryLeadRepository(),
          resolveMemberRole: vi.fn(async () => 'owner'),
        },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'how many open leads do we have',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('answered');
      expect(rec?.answer?.result).toBe('none');
      // The skill's honest empty-state copy, verbatim — never an invention.
      expect(rec?.answer?.summary).toBe('There are no open leads in the pipeline right now.');
      expect(rec?.answer?.rows).toEqual([]);
    });

    it('owner-recorded catalog ask answers with integer-cents price rows', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo('user-owner');
      const gateway = gatewayReturning([classify('lookup_catalog')]);

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: {
          catalogRepo: seededCatalogRepo(),
          resolveMemberRole: vi.fn(async () => 'owner'),
        },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what services do we offer',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('answered');
      expect(rec?.answer?.result).toBe('found');
      expect(rec?.answer?.summary).toContain('Drain cleaning');
      expect(rec?.answer?.summary).toContain('Water heater flush');
      expect(rec?.answer?.rows).toContainEqual({ kind: 'count', label: 'Catalog items', count: 2 });
      // The catalog's exact integer cents ride the rows — never floats.
      expect(rec?.answer?.rows).toContainEqual({
        kind: 'money',
        label: 'Drain cleaning',
        amountCents: 22500,
      });
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    });

    it('technician-recorded catalog ask gets a refusal (settings:view gate), never the price book', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo('user-tech');
      const gateway = gatewayReturning([classify('lookup_catalog')]);
      const catalogRepo = seededCatalogRepo();
      const listByTenant = vi.spyOn(catalogRepo, 'listByTenant');

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: {
          catalogRepo,
          resolveMemberRole: vi.fn(async () => 'technician'),
        },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what services do we offer',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      // The refusal short-circuits BEFORE the skill — no data read at all.
      expect(listByTenant).not.toHaveBeenCalled();

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('answered');
      expect(rec?.answer?.result).toBe('refused');
      expect(rec?.answer?.summary).toBe(
        'The service catalog is an office-level view. Ask an owner or dispatcher on your team to pull it up.',
      );
      // No item names or prices leak into the refusal.
      expect(rec?.answer?.summary).not.toContain('Drain cleaning');
      expect(rec?.answer?.rows).toEqual([]);
    });
  });

  // Task 9 (2026-08-07 tradesperson plan) — lookup_materials reads back
  // Task 8's material_items shopping list. UNLIKE lookup_leads/
  // lookup_catalog, there is deliberately NO entry in
  // LOOKUP_REQUIRED_PERMISSION for this intent — any authenticated operator
  // (technician included) may hear the shopping list, so these tests never
  // wire resolveMemberRole and still expect a real answer.
  describe('Task 9 — lookup_materials (voice shopping list readback)', () => {
    it('reads back the pending list — no permission gate, technician-recorded memo still gets real data', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo('user-tech');
      const lookupEvents = lookupEventsSpy();
      const gateway = gatewayReturning([classify('lookup_materials')]);
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT,
        description: '3 boxes 1/2" PEX',
        quantity: 3,
        createdBy: 'user-owner',
      });
      await materialItemRepo.create({
        tenantId: TENANT,
        description: 'Flue liner kit',
        quantity: 1,
        vendor: 'Ferguson',
        createdBy: 'user-owner',
      });

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: {
          materialItemRepo: materialItemRepo as never,
          lookupEvents: lookupEvents as never,
        },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'read me the shopping list',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      // No proposal minted for an executed (read-only) lookup.
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('answered');
      expect(rec?.answer?.result).toBe('found');
      expect(rec?.answer?.summary).toContain('2 items');
      // Quality-review I2 — the multiplication sign ("3×") reads as "three
      // times" on Amazon Polly and is typically dropped on Google Cloud
      // TTS; quantity is always spoken as the word "quantity".
      expect(rec?.answer?.summary).toContain('3 boxes 1/2" PEX, quantity 3');
      expect(rec?.answer?.summary).not.toContain('×');
      expect(lookupEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          intent: 'lookup_materials',
          sessionId: RECORDING_ID,
          resultStatus: 'found',
        }),
      );
    });

    it('an empty list answers honestly with result=none (no fabrication)', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo();
      const gateway = gatewayReturning([classify('lookup_materials')]);

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: { materialItemRepo: new InMemoryMaterialItemRepository() as never },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what parts do I need',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('answered');
      expect(rec?.answer?.result).toBe('none');
      expect(rec?.answer?.rows).toEqual([]);
    });

    it('with no materialItemRepo wired, the intent is skipped (unsupported), never a fabricated answer', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo();
      const gateway = gatewayReturning([classify('lookup_materials')]);

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: {},
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what parts do I need',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('skipped');
    });

    // Follow-up (2026-08-09) — job-scoping is real (via jobId), AND a date
    // phrase like "tomorrow" is now ALSO a real filter:
    // materialItemRepo.listPending grew `neededByBefore`, and
    // lookup-materials.ts resolves the classifier's `dateTimeDescription`
    // slot (the SAME generic slot lookup_crew_schedule uses) via
    // `resolveSpokenDay` — see lookup-materials.ts's module doc comment.
    // The classifier taxonomy advertises "for tomorrow" phrasing again for
    // this reason (spec-review MAJOR B is resolved, not just mitigated).
    // Any captured neededBy is STILL spoken per-item regardless (an
    // unfiltered or date-scoped answer can both contain several different
    // dates before/within the window) — see the 'surfaces a captured
    // needed-by date' test below, and the 'date-scoped ask' describe block
    // further down for the new filter's end-to-end coverage.
    //
    // Quality-review M5 — a real UUID, not the literal string 'job-patel':
    // InMemoryMaterialItemRepository accepts any string as a jobId, but
    // PgMaterialItemRepository's isUuid guard would return [] for a
    // non-UUID jobId — a non-UUID fixture here could never catch a
    // regression in that guard.
    const JOB_PATEL_ID = '77777777-7777-4777-8777-777777777777';

    it('a pre-verified jobId (VoiceActionRouterPayload.jobId) scopes the list to that job', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo();
      const gateway = gatewayReturning([classify('lookup_materials')]);
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT,
        description: 'unscoped item',
        createdBy: 'user-owner',
      });
      await materialItemRepo.create({
        tenantId: TENANT,
        description: 'Patel job item',
        jobId: JOB_PATEL_ID,
        createdBy: 'user-owner',
      });

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: { materialItemRepo: materialItemRepo as never },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what materials are open on the Patel job',
          recordingId: RECORDING_ID,
          jobId: JOB_PATEL_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answer?.result).toBe('found');
      expect(rec?.answer?.summary).toContain('1 item');
      expect(rec?.answer?.summary).toContain('Patel job item');
      expect(rec?.answer?.summary).not.toContain('unscoped item');
    });

    // Spec-review MAJOR A — the worse-than-nothing failure mode: an
    // operator NAMES a job scope, the resolver can't match it, and the
    // answer must refuse honestly (mirrors lookup_job_profit's identical
    // guard) rather than silently widening to the tenant's WHOLE pending
    // list. Before this fix, this exact scenario answered 'found' with
    // every pending item.
    it('an unresolved spoken job reference refuses honestly — never silently widens to the whole tenant list', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo();
      const gateway = gatewayReturning([classify('lookup_materials', { jobReference: 'the Patel job' })]);
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT,
        description: 'unrelated tenant-wide item',
        createdBy: 'user-owner',
      });
      const notFoundResolver: EntityResolver = {
        resolve: vi.fn(async () => ({
          kind: 'not_found',
          reference: 'the Patel job',
        })) as unknown as EntityResolver['resolve'],
      };

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        entityResolver: notFoundResolver,
        lookupAnswers: { materialItemRepo: materialItemRepo as never },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what materials are open on the Patel job',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answer?.result).toBe('none');
      expect(rec?.answer?.summary).toBe('I couldn\'t find a job matching "the Patel job".');
      // The exact bug this test pins: the unscoped item must NEVER leak
      // into a "job not found" answer.
      expect(rec?.answer?.summary).not.toContain('unrelated tenant-wide item');
      expect(rec?.answer?.rows).toEqual([]);
    });

    // I3(b) router-level piece — a skill-level error must route to
    // answerStatus='failed', never crash the message or fabricate data.
    it('a repo error routes to answerStatus=failed', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo();
      const gateway = gatewayReturning([classify('lookup_materials')]);
      const throwingRepo = {
        listPending: vi.fn(async () => {
          throw new Error('db down');
        }),
        create: vi.fn(),
        markPurchased: vi.fn(),
      };

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: { materialItemRepo: throwingRepo as never },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what parts do I need',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answerStatus).toBe('failed');
    });

    // Spec-review MAJOR B(2) — neededBy is captured by add_material and
    // must not be silently dropped on the read side just because it isn't
    // a query filter.
    it('surfaces a captured needed-by date in the spoken answer and the row', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const voiceRepo = seededVoiceRepo();
      const gateway = gatewayReturning([classify('lookup_materials')]);
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT,
        description: '40-gallon water heater',
        quantity: 2,
        vendor: 'Ferguson',
        neededBy: new Date('2026-08-09T00:00:00Z'),
        createdBy: 'user-owner',
      });

      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        voiceRepo,
        lookupAnswers: { materialItemRepo: materialItemRepo as never },
      });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'system',
          transcript: 'what parts do I need',
          recordingId: RECORDING_ID,
        }),
        silentLogger(),
      );

      const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
      expect(rec?.answer?.summary).toContain('needed by August 9');
      const row = rec?.answer?.rows?.[0] as { text?: string } | undefined;
      expect(row?.text).toContain('needed by August 9');
    });

    // Follow-up (2026-08-09) — end-to-end proof that a spoken date phrase
    // reaches the repo as a real `neededByBefore` filter: classifier ->
    // dateTimeDescription (the generic slot, ungated per-intent — see
    // lookup-dispatch.ts / voice-action-router.ts) -> executeLookupAnswer's
    // `lookup_materials` case -> lookupMaterials's resolveSpokenDay -> a
    // date-scoped SQL/in-memory query.
    describe('date-scoped ask ("for tomorrow")', () => {
      // 2026-06-11 (Thursday) ~07:00 New York (11:00 UTC) — matches
      // lookup-materials.test.ts's own fixture, so "tomorrow" resolves to
      // the same 2026-06-12 in both suites.
      const FIXED_NOW = new Date('2026-06-11T11:00:00.000Z');

      it('scopes the spoken list to items due by the resolved day, excluding later and undated items', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo();
        const gateway = gatewayReturning([
          classify('lookup_materials', { dateTimeDescription: 'tomorrow' }),
        ]);
        const materialItemRepo = new InMemoryMaterialItemRepository();
        await materialItemRepo.create({
          tenantId: TENANT,
          description: 'due tomorrow',
          neededBy: new Date('2026-06-12T00:00:00Z'),
          createdBy: 'user-owner',
        });
        await materialItemRepo.create({
          tenantId: TENANT,
          description: 'due next month',
          neededBy: new Date('2026-07-01T00:00:00Z'),
          createdBy: 'user-owner',
        });
        await materialItemRepo.create({
          tenantId: TENANT,
          description: 'no date at all',
          createdBy: 'user-owner',
        });

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          now: () => FIXED_NOW,
          lookupAnswers: { materialItemRepo: materialItemRepo as never },
        });

        await worker.handle(
          msg({
            tenantId: TENANT,
            userId: 'system',
            transcript: 'what do I need for tomorrow',
            recordingId: RECORDING_ID,
          }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('found');
        expect(rec?.answer?.summary).toContain('needed by June 12');
        expect(rec?.answer?.summary).toContain('due tomorrow');
        expect(rec?.answer?.summary).not.toContain('due next month');
        expect(rec?.answer?.summary).not.toContain('no date at all');
        expect(rec?.answer?.rows).toHaveLength(1);
      });

      // HONESTY NOTE (review follow-up N9, 2026-08-09): a DESIGN PIN, not
      // red-first evidence — this assertion also holds against origin/main,
      // which ignored `dateTimeDescription` entirely and therefore applied
      // no filter for any phrase. What IS red-first here is the disclosure
      // assertion at the end of the test (added 2026-08-09, J3): origin/main
      // and this branch's first commit both answer an unresolvable phrase
      // with a summary byte-identical to an unscoped ask.
      it('an unparseable date phrase applies no filter — and SAYS so, never a guessed day', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo();
        const gateway = gatewayReturning([
          classify('lookup_materials', { dateTimeDescription: 'gibberish not a date' }),
        ]);
        const materialItemRepo = new InMemoryMaterialItemRepository();
        await materialItemRepo.create({
          tenantId: TENANT,
          description: 'due next month',
          neededBy: new Date('2026-07-01T00:00:00Z'),
          createdBy: 'user-owner',
        });

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          now: () => FIXED_NOW,
          lookupAnswers: { materialItemRepo: materialItemRepo as never },
        });

        await worker.handle(
          msg({
            tenantId: TENANT,
            userId: 'system',
            transcript: 'what do I need for whenever',
            recordingId: RECORDING_ID,
          }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('found');
        expect(rec?.answer?.summary).toContain('due next month');
        // The item's own captured date is still spoken per-item ("needed by
        // July 1") — what must be ABSENT is the date-SCOPE header phrase a
        // resolved filter would add ("on the materials list needed by …").
        expect(rec?.answer?.summary).not.toContain('on the materials list needed by');
        expect(rec?.answer?.summary).toContain('needed by July 1');
        // J3 — the caller must hear that their scope was dropped, verbatim
        // phrase included, rather than an answer that looks unscoped.
        expect(rec?.answer?.summary).toMatch(
          /couldn't tell which day "gibberish not a date" meant/i,
        );
      });
    });
  });

  // Task 10 (2026-08-07 tradesperson plan) — three READ-ONLY lookup-skill
  // family members. lookup_crew_schedule/lookup_timesheets are owner-
  // extended + permission-gated (reports:view) exactly like lookup_revenue
  // above; lookup_my_day is the opposite shape — no permission gate at
  // all, strictly self-scoped to the resolved SPEAKER.
  describe('Task 10 — lookup_crew_schedule, lookup_timesheets, lookup_my_day', () => {
    function makeJob(over: Partial<Job>): Job {
      return {
        id: `job-${Math.random().toString(36).slice(2, 8)}`,
        tenantId: TENANT,
        customerId: 'cust-1',
        locationId: 'loc-1',
        jobNumber: 'JOB-0001',
        summary: 'AC tune-up',
        status: 'scheduled',
        priority: 'normal',
        createdBy: 'user-owner',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        ...over,
      } as Job;
    }

    function makeAppointment(over: Partial<Appointment>): Appointment {
      const start = new Date();
      start.setHours(start.getHours() + 1, 0, 0, 0);
      return {
        id: `appt-${Math.random().toString(36).slice(2, 8)}`,
        tenantId: TENANT,
        jobId: 'job-1',
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
        timezone: 'America/New_York',
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: 'user-owner',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        ...over,
      };
    }

    async function seededUserRepo(technicians: Array<{ id: string; firstName: string; lastName: string }>) {
      const userRepo = new InMemoryUserRepository();
      for (const t of technicians) {
        await userRepo.create({
          id: t.id,
          tenantId: TENANT,
          email: `${t.id}@example.com`,
          role: 'technician',
          firstName: t.firstName,
          lastName: t.lastName,
          canFieldServe: true,
        });
      }
      return userRepo;
    }

    function technicianResolver(id: string, label: string): EntityResolver {
      return {
        resolve: vi.fn(async () => ({
          kind: 'resolved',
          candidate: { id, kind: 'technician', label, score: 0.95 },
        })) as unknown as EntityResolver['resolve'],
      };
    }

    function technicianNotFoundResolver(reference: string): EntityResolver {
      return {
        resolve: vi.fn(async () => ({ kind: 'not_found', reference })) as unknown as EntityResolver['resolve'],
      };
    }

    describe('lookup_crew_schedule', () => {
      it('technician-recorded ask gets a refusal answer, never crew data', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-tech');
        const gateway = gatewayReturning([classify('lookup_crew_schedule')]);
        const userRepo = await seededUserRepo([{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          appointmentRepo: new InMemoryAppointmentRepository(),
          jobRepo: new InMemoryJobRepository(),
          userRepo,
          extendedIntentsEnabled: async () => true,
          lookupAnswers: { resolveMemberRole: vi.fn(async () => 'technician') },
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: "who's free today", recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('refused');
        expect(rec?.answer?.rows).toEqual([]);
      });

      it('owner-recorded ask with no name reports the whole crew', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-owner');
        const gateway = gatewayReturning([classify('lookup_crew_schedule')]);
        const userRepo = await seededUserRepo([
          { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
          { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
        ]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          appointmentRepo: new InMemoryAppointmentRepository(),
          jobRepo: new InMemoryJobRepository(),
          userRepo,
          extendedIntentsEnabled: async () => true,
          lookupAnswers: { resolveMemberRole: vi.fn(async () => 'owner') },
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: "who's free today", recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('found');
        expect(rec?.answer?.summary).toContain('Mike Diaz');
        expect(rec?.answer?.summary).toContain('Carlos Ruiz');
      });

      it('a named crew member who resolves scopes the answer to ONLY that person', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-owner');
        const gateway = gatewayReturning([
          classify('lookup_crew_schedule', { targetTechnicianName: 'Mike' }),
        ]);
        const jobRepo = new InMemoryJobRepository();
        const jobMike = makeJob({ id: 'job-mike', assignedTechnicianId: 'tech-mike' });
        await jobRepo.create(jobMike);
        const appointmentRepo = new InMemoryAppointmentRepository();
        await appointmentRepo.create(makeAppointment({ id: 'appt-mike', jobId: 'job-mike' }));
        const userRepo = await seededUserRepo([
          { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
          { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
        ]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          appointmentRepo,
          jobRepo,
          userRepo,
          entityResolver: technicianResolver('tech-mike', 'Mike Diaz'),
          extendedIntentsEnabled: async () => true,
          lookupAnswers: { resolveMemberRole: vi.fn(async () => 'owner') },
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: "what's Mike's day look like", recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('found');
        expect(rec?.answer?.summary).toContain('Mike Diaz');
        expect(rec?.answer?.summary).not.toContain('Carlos');
      });

      // The single most important guard this task adds for the two
      // owner-extended crew lookups: a NAMED technician who does not
      // resolve must be refused BY NAME, never silently widened to the
      // whole crew's schedule (spec-review MAJOR A precedent, applied with
      // more force — see lookup-crew-schedule.ts's module doc comment).
      it('an unresolved crew-member name refuses honestly — never falls back to the whole crew', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-owner');
        const gateway = gatewayReturning([
          classify('lookup_crew_schedule', { targetTechnicianName: 'Zzyzx' }),
        ]);
        const jobRepo = new InMemoryJobRepository();
        const jobMike = makeJob({ id: 'job-mike', assignedTechnicianId: 'tech-mike' });
        await jobRepo.create(jobMike);
        const appointmentRepo = new InMemoryAppointmentRepository();
        await appointmentRepo.create(makeAppointment({ id: 'appt-mike', jobId: 'job-mike' }));
        const userRepo = await seededUserRepo([{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          appointmentRepo,
          jobRepo,
          userRepo,
          entityResolver: technicianNotFoundResolver('Zzyzx'),
          extendedIntentsEnabled: async () => true,
          lookupAnswers: { resolveMemberRole: vi.fn(async () => 'owner') },
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: "what's Zzyzx's day look like", recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('none');
        expect(rec?.answer?.summary).toBe('I couldn\'t find a crew member matching "Zzyzx".');
        // The exact failure mode this test pins: Mike's real booking must
        // NEVER leak into a "crew member not found" answer.
        expect(rec?.answer?.summary).not.toContain('Mike');
        expect(rec?.answer?.rows).toEqual([]);
      });
    });

    describe('lookup_timesheets', () => {
      it('technician-recorded ask gets a refusal answer, never hours data', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-tech');
        const gateway = gatewayReturning([classify('lookup_timesheets')]);
        const userRepo = await seededUserRepo([{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          userRepo,
          extendedIntentsEnabled: async () => true,
          lookupAnswers: {
            timeEntryRepo: { findByTenant: vi.fn(async () => []) } as never,
            resolveMemberRole: vi.fn(async () => 'technician'),
          },
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: 'give me everyone\'s hours for the week', recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('refused');
      });

      it('an unresolved crew-member name refuses honestly — never falls back to everyone\'s hours', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-owner');
        const gateway = gatewayReturning([
          classify('lookup_timesheets', { targetTechnicianName: 'Zzyzx' }),
        ]);
        const timeEntryFindByTenant = vi.fn(async () => []);
        const userRepo = await seededUserRepo([{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          userRepo,
          entityResolver: technicianNotFoundResolver('Zzyzx'),
          extendedIntentsEnabled: async () => true,
          lookupAnswers: {
            timeEntryRepo: { findByTenant: timeEntryFindByTenant } as never,
            resolveMemberRole: vi.fn(async () => 'owner'),
          },
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: 'how many hours did Zzyzx log this week', recordingId: RECORDING_ID }),
          silentLogger(),
        );

        // The refusal short-circuits BEFORE the skill — no data read at all.
        expect(timeEntryFindByTenant).not.toHaveBeenCalled();
        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('none');
        expect(rec?.answer?.summary).toBe('I couldn\'t find a crew member matching "Zzyzx".');
      });

      it('a named crew member who resolves scopes the answer to ONLY that person\'s hours', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-owner');
        const gateway = gatewayReturning([
          classify('lookup_timesheets', { targetTechnicianName: 'Carlos' }),
        ]);
        const now = new Date();
        const timeEntryRepo = {
          findByTenant: vi.fn(async () => [
            {
              id: 'te-1',
              tenantId: TENANT,
              userId: 'tech-carlos',
              entryType: 'job' as const,
              clockedInAt: now,
              clockedOutAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
              durationMinutes: 240,
              createdAt: now,
              updatedAt: now,
            },
          ]),
        };
        const userRepo = await seededUserRepo([
          { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
          { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
        ]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          userRepo,
          entityResolver: technicianResolver('tech-carlos', 'Carlos Ruiz'),
          extendedIntentsEnabled: async () => true,
          lookupAnswers: {
            timeEntryRepo: timeEntryRepo as never,
            resolveMemberRole: vi.fn(async () => 'owner'),
          },
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: 'how many hours did Carlos log this week', recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('found');
        expect(rec?.answer?.summary).toContain('Carlos Ruiz');
        expect(rec?.answer?.summary).not.toContain('Mike');
      });
    });

    describe('lookup_my_day', () => {
      it("a technician's own recorded memo gets real self-scoped data — NOT permission-gated", async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const voiceRepo = seededVoiceRepo('user-tech');
        const gateway = gatewayReturning([classify('lookup_my_day')]);
        const jobRepo = new InMemoryJobRepository();
        const myJob = makeJob({ id: 'job-mine', assignedTechnicianId: 'user-tech', summary: 'My AC job' });
        const theirJob = makeJob({ id: 'job-theirs', assignedTechnicianId: 'tech-carlos', summary: "Carlos's job" });
        await jobRepo.create(myJob);
        await jobRepo.create(theirJob);
        const appointmentRepo = new InMemoryAppointmentRepository();
        await appointmentRepo.create(makeAppointment({ id: 'appt-mine', jobId: 'job-mine' }));
        await appointmentRepo.create(makeAppointment({ id: 'appt-theirs', jobId: 'job-theirs' }));
        const userRepo = await seededUserRepo([
          { id: 'user-tech', firstName: 'Me', lastName: 'Technician' },
          { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
        ]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          appointmentRepo,
          jobRepo,
          userRepo,
          // lookupAnswers present but with NO resolveMemberRole wired —
          // lookup_my_day must still answer with real data since it
          // carries no permission gate.
          lookupAnswers: {},
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: "what's on my schedule today", recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        expect(rec?.answer?.result).toBe('found');
        expect(rec?.answer?.summary).toContain('My AC job');
        // Strictly self-scoped — a coworker's job must never appear.
        expect(rec?.answer?.summary).not.toContain("Carlos's job");
        expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
      });

      // The single most important security property in this task: when the
      // speaker cannot be resolved to a technician, the turn fails — it
      // must NEVER fall back to an unscoped (whole-crew) day. This intent
      // is deliberately NOT permission-gated, so this resolution IS its
      // entire access-control story.
      it('an unresolvable speaker fails the turn — NEVER falls back to the whole crew\'s day', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        // createdBy 'user-ghost' matches no row in userRepo below.
        const voiceRepo = seededVoiceRepo('user-ghost');
        const gateway = gatewayReturning([classify('lookup_my_day')]);
        const jobRepo = new InMemoryJobRepository();
        const someoneElsesJob = makeJob({ id: 'job-theirs', assignedTechnicianId: 'tech-carlos', summary: "Carlos's job" });
        await jobRepo.create(someoneElsesJob);
        const appointmentRepo = new InMemoryAppointmentRepository();
        await appointmentRepo.create(makeAppointment({ id: 'appt-theirs', jobId: 'job-theirs' }));
        const userRepo = await seededUserRepo([{ id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' }]);

        const worker = createVoiceActionRouterWorker({
          gateway,
          proposalRepo,
          voiceRepo,
          appointmentRepo,
          jobRepo,
          userRepo,
          lookupAnswers: {},
        });

        await worker.handle(
          msg({ tenantId: TENANT, userId: 'system', transcript: "what's on my schedule today", recordingId: RECORDING_ID }),
          silentLogger(),
        );

        const rec = await voiceRepo.findById(TENANT, RECORDING_ID);
        // Failed, not a fabricated/unscoped answer — and definitely not
        // Carlos's job appearing anywhere.
        expect(rec?.answerStatus).toBe('failed');
        expect(rec?.answer).toBeUndefined();
      });
    });
  });
});

// ── U1 (voice back-office workflows) — money-loop golden path ─────────────
//
// The four spoken collection phrases must complete END-TO-END through the
// worker without missingFields once the entity resolver uniquely resolves
// the spoken document reference: classify → resolve (INVOICE_DOC_INTENTS /
// ESTIMATE_DOC_INTENTS route jobReference to the invoice/estimate kind) →
// draft with the verified id on the payload. Ambiguity still short-circuits
// to a voice_clarification BEFORE drafting — pinned per intent family by the
// generic ambiguity tests above; the ambiguous-invoice case is re-pinned
// here because these intents' gates only lift as of U1.
describe('U1 — money-loop resolution end-to-end (worker golden path)', () => {
  const INVOICE_UUID = '99999999-9999-4999-8999-999999999999';
  const ESTIMATE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  function classifier(intentType: string, entities: Record<string, unknown>): string {
    return JSON.stringify({ intentType, confidence: 0.9, extractedEntities: entities });
  }

  function docResolver(kind: 'invoice' | 'estimate', id: string): EntityResolver {
    return {
      resolve: vi.fn(async (input: { kind: string }) =>
        input.kind === kind
          ? {
              kind: 'resolved' as const,
              candidate: { id, kind, label: kind === 'invoice' ? 'INV-0042' : 'EST-0042', score: 0.95 },
            }
          : { kind: 'not_found' as const, reference: 'x' },
      ),
    } as unknown as EntityResolver;
  }

  const PHRASES: Array<{
    intent: string;
    transcript: string;
    entities: Record<string, unknown>;
    kind: 'invoice' | 'estimate';
    idKey: string;
    resolvedId: string;
  }> = [
    {
      intent: 'send_invoice',
      transcript: 'Send the Henderson invoice',
      entities: { jobReference: 'the Henderson invoice' },
      kind: 'invoice',
      idKey: 'invoiceId',
      resolvedId: INVOICE_UUID,
    },
    {
      intent: 'send_estimate',
      transcript: 'Send the Khan estimate',
      entities: { jobReference: 'the Khan estimate' },
      kind: 'estimate',
      idKey: 'estimateId',
      resolvedId: ESTIMATE_UUID,
    },
    {
      intent: 'send_payment_reminder',
      transcript: 'Chase the Smith invoice',
      entities: { jobReference: 'the Smith invoice' },
      kind: 'invoice',
      idKey: 'invoiceId',
      resolvedId: INVOICE_UUID,
    },
    {
      intent: 'apply_late_fee',
      transcript: 'Add a twenty-five dollar late fee to the Smith invoice',
      entities: { jobReference: 'the Smith invoice', amount: 2500 },
      kind: 'invoice',
      idKey: 'invoiceId',
      resolvedId: INVOICE_UUID,
    },
  ];

  for (const p of PHRASES) {
    it(`"${p.transcript}" → ${p.intent} drafts with the resolver-verified ${p.idKey}, NO missingFields, and NEVER auto-approves`, async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const gateway = gatewayReturning([classifier(p.intent, p.entities)]);
      const worker = createVoiceActionRouterWorker({
        gateway,
        proposalRepo,
        entityResolver: docResolver(p.kind, p.resolvedId),
      });

      await worker.handle(
        msg({ tenantId: 't-1', userId: 'u-1', transcript: p.transcript }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant('t-1');
      expect(proposals).toHaveLength(1);
      expect(proposals[0].proposalType).toBe(p.intent);
      expect((proposals[0].payload as Record<string, unknown>)[p.idKey]).toBe(p.resolvedId);
      expect(missingFieldsFor(proposals[0])).toEqual([]);
      // Money/comms class — a fully-resolved draft still requires a human
      // tap (never 'approved' straight from the worker).
      expect(proposals[0].status).toBe('draft');
      // The drafted payload satisfies its Zod contract with the verified id.
      expect(() =>
        assertValidProposalPayload(proposals[0].proposalType, proposals[0].payload),
      ).not.toThrow();
    });
  }

  it('an ambiguous invoice reference on a money intent short-circuits to voice_clarification (no draft, no guess)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const gateway = gatewayReturning([
      classifier('send_invoice', { jobReference: 'the Henderson invoice' }),
    ]);
    const ambiguous = {
      resolve: vi.fn(async () => ({
        kind: 'ambiguous' as const,
        candidates: [
          { id: 'inv-1', kind: 'invoice' as const, label: 'INV-0042', score: 0.9 },
          { id: 'inv-2', kind: 'invoice' as const, label: 'INV-0043', score: 0.88 },
        ],
      })),
    } as unknown as EntityResolver;
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver: ambiguous });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Send the Henderson invoice' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('voice_clarification');
    const payload = proposals[0].payload as Record<string, unknown>;
    expect(payload.reason).toBe('ambiguous_entity');
    expect(payload.entityReference).toBe('the Henderson invoice');
  });
});
