/**
 * Voice-parity (Feature 6 — Bilingual) — Spanish booking-rate + language
 * consistency.
 *
 * Drives the in-app voice adapter (and the underlying CallingAgentStateMachine)
 * end-to-end for 12 Spanish-language inbound-CSR fixtures
 * (fixtures/voice/es/booking-fixtures.json), with the tenant opted into Spanish
 * (supported_languages = ['en', 'es']). For each fixture it asserts:
 *
 *   1. Auto-detection — the session pins to 'es' from the caller's first
 *      (Spanish) utterance.
 *   2. Booking rate — booking/capture-intent calls produce a proposal at
 *      >= 75% parity with English.
 *   3. Language consistency — the agent's spoken response stays Spanish; the
 *      English booking/confirm/close copy never bleeds into a Spanish call.
 *
 * Determinism note: like the rest of the voice suite (see voice-reschedule.test
 * .ts), the LLM classifier is *scripted* — each fixture supplies the canned
 * classifier JSON. The value of this test is end-to-end Spanish detection +
 * Spanish-rendered agent copy on the booking path, not the classifier's own
 * accuracy (which Layer-2 cassettes cover).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { InAppVoiceAdapter } from '../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { guardVoiceProposalContract } from './helpers/voice-proposal-contract';

interface SpanishFixture {
  id: string;
  intent: string;
  expectsBooking: boolean;
  callerUtterance: string;
  classifier: {
    intentType: string;
    confidence: number;
    extractedEntities?: Record<string, unknown>;
  };
}

const FIXTURES_PATH = path.resolve(
  __dirname,
  '../../../../fixtures/voice/es/booking-fixtures.json',
);

function loadFixtures(): SpanishFixture[] {
  const raw = fs.readFileSync(FIXTURES_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as { fixtures: SpanishFixture[] };
  return parsed.fixtures;
}

function scriptedGateway(response: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: response,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

// English "tells" that must never appear in a Spanish call's spoken copy.
// Drawn from the booking/confirm/close + greeting copy the FSM emits on the
// happy booking path (tts-copy.ts renders these in Spanish when the session
// language is 'es').
const ENGLISH_TELLS = [
  'taken care of',
  'confirmation shortly',
  'Is there anything else',
  'Just to confirm',
  'How can I help you today',
  "I'd like to",
];

describe('Voice-parity Feature 6 — Spanish booking rate + language consistency', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = guardVoiceProposalContract(new InMemoryProposalRepository(), {
      // PRE-EXISTING, DELIBERATELY OUT OF SCOPE for the payload-contract PR
      // that added this guard. All five reduce to ONE root cause:
      //
      //   NO ENTITY RESOLVER IS WIRED IN THIS SUITE.
      //
      // `InAppVoiceAdapter.getEntityResolver()` returns an injected resolver
      // (tests), else a `PgEntityResolver` built from `deps.pool`, else
      // UNDEFINED — and resolution is then skipped rather than guessed. This
      // suite wires neither, so the classifier's raw entities reach the shared
      // payload builder untouched: `customerName` arrives where `customerId`
      // is required, `dateTimeDescription` where `scheduledStart` is.
      //
      // So this is a FIXTURE gap, not proof of a production defect — a
      // pool-backed deployment does resolve. What it does prove is that the
      // unresolved case degrades badly: the payload fails its contract with no
      // `missingFields` gate, i.e. an approve-to-fail card. The honest fix is
      // for the in-app adapter to gate on its own contract failures the way
      // the phone path does; that is its own change.
      //
      // Not silent either way: the adapter emits a
      // `voice.payload_contract_failed` audit row for each, and in-app is an
      // authenticated S2 operator who reads and edits the card before
      // approving (`approveProposal` re-validates at the execution boundary).
      knownGaps: [
        { proposalType: 'draft_estimate', reason: 'customerName never resolved → customerId absent' },
        { proposalType: 'update_customer', reason: 'customerName never resolved → customerId absent' },
        {
          proposalType: 'create_appointment',
          reason: 'dateTimeDescription never resolved → scheduledStart/scheduledEnd absent',
        },
        {
          proposalType: 'reschedule_appointment',
          reason:
            'appointmentReference/newDateTimeDescription never resolved → ' +
            'appointmentId/newScheduledStart/newScheduledEnd absent',
        },
        {
          proposalType: 'cancel_appointment',
          reason: 'appointmentReference never resolved → appointmentId absent',
        },
      ],
    });
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
  });

  afterEach(() => {
    store.dispose();
  });

  function makeAdapter(gateway: LLMGateway): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
      // Tenant opted into Spanish — the first-utterance gate may switch to 'es'.
      supportedLanguagesResolver: async () => ['en', 'es'],
    });
  }

  it('loads exactly 12 Spanish fixtures across the booking/capture intents', () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBe(12);
    // "Across all intents" — at least 5 distinct intent types represented.
    const intents = new Set(fixtures.map((f) => f.intent));
    expect(intents.size).toBeGreaterThanOrEqual(5);
  });

  it('books at >= 75% AND keeps the whole call in Spanish (no English bleed)', async () => {
    const fixtures = loadFixtures();
    const TENANT = 'tenant-es';
    const USER = 'user-es';

    let bookingEligible = 0;
    let booked = 0;
    const failures: string[] = [];

    for (const fx of fixtures) {
      const adapter = makeAdapter(scriptedGateway(JSON.stringify(fx.classifier)));
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const result = await adapter.handleInput(sessionId, fx.callerUtterance);

      // Auto-confirm was removed: a booking intent parks at the intent_confirm
      // readback, so the caller confirms with a Spanish "sí" on a second turn.
      // The proposal is only queued after that genuine confirmation.
      let confirmResult: Awaited<ReturnType<typeof adapter.handleInput>> | undefined;
      if (result.state === 'intent_confirm') {
        confirmResult = await adapter.handleInput(sessionId, 'sí');
      }
      const finalResult = confirmResult ?? result;

      // (1) Auto-detection — the Spanish first utterance pinned the session.
      const session = store.get(sessionId);
      if (session?.language !== 'es') {
        failures.push(`${fx.id}: session.language=${session?.language} (expected es)`);
      }

      // (2) Booking/capture — did the call draft a proposal (post-confirm)?
      if (fx.expectsBooking) {
        bookingEligible++;
        if (finalResult.proposalIds.length >= 1) booked++;
      }

      // (3) Language consistency — the agent's spoken copy on BOTH the
      // readback and the confirm/close turn must stay Spanish.
      const spokenTurns = [result.ttsText ?? '', confirmResult?.ttsText ?? ''];
      for (const spoken of spokenTurns) {
        for (const tell of ENGLISH_TELLS) {
          if (spoken.includes(tell)) {
            failures.push(`${fx.id}: English bleed in agent copy ("${tell}"): ${spoken}`);
          }
        }
      }
    }

    // No detection or bleed failures across any fixture.
    expect(failures).toEqual([]);

    // Booking rate at parity with English (>= 75%).
    const bookingRate = bookingEligible === 0 ? 0 : booked / bookingEligible;
    expect(bookingRate).toBeGreaterThanOrEqual(0.75);
  });

  it('gating: a Spanish caller on an English-only tenant stays in English', async () => {
    // Same Spanish utterance, but the tenant did NOT opt into 'es'.
    const fx = loadFixtures()[0];
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway(JSON.stringify(fx.classifier)),
      proposalRepo,
      auditRepo,
      onCallRepo,
      supportedLanguagesResolver: async () => ['en'],
    });
    const { sessionId } = await adapter.startSession('tenant-en-only', 'user-en');
    await adapter.handleInput(sessionId, fx.callerUtterance);

    const session = store.get(sessionId);
    expect(session?.language).toBe('en');
  });
});
