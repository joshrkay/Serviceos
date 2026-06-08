/**
 * Feature 2 — Intent classification + emergency escalation + confidence handoff.
 *
 * Drives the deterministic decision surfaces over the fixture corpus:
 *  - `shouldImmediatelyDialOnEmergency` — emergency intents dial on-call.
 *  - `decideCriticalHandoff` — confidence < 0.7 on booking/payment/complaint
 *    offers a human transfer (the Avoca-parity rule).
 *  - emergency handoff latency (intent detected → dial decision + dispatcher
 *    context assembled): competitive bar p95 < 5000ms (life-safety).
 */
import { describe, it, expect } from 'vitest';
import { loadIntents } from './_fixtures';
import { shouldImmediatelyDialOnEmergency } from '../../src/ai/skills/escalate-to-human';
import { decideCriticalHandoff } from '../../src/voice/parity/critical-intent-handoff';
import { buildEscalationSummary } from '../../src/ai/agents/customer-calling/escalation-summary-builder';
import { summarize } from '../../src/voice/parity/latency';

const EMERGENCY_HANDOFF_P95_BUDGET_MS = 5000;
const fixtures = loadIntents();

describe('Feature 2 — intent classification & escalation', () => {
  it('corpus covers every target intent family incl. >=4 emergency variants', () => {
    const intents = new Set(fixtures.map((f) => f.expectedIntent));
    // Target families (mapped to the classifier's concrete vocabulary).
    for (const required of [
      'book_appointment',
      'request_estimate',
      'emergency_dispatch',
      'lookup_appointments',
      'billing_question',
      'complaint',
      'operator_request',
      'unknown',
    ]) {
      expect(intents.has(required)).toBe(true);
    }
    const emergencyVariants = fixtures.filter((f) => f.expectedEmergencyDial);
    expect(emergencyVariants.length).toBeGreaterThanOrEqual(4);
  });

  it.each(fixtures)('emergency dial decision matches fixture: $name', (f) => {
    const dial = shouldImmediatelyDialOnEmergency({
      intent: f.expectedIntent,
      supervisorPresent: false,
      channel: 'telephony',
    });
    expect(dial).toBe(f.expectedEmergencyDial);
  });

  it.each(fixtures)('critical-intent 0.7 handoff matches fixture: $name', (f) => {
    const decision = decideCriticalHandoff({ intent: f.expectedIntent, confidence: f.confidence });
    expect(decision.offerHumanTransfer).toBe(f.expectedCriticalHandoff);
  });

  it('never offers a transfer for a confident booking, always for a shaky one', () => {
    expect(decideCriticalHandoff({ intent: 'book_appointment', confidence: 0.95 }).offerHumanTransfer).toBe(false);
    expect(decideCriticalHandoff({ intent: 'book_appointment', confidence: 0.69 }).offerHumanTransfer).toBe(true);
    // Non-critical intent is never gated by this rule, even at low confidence.
    expect(decideCriticalHandoff({ intent: 'unknown', confidence: 0.1 }).offerHumanTransfer).toBe(false);
  });

  it(`emergency handoff p95 is under ${EMERGENCY_HANDOFF_P95_BUDGET_MS}ms`, () => {
    const emergencies = fixtures.filter((f) => f.expectedEmergencyDial);
    expect(emergencies.length).toBeGreaterThan(0);
    const samples: number[] = [];
    const perf = globalThis.performance;
    // Repeat the corpus to get a stable percentile sample.
    for (let rep = 0; rep < 50; rep++) {
      for (const f of emergencies) {
        const start = perf ? perf.now() : Date.now();
        const dial = shouldImmediatelyDialOnEmergency({
          intent: f.expectedIntent,
          supervisorPresent: false,
          channel: 'telephony',
        });
        // The dispatcher context that must be ready before the bridge.
        const summary = buildEscalationSummary({
          shopName: 'Acme Plumbing',
          tenantTimezone: 'America/New_York',
          caller: { phone: '+15125550142', name: 'Caller' },
          intent: { type: f.expectedIntent, entities: {}, confidence: f.confidence },
          reason: 'emergency_dispatch',
          transcriptSnapshot: [{ role: 'caller', text: f.utterance, ts: 0 }],
        });
        const elapsed = (perf ? perf.now() : Date.now()) - start;
        expect(dial).toBe(true);
        expect(summary.whisper.length).toBeGreaterThan(0);
        samples.push(elapsed);
      }
    }
    const stats = summarize(samples);
    expect(stats.p95).toBeLessThan(EMERGENCY_HANDOFF_P95_BUDGET_MS);
  });
});
