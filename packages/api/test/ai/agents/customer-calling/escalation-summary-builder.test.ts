import { describe, it, expect } from 'vitest';
import {
  buildEscalationSummary,
  type EscalationContext,
} from '../../../../src/ai/agents/customer-calling/escalation-summary-builder';

function baseCtx(overrides: Partial<EscalationContext> = {}): EscalationContext {
  return {
    shopName: "Joe's HVAC",
    caller: { name: 'Sarah Chen', phone: '+15125550142', customerId: 'cust-1', tags: [] },
    customer: { isMember: false },
    intent: { type: 'create_appointment', entities: { service: 'HVAC repair' }, confidence: 0.4 },
    reason: 'operator_request',
    transcriptSnapshot: [
      { role: 'caller', text: 'My AC is making a clicking sound', ts: 1 },
      { role: 'ai', text: 'When did it start?', ts: 2 },
      { role: 'caller', text: 'Let me talk to a real person', ts: 3 },
    ],
    ...overrides,
  };
}

describe('buildEscalationSummary', () => {
  it('produces whisper text under 25 words for an identified caller', () => {
    const result = buildEscalationSummary(baseCtx());
    expect(result.whisper.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(result.whisper).toContain('Sarah Chen');
    expect(result.whisper.toLowerCase()).toContain('operator');
  });

  it('produces SMS text under 160 chars including short link placeholder', () => {
    const result = buildEscalationSummary(baseCtx());
    expect(result.sms.length).toBeLessThanOrEqual(160);
    expect(result.sms).toContain('Sarah Chen');
    expect(result.sms).toContain("Joe's HVAC");
  });

  it('flags Gold member status in both whisper and SMS', () => {
    const ctx = baseCtx({ customer: { isMember: true, memberTier: 'Gold' } });
    const result = buildEscalationSummary(ctx);
    expect(result.whisper.toLowerCase()).toContain('gold');
    expect(result.sms.toLowerCase()).toContain('gold');
  });

  it('falls back to "unknown caller" phrasing when no name resolved', () => {
    const ctx = baseCtx({ caller: { name: undefined, phone: '+15125550142' } });
    const result = buildEscalationSummary(ctx);
    expect(result.whisper.toLowerCase()).toContain('unknown');
    expect(result.panel.header.callerName).toBe('Unknown caller');
  });

  it('passes the transcript snapshot through to panel verbatim', () => {
    const result = buildEscalationSummary(baseCtx());
    expect(result.panel.transcriptSnapshot.length).toBe(3);
    expect(result.panel.transcriptSnapshot[2].text).toBe('Let me talk to a real person');
  });

  it('maps reason codes to human-readable text in the panel', () => {
    const cases: Array<[EscalationContext['reason'], string]> = [
      ['operator_request', 'asked for a person'],
      ['keyword_frustration', 'frustration'],
      ['llm_sentiment', 'frustration'],
      ['low_confidence_intent', "didn't catch"],
      ['emergency_dispatch', 'emergency'],
    ];
    for (const [reason, expectedSubstring] of cases) {
      const result = buildEscalationSummary(baseCtx({ reason }));
      expect(result.panel.reason.humanReadable.toLowerCase()).toContain(expectedSubstring);
    }
  });
});
