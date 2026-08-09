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
  pruneEntriesBefore,
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

  it('surfaces an unparseable recordedAt instead of silently treating it as fresh', () => {
    const r = analyzeCassetteStaleness(
      [
        {
          scriptId: 'corrupt',
          entries: [entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-13-99T00:00:00.000Z' })],
        },
      ],
      NOW,
    );
    const c = r.cassettes[0]!;
    expect(c.ageDays).toBeNull(); // NOT NaN
    expect(c.stale).toBe(true); // flagged, not hidden
    expect(c.reasons.join(' ')).toContain('unparseable');
    expect(r.medianAgeDays).toBeNull(); // NaN must not poison the aggregate
  });

  it('report-level recording span orders chronologically across cassettes (mixed offsets)', () => {
    const r = analyzeCassetteStaleness(
      [
        {
          scriptId: 'early',
          entries: [entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-05-01T00:00:00.000Z' })],
        },
        {
          scriptId: 'late',
          entries: [
            entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-06-18T00:00:00.000Z' }),
            entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-06-17T20:00:00.000-05:00' }),
          ],
        },
      ],
      NOW,
    );
    expect(r.oldestRecordedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(r.newestRecordedAt).toBe('2026-06-17T20:00:00.000-05:00');
  });

  it('orders recordedAt chronologically, not lexically (timezone offsets)', () => {
    // 2026-06-17T20:00-05:00 == 2026-06-18T01:00Z is the true newest, yet its
    // string sorts lexically *before* the 2026-06-18T00:00Z entry.
    const c = analyzeCassetteStaleness(
      [
        {
          scriptId: 'tz',
          entries: [
            entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-06-18T00:00:00.000Z' }),
            entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-06-17T20:00:00.000-05:00' }),
          ],
        },
      ],
      NOW,
    ).cassettes[0]!;
    expect(c.newestRecordedAt).toBe('2026-06-17T20:00:00.000-05:00');
    expect(c.oldestRecordedAt).toBe('2026-06-18T00:00:00.000Z');
  });

  it('keys calls structurally — a "::" in user/fingerprint text cannot collide distinct calls', () => {
    // Under a `${schema}::${fp}::${user}` join these two collapse to one key
    // ("...::A::y::z"); they are two distinct logical calls.
    const c = analyzeCassetteStaleness(
      [
        {
          scriptId: 'colon',
          entries: [
            entry({ system: 'A', user: 'y::z', recordedAt: '2026-06-20T00:00:00.000Z' }),
            entry({ system: 'A::y', user: 'z', recordedAt: '2026-06-20T00:00:00.000Z' }),
          ],
        },
      ],
      NOW,
    ).cassettes[0]!;
    expect(c.callCount).toBe(2);
    expect(c.maxDepth).toBe(1);
    expect(c.driftedCalls).toBe(0);
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

/**
 * `pruneEntriesBefore` — tooling follow-up (2026-08-09). Every taxonomy
 * change invalidates the hash for every classify_intent cassette entry
 * corpus-wide (the system prompt is shared verbatim across every call), and
 * `refresh` mode only ever APPENDS/overwrites — it never removes a
 * superseded entry, so cassette files grow monotonically.
 *
 * A callKey-grouping design ("keep only pickNewestRecording per (schema,
 * fp, user) group") was tried first and REJECTED — see the doc comment on
 * `pruneEntriesBefore` in cassette-staleness.ts for the full story: running
 * it against the real corpus proved two DIFFERENT live requests can share
 * one callKey (`spam-create-customer`, traced to two call sites sharing an
 * utterance), so grouping-based pruning silently deleted a still-needed
 * entry and broke strict replay. `pruneEntriesBefore` sidesteps grouping
 * entirely: it keeps everything (re)written at/after a cutoff captured
 * immediately before an authoritative refresh pass. These tests pin that
 * simpler, safe contract — including a reconstruction of the exact
 * counterexample that sank the grouping design.
 */
describe('pruneEntriesBefore', () => {
  const CUTOFF = '2026-06-20T00:00:00.000Z';

  it('keeps an entry recorded exactly AT the cutoff (inclusive boundary)', () => {
    const e = entry({ system: 'You are X. a', user: 'hi', recordedAt: CUTOFF });
    const { kept, pruned } = pruneEntriesBefore([e], CUTOFF);
    expect(kept).toEqual([e]);
    expect(pruned).toEqual([]);
  });

  it('keeps an entry recorded AFTER the cutoff', () => {
    const e = entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-06-20T00:00:00.001Z' });
    const { kept } = pruneEntriesBefore([e], CUTOFF);
    expect(kept).toEqual([e]);
  });

  it('prunes an entry recorded BEFORE the cutoff', () => {
    const e = entry({ system: 'You are X. a', user: 'hi', recordedAt: '2026-06-19T23:59:59.999Z' });
    const { kept, pruned } = pruneEntriesBefore([e], CUTOFF);
    expect(kept).toEqual([]);
    expect(pruned).toEqual([e]);
  });

  // THE counterexample that sank the callKey-grouping design: two entries
  // that share (schema, system-fingerprint, last-user-message) — i.e. would
  // collapse to ONE group under that design — but are BOTH genuinely live
  // (both freshly (re)written by the same authoritative refresh pass, so
  // both carry a post-cutoff recordedAt). A grouping-based prune would keep
  // only the newer one and break the other's exact-hash replay; a
  // cutoff-based prune keeps BOTH, because it never groups at all.
  it('keeps BOTH entries of a same-callKey pair when both are post-cutoff (the spam-create-customer counterexample)', () => {
    const shortForm = entry({
      system: 'You are an intent classifier. x.',
      user: 'I want to create a new customer.',
      recordedAt: '2026-06-20T00:00:00.100Z',
    });
    const withProtectionSection = entry({
      system: 'You are an intent classifier. x.',
      user: 'I want to create a new customer.',
      recordedAt: '2026-06-20T00:00:00.200Z',
    });
    // Same callKey by construction (identical system fingerprint + user +
    // schema) — a grouping design would treat these as ONE logical call.
    const { kept, pruned } = pruneEntriesBefore([shortForm, withProtectionSection], CUTOFF);
    expect(kept).toEqual([shortForm, withProtectionSection]);
    expect(pruned).toEqual([]);
  });

  it('a mix of pre- and post-cutoff entries splits correctly, preserving original order among survivors', () => {
    const stale1 = entry({ system: 'You are X. a', user: 'old call 1', recordedAt: '2026-06-01T00:00:00.000Z' });
    const fresh1 = entry({ system: 'You are X. a', user: 'call A', recordedAt: '2026-06-20T00:00:00.000Z' });
    const stale2 = entry({ system: 'You are X. a', user: 'old call 2', recordedAt: '2026-06-10T00:00:00.000Z' });
    const fresh2 = entry({ system: 'You are X. a', user: 'call B', recordedAt: '2026-06-21T00:00:00.000Z' });
    const { kept, pruned } = pruneEntriesBefore([stale1, fresh1, stale2, fresh2], CUTOFF);
    expect(kept).toEqual([fresh1, fresh2]);
    expect(pruned).toEqual([stale1, stale2]);
  });

  // Mirrors analyzeCassetteStaleness's own posture: an unparseable/missing
  // recordedAt is surfaced as unsafe, never silently treated as fresh (kept).
  it('treats a missing/malformed recordedAt as prunable, never silently kept', () => {
    const malformed = entry({ system: 'You are X. a', user: 'hi', recordedAt: 'not-a-date' });
    const { kept, pruned } = pruneEntriesBefore([malformed], CUTOFF);
    expect(kept).toEqual([]);
    expect(pruned).toEqual([malformed]);
  });

  it('an empty cassette prunes to nothing, without throwing', () => {
    const { kept, pruned } = pruneEntriesBefore([], CUTOFF);
    expect(kept).toEqual([]);
    expect(pruned).toEqual([]);
  });

  it('a fully fresh cassette (every entry post-cutoff) prunes nothing', () => {
    const { kept, pruned } = pruneEntriesBefore(freshCassette.entries, CUTOFF);
    expect(kept).toEqual(freshCassette.entries);
    expect(pruned).toEqual([]);
  });

  it('a cassette entirely pre-cutoff (never refreshed) prunes everything', () => {
    const { kept, pruned } = pruneEntriesBefore(driftedCassette.entries, CUTOFF);
    expect(kept).toEqual([]);
    expect(pruned).toEqual(driftedCassette.entries);
  });
});
