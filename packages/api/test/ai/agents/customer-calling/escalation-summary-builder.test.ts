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

  it('truncates whisper smartly when content exceeds 25 words: drops member phrase first', () => {
    const ctx = baseCtx({
      caller: { name: 'Bartholomew Von Schlichtenhaus III', phone: '+15125550142' },
      customer: { isMember: true, memberTier: 'Platinum Elite Executive' },
      intent: {
        type: 'create_appointment',
        entities: { service: 'very long custom service type with lots of descriptive words' },
        confidence: 0.4,
      },
    });
    const result = buildEscalationSummary(ctx);
    const wordCount = result.whisper.split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(25);
    // Must still end with sentence-terminal punctuation (no dangling ":" or preposition).
    expect(result.whisper).toMatch(/[.?!]$/);
    // Caller name should always be preserved.
    expect(result.whisper).toContain('Bartholomew');
  });

  it('always preserves short link in SMS, even when core message is long', () => {
    const ctx = baseCtx({
      shopName: "Joe's Excellent HVAC and Plumbing Services of Greater Travis County",
      caller: { name: 'Bartholomew Von Schlichtenhaus III', phone: '+15125550142' },
      intent: { type: 'create_appointment', entities: { service: 'long service description' }, confidence: 0.4 },
    });
    const result = buildEscalationSummary(ctx);
    expect(result.sms.length).toBeLessThanOrEqual(160);
    expect(result.sms).toContain('app.rivet.ai/c/<escalationId>');
  });

  it('renders lastInteraction date in tenant timezone, not UTC', () => {
    // 2026-01-16T02:00:00Z = Jan 16 in UTC, but Jan 15 at 21:00 EST (UTC-5).
    // This proves the timezone is applied: UTC sees Jan 16, Eastern sees Jan 15.
    const date = new Date('2026-01-16T02:00:00Z');
    const ctxEastern = baseCtx({
      tenantTimezone: 'America/New_York',
      customer: { lastService: { date, type: 'tune-up', amountCents: 18900 } },
    });
    const ctxUtc = baseCtx({
      tenantTimezone: 'UTC',
      customer: { lastService: { date, type: 'tune-up', amountCents: 18900 } },
    });
    const eastern = buildEscalationSummary(ctxEastern);
    const utc = buildEscalationSummary(ctxUtc);
    expect(eastern.panel.lastInteraction).toContain('Jan 15');
    expect(utc.panel.lastInteraction).toContain('Jan 16');
    // Bonus: confirm $189.00 cents formatting (not $189 rounded).
    expect(eastern.panel.lastInteraction).toContain('$189.00');
  });

  it('appends communication notes to panel lastInteraction', () => {
    const result = buildEscalationSummary(
      baseCtx({
        customer: {
          lastService: {
            date: new Date('2026-01-10T00:00:00Z'),
            type: 'tune-up',
          },
          communicationNotes: 'Prefers mornings.',
        },
      }),
    );
    expect(result.panel.lastInteraction).toContain('Last service:');
    expect(result.panel.lastInteraction).toContain('Notes: Prefers mornings.');
  });
});
