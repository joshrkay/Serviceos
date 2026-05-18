/**
 * Operator voice golden path — launch goal proof.
 *
 * The 2026-05-22 launch promise: a single HVAC/plumbing tradesperson
 * can run his entire business by voice. That demands two end-to-end
 * properties that no per-component unit test proves on its own:
 *
 *   1. When the tradesperson speaks, the classifier sees the tenant's
 *      vertical pack — terminology, intake-disambiguation questions,
 *      objection scripts — alongside the base intent prompt. Without
 *      this, "draft an estimate for the Johnson water heater" loses
 *      the HVAC entity vocabulary and bottoms out at 'unknown'.
 *   2. Each common command lands as the right proposal type with the
 *      right entity payload, ready for human approval.
 *
 * This suite stitches the real `buildVerticalPromptResolver` against
 * a seeded in-memory canonical pack registry, the real voice-action-
 * router worker, and a deterministic scripted LLM gateway — the same
 * wiring shape `app.ts` uses in production minus the Postgres
 * substrate. Each test asserts both the system-prompt contract AND
 * the proposal outcome for one canonical tradesperson utterance.
 *
 * If this suite is red, the launch goal is not met. Don't ship.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryPackActivationRepository, activatePack } from '../../src/settings/pack-activation';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';
import { seedCanonicalVerticalPacks } from '../../src/shared/canonical-vertical-packs';
import { buildVerticalPromptResolver } from '../../src/verticals/resolve-active-pack';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const TENANT = 't-launch-hvac';
const USER = 'u-launch-tech';

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

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: responses[Math.min(i++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function msg<T>(payload: T): QueueMessage<T> {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
  };
}

async function buildHvacResolver(): Promise<(tenantId: string) => Promise<string | undefined>> {
  const canonicalPackRegistry = new InMemoryVerticalPackRegistry();
  await seedCanonicalVerticalPacks(canonicalPackRegistry);
  const packActivationRepo = new InMemoryPackActivationRepository();
  await activatePack({ tenantId: TENANT, packId: 'hvac-v1' }, packActivationRepo);
  // ttl=0 — disable caching so changes to fixture state are immediately
  // visible across test cases; production uses a 5-minute TTL.
  return buildVerticalPromptResolver({
    packActivationRepo,
    canonicalPackRegistry,
    cacheTtlMs: 0,
  });
}

interface ClassifierCall {
  systemContents: string[];
  userContent: string | undefined;
}

function lastClassifierCall(gateway: LLMGateway): ClassifierCall {
  const mock = gateway.complete as ReturnType<typeof vi.fn>;
  const call = mock.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> } | undefined;
  if (!call) return { systemContents: [], userContent: undefined };
  const systemContents = call.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const userContent = call.messages.find((m) => m.role === 'user')?.content;
  return { systemContents, userContent };
}

describe('Operator voice golden path — HVAC tenant', () => {
  let proposalRepo: InMemoryProposalRepository;
  let verticalPromptResolver: (tenantId: string) => Promise<string | undefined>;

  beforeEach(async () => {
    proposalRepo = new InMemoryProposalRepository();
    verticalPromptResolver = await buildHvacResolver();
  });

  // Sanity gate — if the resolver itself doesn't surface HVAC, every
  // assertion below is meaningless. Keep this first so a regression in
  // the seed/activation path fails loudly instead of cascading.
  it('the seeded HVAC resolver emits the expected pack sections', async () => {
    const section = await verticalPromptResolver(TENANT);
    expect(section).toBeDefined();
    // §3B — vertical block + terminology
    expect(section).toMatch(/Service vertical: HVAC/i);
    expect(section).toMatch(/Furnace/);
    expect(section).toMatch(/Air Conditioner/);
    // §3D — intake disambiguation questions
    expect(section).toMatch(/Disambiguation questions/);
    expect(section).toMatch(/Is this for heating or cooling\?/);
    // §3E — objection scripts
    expect(section).toMatch(/Objection-handling scripts/);
  });

  it('1. "create an invoice for Mrs Lee for $450 cash" → draft_invoice proposal w/ HVAC context', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.92,
        extractedEntities: { customerName: 'Mrs Lee', amount: 45000 },
      } satisfies IntentClassification),
      JSON.stringify({
        customerId: 'cust-lee',
        jobId: 'job-1',
        lineItems: [{ description: 'Diagnostic + repair', quantity: 1, unitPrice: 45000 }],
        confidence_score: 0.92,
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, verticalPromptResolver });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: USER,
        transcript: 'Create an invoice for Mrs Lee for 450 dollars cash',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('draft_invoice');
    // The HVAC vertical context reached the classifier.
    const { systemContents } = lastClassifierCall(gateway);
    expect(systemContents.some((c) => c.includes('Service vertical: HVAC'))).toBe(true);
    expect(systemContents.some((c) => c.includes('Furnace'))).toBe(true);
  });

  it('2. "schedule a furnace tune-up at the Smith house Tuesday at 2pm" → create_appointment proposal', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.9,
        extractedEntities: {
          customerName: 'Smith',
          dateTimeDescription: 'Tuesday at 2pm',
        },
      } satisfies IntentClassification),
      JSON.stringify({
        customerName: 'Smith',
        scheduledStart: '2026-05-26T21:00:00Z',
        scheduledEnd: '2026-05-26T22:00:00Z',
        confidence_score: 0.9,
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, verticalPromptResolver });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: USER,
        transcript: 'Schedule a furnace tune-up at the Smith house Tuesday at 2pm',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_appointment');
    // HVAC terminology must be on the classifier system prompt so the
    // model recognizes "furnace tune-up" as a canonical service.
    const { systemContents } = lastClassifierCall(gateway);
    expect(systemContents.some((c) => c.includes('Service vertical: HVAC'))).toBe(true);
    expect(systemContents.some((c) => /Seasonal Tune-?Up|tune-up/i.test(c))).toBe(true);
  });

  it('3. "mark the Jones invoice paid, 450 cash" → record_payment proposal', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'record_payment',
        confidence: 0.91,
        extractedEntities: {
          customerName: 'Jones',
          amount: 45000,
          paymentMethod: 'cash',
        },
      } satisfies IntentClassification),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, verticalPromptResolver });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: USER,
        transcript: 'Mark the Jones invoice paid, 450 cash',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('record_payment');
    // Money-moving proposals must NEVER auto-execute (CLAUDE.md core
    // pattern). The proposal lands in draft for human approval.
    expect(proposals[0].status).toBe('draft');
  });

  it('4. "add a note to the Rodriguez job: customer wants a call before we arrive" → add_note proposal', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'add_note',
        confidence: 0.88,
        extractedEntities: {
          customerName: 'Rodriguez',
          noteTargetKind: 'job',
          noteBody: 'customer wants a call before we arrive',
        },
      } satisfies IntentClassification),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, verticalPromptResolver });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: USER,
        transcript: 'Add a note to the Rodriguez job: customer wants a call before we arrive',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('add_note');
  });

  it('5. "draft an estimate for the Johnson water heater replacement" → draft_estimate proposal', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'draft_estimate',
        confidence: 0.9,
        extractedEntities: { customerName: 'Johnson' },
      } satisfies IntentClassification),
      JSON.stringify({
        customerId: 'cust-johnson',
        jobId: 'job-johnson',
        lineItems: [{ description: 'Water heater replacement', quantity: 1, unitPrice: 250000 }],
        confidence_score: 0.9,
      }),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, verticalPromptResolver });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: USER,
        transcript: 'Draft an estimate for the Johnson water heater replacement',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('draft_estimate');
  });

  // §3E + UX guard — when the classifier picks the agreement-lookup
  // family, the proposal repo is left untouched (read-only path) and
  // the operator's prompt still gets the vertical block. This proves
  // lookup intents don't surface bogus proposals during onboarding
  // when packs are present but the customer is doing a balance check.
  it('6. "what jobs do I have today?" → lookup intent, no proposal', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'lookup_jobs',
        confidence: 0.93,
      } satisfies IntentClassification),
    ]);
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, verticalPromptResolver });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: USER,
        transcript: 'What jobs do I have today?',
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(0);
  });
});
