/**
 * #1540 §5 — "What do I owe?" is answered equally well by lookup_balance and
 * lookup_invoices (owner decision 2026-10-01). A turn can name intents that
 * are ALSO accepted besides its primary `intent` (which stays the one the
 * Layer 1 mock replays), and criterion 9 passes on any of them.
 */
import { describe, it, expect } from 'vitest';
import { gradeDispositionStructured } from '../../../src/ai/voice-quality/graders/disposition-structured';
import { VoiceQualityScriptSchema } from '../../../src/ai/voice-quality/schema';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';

function observationWithIntent(intentType: string): Observation {
  return {
    callId: 'call-1540',
    scriptId: 'owe-1540',
    tenantId: 't-1540',
    events: [
      {
        type: 'intent_classified',
        intentType,
        confidence: 0.9,
        tokenUsage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
        ts: 1_000,
      },
    ],
    proposals: [],
    customerCountDelta: 0,
    appointmentCountDelta: 0,
    audit: [],
    totalCostCents: 0,
    totalDurationMs: 0,
    perTurnLatencyMs: [],
    sessionEndedAs: 'completed',
    hangupOccurred: false,
    errors: [],
  };
}

function oweScript(): VoiceQualityScript {
  return VoiceQualityScriptSchema.parse({
    id: 'owe-1540',
    bucket: '01-happy-lookups',
    callerId: '+15551234567',
    fixtures: { tenant: {}, customers: [] },
    turns: [
      {
        caller: 'What do I owe?',
        expected: {
          intent: 'lookup_invoices',
          alsoAcceptedIntents: ['lookup_balance'],
          escalates: false,
        },
      },
    ],
    grading: { appliesFloor: [], appliesDisposition: [9, 11] },
  });
}

describe('#1540 §5 — criterion 9 accepts an expected intent OR its alternatives', () => {
  it('passes when the agent classified the alternative (lookup_balance)', () => {
    const result = gradeDispositionStructured(observationWithIntent('lookup_balance'), oweScript());
    expect(result.perTurnDetail[0]!.intentMatched).toBe(true);
    expect(result.failedCriteria).not.toContain(9);
  });

  it('still passes on the primary intent (lookup_invoices)', () => {
    const result = gradeDispositionStructured(observationWithIntent('lookup_invoices'), oweScript());
    expect(result.perTurnDetail[0]!.intentMatched).toBe(true);
  });

  it('still fails an intent that is neither', () => {
    const result = gradeDispositionStructured(observationWithIntent('lookup_estimates'), oweScript());
    expect(result.perTurnDetail[0]!.intentMatched).toBe(false);
    expect(result.failedCriteria).toContain(9);
  });
});
