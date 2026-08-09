/**
 * Task 13 (2026-08-07 tradesperson plan) — clarification cards instead of
 * silent skips for `confirm` / `language_switch` / `operator_request` on
 * recorded memos.
 *
 * These three are real, CONFIRMED classifications (SUPPORTED_INTENTS
 * members, never absorbed into 'unknown' — see intent-classifier.ts'
 * low_confidence/unknown_intent guards, which always force `intentType`
 * to 'unknown' whenever `unknownReason` would be set). They are also
 * genuinely absent from INTENT_TO_PROPOSAL_TYPE (voice-intent-map.ts) by
 * design: a recorded memo has no live pending question to confirm against
 * (`confirm`), no live call whose language can be switched
 * (`language_switch`), and no live operator to transfer to
 * (`operator_request`). Before this fix, all three fell through
 * processSegment's generic `INTENT_TO_PROPOSAL_TYPE[intentType]` miss
 * branch to `{ kind: 'skipped' }` — no proposal, no operator-visible
 * feedback, total silence for a technician who recorded a memo saying
 * "yes" or "let me talk to someone".
 *
 * The second test pins the OTHER half of the fix: every intent that isn't
 * one of these three still takes the pre-existing warn+skip path. That
 * branch is the guard rail for future taxonomy growth (a new classifier
 * intent shipped before its proposal mapping/handler exists) and must not
 * regress into minting a clarification card for everything. No REAL
 * SUPPORTED_INTENTS member reaches that branch today (every other
 * currently-unmapped intent — lookup_*, en_route, complaint, negotiation,
 * approve/reject/edit_proposal — is intercepted by a dedicated branch
 * earlier in processSegment), so this test simulates the scenario the
 * branch exists to protect against: a classifier taxonomy bump that ships
 * a brand-new IntentType before it's wired into INTENT_TO_PROPOSAL_TYPE or
 * given a dedicated branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const FUTURE_TAXONOMY_TRANSCRIPT = '__task13_future_taxonomy_growth_probe__';

vi.mock('../../src/ai/orchestration/intent-classifier', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/ai/orchestration/intent-classifier')>();
  return {
    ...actual,
    classifyIntent: vi.fn(
      async (
        transcript: string,
        context: Parameters<typeof actual.classifyIntent>[1],
        gateway: Parameters<typeof actual.classifyIntent>[2],
      ) => {
        if (transcript === FUTURE_TAXONOMY_TRANSCRIPT) {
          // Simulates a taxonomy bump: a brand-new intent the classifier
          // can already emit, but that has no INTENT_TO_PROPOSAL_TYPE entry
          // and no dedicated branch yet. Cast is deliberate — no real
          // IntentType member can reach the generic miss branch today.
          return { intentType: 'future_unmapped_intent' as unknown, confidence: 0.95 } as Awaited<
            ReturnType<typeof actual.classifyIntent>
          >;
        }
        return actual.classifyIntent(transcript, context, gateway);
      },
    ),
  };
});

import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
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

function classifierJson(intentType: string): string {
  return JSON.stringify({ intentType, confidence: 0.9 });
}

describe('Task 13 — clarification cards instead of silent skips', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
    vi.clearAllMocks();
  });

  const CASES: Array<{ intent: string; transcript: string; explanation: string }> = [
    {
      intent: 'confirm',
      transcript: "Yes, that's right",
      explanation:
        "It sounds like you were confirming something, but recorded memos don't have a pending question — say the full action instead.",
    },
    {
      intent: 'language_switch',
      transcript: 'Can we do this in Spanish',
      explanation:
        'Language preferences apply to live calls — this memo was still processed in English.',
    },
    {
      intent: 'operator_request',
      transcript: 'Let me talk to a person',
      explanation:
        "Talking to a person isn't available from a recorded memo — call the office line instead.",
    },
  ];

  it.each(CASES)(
    '$intent on a recorded memo produces a voice_clarification card, not a silent skip',
    async ({ intent, transcript, explanation }) => {
      const worker = createVoiceActionRouterWorker({
        gateway: gatewayReturning([classifierJson(intent)]),
        proposalRepo,
      });

      await worker.handle(msg({ tenantId: 't-1', userId: 'u-1', transcript }), silentLogger());

      // Old behavior: `{ kind: 'skipped' }` persisted NOTHING — total
      // silence. New behavior: a real, operator-visible clarification.
      const proposals = await proposalRepo.findByTenant('t-1');
      expect(proposals).toHaveLength(1);
      expect(proposals[0].proposalType).toBe('voice_clarification');
      expect(proposals[0].explanation).toBe(explanation);
      expect(proposals[0].status).toBe('draft');

      const payload = proposals[0].payload as Record<string, unknown>;
      expect(payload.transcript).toBe(transcript);
      // The payload's `reason` enum has no bespoke code for "understood but
      // unsupported on this surface" (deliberately — no new payload-contract
      // value for a small parity fix); it lands on the same 'unknown_intent'
      // default every other "recognized but refused here" miss in this file
      // uses (customer-protection-refused, owner-extended-lookup-refused).
      // The intent-specific story lives on `explanation`, asserted above.
      expect(payload.reason).toBe('unknown_intent');
    },
  );

  it('an intent with no proposal mapping and no dedicated branch still takes the warn+skip path (future taxonomy growth guard)', async () => {
    const worker = createVoiceActionRouterWorker({
      gateway: gatewayReturning(['{}']),
      proposalRepo,
    });

    await worker.handle(
      msg({ tenantId: 't-1', userId: 'u-1', transcript: FUTURE_TAXONOMY_TRANSCRIPT }),
      silentLogger(),
    );

    // Still silent — this is the pre-existing, intentional behavior for
    // every unmapped intent OTHER than the three above.
    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(0);
  });
});
