/**
 * Unit tests for the deterministic cassette-staleness analyzer. Crafted
 * cassettes pin the contract: accretion depth is keyed on the SAME
 * (schema, system-fingerprint, user) grouping the replay fallback uses, age
 * is measured from the newest recording, and aggregation/sorting are stable.
 */
import { describe, it, expect } from 'vitest';
import type { CassetteEntry } from '../../src/ai/voice-quality/cassette-gateway';
import {
  analyzeCassetteStaleness,
  formatStalenessReport,
  type CassetteInput,
} from '../../src/ai/voice-quality/cassette-staleness';

const NOW = new Date('2026-06-21T00:00:00.000Z');

function entry(opts: {
  system: string;
  user: string;
  recordedAt: string;
  schema?: string;
}): CassetteEntry {
  const prompt = JSON.stringify([
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ]);
  return {
    requestHash: `sha256:${opts.recordedAt}:${opts.user}:${opts.system.length}`,
    request: { model: 'm', prompt, schema: opts.schema ?? 'json' },
    response: {
      content: '{}',
      model: 'm',
      provider: 'mock',
      tokenUsage: { input: 0, output: 0, total: 0 },
      latencyMs: 0,
    },
    tokenUsage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    recordedAt: opts.recordedAt,
  };
}

// One logical call (classifier + "reschedule please") re-recorded 4× as the
// system prompt's intent list grew — the real corpus pathology.
const driftedCassette: CassetteInput = {
  scriptId: 'reschedule',
  entries: [
    entry({ system: 'You are an intent classifier. Intents: a, b.', user: 'reschedule please', recordedAt: '2026-06-10T00:00:00.000Z' }),
    entry({ system: 'You are an intent classifier. Intents: a, b, c.', user: 'reschedule please', recordedAt: '2026-06-12T00:00:00.000Z' }),
    entry({ system: 'You are an intent classifier. Intents: a, b, c, d.', user: 'reschedule please', recordedAt: '2026-06-14T00:00:00.000Z' }),
    entry({ system: 'You are an intent classifier. Intents: a, b, c, d, e.', user: 'reschedule please', recordedAt: '2026-06-18T00:00:00.000Z' }),
  ],
};

// Two DISTINCT calls (classifier + slot-extractor), one recording each — fresh.
const freshCassette: CassetteInput = {
  scriptId: 'happy-booker',
  entries: [
    entry({ system: 'You are an intent classifier. x.', user: 'book me', recordedAt: '2026-06-20T00:00:00.000Z' }),
    entry({ system: 'You are a slot extractor. y.', user: 'book me', recordedAt: '2026-06-20T00:00:00.000Z' }),
  ],
};

// Single recording, but recorded 51 days before NOW — stale by age.
const oldCassette: CassetteInput = {
  scriptId: 'old-one',
  entries: [entry({ system: 'You are an intent classifier. z.', user: 'hello', recordedAt: '2026-05-01T00:00:00.000Z' })],
};

describe('analyzeCassetteStaleness', () => {
  it('accretion depth = number of re-recordings of one logical call', () => {
    const r = analyzeCassetteStaleness([driftedCassette], NOW);
    const c = r.cassettes[0]!;
    expect(c.entryCount).toBe(4);
    expect(c.callCount).toBe(1); // all 4 share schema + classifier fingerprint + user
    expect(c.maxDepth).toBe(4);
    expect(c.driftedCalls).toBe(1);
    expect(c.ageDays).toBe(3); // newest 2026-06-18 → 3 days before NOW
    expect(c.stale).toBe(false); // 3d is within the freshness threshold (age-only)
    expect(c.deeplyAccreted).toBe(true); // depth 4 > maxDepth threshold 3
    expect(c.reasons.join(' ')).toContain('4 recordings');
  });

  it('distinct logical calls are NOT counted as accretion', () => {
    const r = analyzeCassetteStaleness([freshCassette], NOW);
    const c = r.cassettes[0]!;
    expect(c.callCount).toBe(2); // classifier vs slot-extractor fingerprints differ
    expect(c.maxDepth).toBe(1);
    expect(c.driftedCalls).toBe(0);
    expect(c.stale).toBe(false);
  });

  it('schema is part of the call key (same fp+user, different schema = 2 calls)', () => {
    const c = analyzeCassetteStaleness(
      [
        {
          scriptId: 's',
          entries: [
            entry({ system: 'You are an intent classifier. q.', user: 'hi', schema: 'json', recordedAt: '2026-06-20T00:00:00.000Z' }),
            entry({ system: 'You are an intent classifier. q.', user: 'hi', schema: 'text', recordedAt: '2026-06-20T00:00:00.000Z' }),
          ],
        },
      ],
      NOW,
    ).cassettes[0]!;
    expect(c.callCount).toBe(2);
    expect(c.maxDepth).toBe(1);
  });

  it('flags staleness by recording age', () => {
    const c = analyzeCassetteStaleness([oldCassette], NOW).cassettes[0]!;
    expect(c.ageDays).toBe(51);
    expect(c.stale).toBe(true);
    expect(c.reasons.join(' ')).toContain('51d old');
  });

  it('aggregates and sorts most-stale (oldest) first', () => {
    const r = analyzeCassetteStaleness([freshCassette, driftedCassette, oldCassette], NOW);
    expect(r.cassetteCount).toBe(3);
    expect(r.totalEntries).toBe(7);
    expect(r.accretedCassettes).toBe(1); // only the drifted one has a depth>=2 call
    expect(r.deeplyAccretedCassettes).toBe(1); // drifted depth 4 > 3
    expect(r.staleCassettes).toBe(1); // only old-one is stale by age
    expect(r.cassettes.map((c) => c.scriptId)).toEqual(['old-one', 'reschedule', 'happy-booker']);
    expect(r.newestRecordedAt).toBe('2026-06-20T00:00:00.000Z');
    expect(r.oldestRecordedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(r.medianAgeDays).toBe(3); // ages [1, 3, 51] → median 3
  });

  it('respects custom thresholds', () => {
    // Tighten depth so the drifted cassette is over, loosen age so old is fresh.
    const r = analyzeCassetteStaleness([driftedCassette, oldCassette], NOW, {
      maxAgeDays: 60,
      maxDepth: 2,
    });
    const drifted = r.cassettes.find((c) => c.scriptId === 'reschedule')!;
    const old = r.cassettes.find((c) => c.scriptId === 'old-one')!;
    expect(drifted.deeplyAccreted).toBe(true); // depth 4 > 2
    expect(drifted.stale).toBe(false); // age 3d < 60d
    expect(old.stale).toBe(false); // 51d < 60d
    expect(old.deeplyAccreted).toBe(false); // depth 1
  });

  it('handles an empty cassette without throwing', () => {
    const c = analyzeCassetteStaleness([{ scriptId: 'empty', entries: [] }], NOW).cassettes[0]!;
    expect(c.entryCount).toBe(0);
    expect(c.callCount).toBe(0);
    expect(c.maxDepth).toBe(0);
    expect(c.ageDays).toBeNull();
    expect(c.stale).toBe(false);
    expect(c.deeplyAccreted).toBe(false);
  });

  it('formatStalenessReport surfaces flagged rows and a fresh count', () => {
    const r = analyzeCassetteStaleness([freshCassette, driftedCassette, oldCassette], NOW);
    const md = formatStalenessReport(r);
    expect(md).toContain('reschedule');
    expect(md).toContain('old-one');
    expect(md).toContain('1 fresh cassette'); // happy-booker summarized, not tabled
  });

  it('formatStalenessReport reports a fully fresh corpus cleanly', () => {
    const md = formatStalenessReport(analyzeCassetteStaleness([freshCassette], NOW));
    expect(md).toContain('corpus is fresh');
  });
});
