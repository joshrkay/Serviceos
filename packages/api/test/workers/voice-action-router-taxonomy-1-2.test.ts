/**
 * Taxonomy 1.2.0 router coverage:
 *
 *  - U1: `targetTechnicianName` resolves via the entity resolver (kind
 *    'technician') — resolved id rides the task context into the payload;
 *    two-Bobs ambiguity becomes a voice_clarification with the candidate
 *    picker; not_found stamps pendingReference and keeps the missing-marker.
 *  - U2/U3/UB-A2: each new intent routes through INTENT_TO_PROPOSAL_TYPE to
 *    its handler and persists the right proposal type.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import { missingFieldsFor } from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';
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

function fakeResolver(
  impl: (input: { tenantId: string; reference: string; kind: string }) => Promise<EntityResolverResult>,
): EntityResolver {
  return { resolve: vi.fn(impl) } as EntityResolver;
}

const CARLOS_ID = '44444444-4444-4444-4444-444444444444';

function reassignClassifierJson(): string {
  return JSON.stringify({
    intentType: 'reassign_appointment',
    confidence: 0.9,
    extractedEntities: {
      appointmentReference: "Tuesday's Davis job",
      targetTechnicianName: 'Carlos',
    },
  });
}

describe('U1: router technician resolution', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  it('resolved technician → verified UUID lands on the reassign payload (no missing toTechnicianId)', async () => {
    const resolver = fakeResolver(async ({ kind }) => {
      expect(kind).toBe('technician');
      return {
        kind: 'resolved',
        candidate: { id: CARLOS_ID, kind: 'technician', label: 'Carlos Rodriguez', hint: 'technician', score: 0.95 },
      };
    });
    const worker = createVoiceActionRouterWorker({
      gateway: gatewayReturning([reassignClassifierJson()]),
      proposalRepo,
      entityResolver: resolver,
    });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: "Give Tuesday's Davis job to Carlos" }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('reassign_appointment');
    expect(proposals[0].payload.toTechnicianId).toBe(CARLOS_ID);
    expect(missingFieldsFor(proposals[0])).not.toContain('toTechnicianId');
    // The resolver was actually consulted for the technician kind.
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'technician', reference: 'Carlos' }),
    );
  });

  it('two Carloses → voice_clarification with the candidate picker, no draft', async () => {
    const resolver = fakeResolver(async () => ({
      kind: 'ambiguous',
      candidates: [
        { id: 'u-a', kind: 'technician', label: 'Carlos Rodriguez', hint: 'technician', score: 0.9 },
        { id: 'u-b', kind: 'technician', label: 'Carlos Mendez', hint: 'dispatcher', score: 0.88 },
      ],
    }));
    const worker = createVoiceActionRouterWorker({
      gateway: gatewayReturning([reassignClassifierJson()]),
      proposalRepo,
      entityResolver: resolver,
    });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: "Give Tuesday's Davis job to Carlos" }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('voice_clarification');
    const payload = proposals[0].payload as Record<string, unknown>;
    expect(payload.reason).toBe('ambiguous_entity');
    expect(payload.entityReference).toBe('Carlos');
    expect(payload.entityCandidates).toEqual([
      { id: 'u-a', label: 'Carlos Rodriguez', hint: 'technician', score: 0.9 },
      { id: 'u-b', label: 'Carlos Mendez', hint: 'dispatcher', score: 0.88 },
    ]);
    // Re-draft context: which field the chosen candidate fills is keyed off
    // the entityKind persisted on sourceContext.
    expect((proposals[0].sourceContext as Record<string, unknown>).entityKind).toBe('technician');
  });

  it('not_found technician → reassign persists with pendingReference + missing-marker intact', async () => {
    const resolver = fakeResolver(async () => ({ kind: 'not_found', reference: 'Carlos' }));
    const worker = createVoiceActionRouterWorker({
      gateway: gatewayReturning([reassignClassifierJson()]),
      proposalRepo,
      entityResolver: resolver,
    });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: "Give Tuesday's Davis job to Carlos" }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('reassign_appointment');
    expect(proposals[0].payload.toTechnicianId).toBeUndefined();
    expect(missingFieldsFor(proposals[0])).toContain('toTechnicianId');
    expect((proposals[0].sourceContext as Record<string, unknown>).pendingReference).toEqual([
      { kind: 'technician', reference: 'Carlos' },
    ]);
  });
});

describe('Taxonomy 1.2.0: new intents route to their handlers', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  it('create_invoice_schedule → create_invoice_schedule proposal with parsed milestones', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_invoice_schedule',
        confidence: 0.9,
        extractedEntities: {
          jobReference: 'the Hendersons',
          scheduleDescription: '50% deposit, 50% on completion',
        },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Set up 50% deposit, 50% on completion for the Hendersons',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_invoice_schedule');
    const milestones = proposals[0].payload.milestones as Array<{ type: string }>;
    expect(milestones.map((m) => m.type)).toEqual(['percent', 'remainder']);
    expect(proposals[0].status).toBe('draft');
  });

  it('respond_to_review with no review repo wired → clarification (never a crash)', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'respond_to_review',
        confidence: 0.9,
        extractedEntities: { reviewReference: 'that 1-star review' },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: 'Respond to that 1-star review' }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('voice_clarification');
  });

  it('create_standing_instruction → drafts a create_standing_instruction proposal (always review)', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'create_standing_instruction',
        confidence: 0.95,
        extractedEntities: {
          instructionText: 'from now on always add a $79 diagnostic fee to AC calls',
          amount: 7900,
        },
      }),
      // Second gateway call = the handler's normalization pass.
      JSON.stringify({
        instruction: 'Always add a $79 diagnostic fee to AC calls',
        scope: { tradeCategories: ['hvac'], amountCents: 7900 },
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    await worker.handle(
      msg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'From now on always add a $79 diagnostic fee to AC calls',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_standing_instruction');
    expect(proposals[0].payload.instruction).toBe('Always add a $79 diagnostic fee to AC calls');
    // v1 rule: even at 0.95 confidence the instruction lands for review.
    expect(proposals[0].status).toBe('draft');
  });
});
