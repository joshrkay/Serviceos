import { describe, expect, it } from 'vitest';
import {
  extractFrustrationUtterances,
  scrubPii,
  toUtterancesFile,
  type CallerTurn,
  type FrustrationEvent,
  type UtteranceSource,
} from '../../../../src/ai/spikes/typesafe/extract-utterances';

const turn = (over: Partial<CallerTurn>): CallerTurn => ({
  tenantId: 't1',
  callSid: 'CA1',
  sessionId: 's1',
  turnIndex: 0,
  text: 'hello',
  at: 1_000,
  ...over,
});

const sourceOf = (turns: CallerTurn[], events: FrustrationEvent[]): UtteranceSource => ({
  async listCallerTurns(q) {
    return turns.filter((t) => t.tenantId === q.tenantId && t.at >= q.from && t.at < q.to);
  },
  async listFrustrationEvents(q) {
    return events.filter((e) => e.tenantId === q.tenantId && e.at >= q.from && e.at < q.to);
  },
});

const window = { tenantId: 't1', from: 0, to: 1_000_000, limit: 100, seed: 1 };

describe('scrubPii', () => {
  it('redacts phone numbers, emails, card numbers and street addresses', () => {
    const out = scrubPii(
      'call me at (602) 555-0142 or jo.smith@example.com, card 4111 1111 1111 1111, I live at 14 Maple Street'
    );
    expect(out).not.toMatch(/555|example\.com|4111|14 Maple/);
    expect(out).toContain('[PHONE]');
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[CARD]');
    expect(out).toContain('[ADDRESS]');
  });

  it('leaves ordinary speech untouched', () => {
    expect(scrubPii('my furnace stopped working this morning')).toBe('my furnace stopped working this morning');
  });
});

describe('extractFrustrationUtterances', () => {
  it("marks the caller turn at or before a frustration event as firedBaseline and scrubs it", async () => {
    const turns = [
      turn({ turnIndex: 0, text: 'my furnace is out', at: 1_000 }),
      turn({ turnIndex: 1, text: 'this is ridiculous, call 602-555-0142', at: 2_000 }),
      turn({ turnIndex: 2, text: 'thanks', at: 9_000 }),
    ];
    const events: FrustrationEvent[] = [
      { tenantId: 't1', callSid: 'CA1', sessionId: 's1', source: 'keyword', at: 2_500 },
    ];

    const rows = await extractFrustrationUtterances(sourceOf(turns, events), window);

    const fired = rows.filter((r) => r.firedBaseline);
    expect(fired).toHaveLength(1);
    expect(fired[0].text).toBe('this is ridiculous, call [PHONE]');
    expect(fired[0].eventSource).toBe('keyword');
    expect(rows.filter((r) => !r.firedBaseline).map((r) => r.text)).toEqual(['my furnace is out', 'thanks']);
  });

  it('only joins events to turns from the same call and session, and never crosses tenants', async () => {
    const turns = [
      turn({ callSid: 'CA1', sessionId: 's1', text: 'first call', at: 1_000 }),
      turn({ callSid: 'CA2', sessionId: 's2', text: 'second call', at: 1_500 }),
      turn({ tenantId: 't2', callSid: 'CA9', sessionId: 's9', text: 'other tenant', at: 1_000 }),
    ];
    const events: FrustrationEvent[] = [
      { tenantId: 't1', callSid: 'CA2', sessionId: 's2', source: 'llm_sentiment', at: 2_000 },
    ];

    const rows = await extractFrustrationUtterances(sourceOf(turns, events), window);

    expect(rows.map((r) => r.text).sort()).toEqual(['first call', 'second call']);
    expect(rows.find((r) => r.text === 'second call')?.firedBaseline).toBe(true);
    expect(rows.find((r) => r.text === 'first call')?.firedBaseline).toBe(false);
  });

  it('joins on tenant + session even when the audit event carries no callSid', async () => {
    const turns = [turn({ callSid: 'CA1', sessionId: 's1', text: 'where is the tech', at: 1_000 })];
    const events: FrustrationEvent[] = [
      { tenantId: 't1', callSid: '', sessionId: 's1', source: 'keyword', at: 1_500 },
    ];

    const rows = await extractFrustrationUtterances(sourceOf(turns, events), window);

    expect(rows).toEqual([{ text: 'where is the tech', firedBaseline: true, eventSource: 'keyword' }]);
  });

  it('keeps every fired turn when capping and fills the rest with a seeded sample of the others', async () => {
    const turns = Array.from({ length: 50 }, (_, i) =>
      turn({ callSid: `CA${i}`, sessionId: `s${i}`, text: `utterance ${i}`, at: 1_000 + i })
    );
    const events: FrustrationEvent[] = [
      { tenantId: 't1', callSid: 'CA3', sessionId: 's3', source: 'keyword', at: 5_000 },
    ];
    const src = sourceOf(turns, events);

    const a = await extractFrustrationUtterances(src, { ...window, limit: 10 });
    const b = await extractFrustrationUtterances(src, { ...window, limit: 10 });

    expect(a).toHaveLength(10);
    expect(a.some((r) => r.text === 'utterance 3' && r.firedBaseline)).toBe(true);
    expect(a.map((r) => r.text)).toEqual(b.map((r) => r.text));
  });

  it('drops empty turns after scrubbing', async () => {
    const rows = await extractFrustrationUtterances(sourceOf([turn({ text: '   ' })], []), window);
    expect(rows).toEqual([]);
  });
});

describe('toUtterancesFile', () => {
  it('writes one utterance per line with embedded newlines collapsed', () => {
    const file = toUtterancesFile([
      { text: 'line one\nline two', firedBaseline: false },
      { text: 'second', firedBaseline: true, eventSource: 'keyword' },
    ]);
    expect(file).toBe('line one line two\nsecond\n');
  });
});
