/**
 * Offline graph-coverage unit tests — no network, no API keys.
 */
import { describe, it, expect } from 'vitest';
import { loadCorpus, defaultCorpusRoot } from '../../src/ai/voice-quality/corpus/loader';
import {
  CRITICAL_PATHS,
  computeGraphCoverage,
  coverageGatePasses,
  scriptCoversPathIds,
  pathSmokeRequiredPaths,
} from '../../src/ai/voice-quality/graph';
import {
  PATH_SMOKE_CASES,
  allPathSmokePathIds,
} from '../../src/ai/voice-quality/path-smoke';

describe('agent graph catalog', () => {
  it('has stable unique path ids', () => {
    const ids = CRITICAL_PATHS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every pathSmokeRequired path has a PATH_SMOKE_CASES entry', () => {
    const smokeIds = new Set(allPathSmokePathIds());
    for (const p of pathSmokeRequiredPaths()) {
      expect(smokeIds.has(p.id)).toBe(true);
    }
  });

  it('every PATH_SMOKE_CASES pathId exists in CRITICAL_PATHS', () => {
    const catalog = new Set(CRITICAL_PATHS.map((p) => p.id));
    for (const c of PATH_SMOKE_CASES) {
      expect(catalog.has(c.pathId)).toBe(true);
    }
  });
});

describe('scriptCoversPathIds', () => {
  it('maps create-appointment script to book', () => {
    const scripts = loadCorpus(defaultCorpusRoot());
    const book = scripts.find((s) => s.id === 'create-appointment-known-customer');
    expect(book).toBeDefined();
    const ids = scriptCoversPathIds(book!);
    expect(ids).toContain('book');
  });

  it('maps mumble script to confidence_low', () => {
    const scripts = loadCorpus(defaultCorpusRoot());
    const mumble = scripts.find((s) => s.id === 'mumble-low-confidence-reprompt');
    expect(mumble).toBeDefined();
    const ids = scriptCoversPathIds(mumble!);
    expect(ids).toContain('confidence_low');
  });
});

describe('computeGraphCoverage against real corpus', () => {
  it('covers all required paths when path-smoke ids are included', () => {
    const scripts = loadCorpus(defaultCorpusRoot());
    expect(scripts.length).toBeGreaterThan(40);

    const report = computeGraphCoverage({
      scripts,
      pathSmokeIds: allPathSmokePathIds(),
    });

    // Print summary on failure for debuggability.
    if (report.uncoveredRequired.length > 0) {
      // eslint-disable-next-line no-console
      console.log(report.summaryLines.join('\n'));
    }

    expect(report.uncoveredRequired.map((r) => r.path.id)).toEqual([]);
    expect(coverageGatePasses(report, 1)).toBe(true);
  });

  it('negotiation is covered via path-smoke even without a corpus script', () => {
    const scripts = loadCorpus(defaultCorpusRoot());
    const withoutSmoke = computeGraphCoverage({ scripts, pathSmokeIds: [] });
    const negWithout = withoutSmoke.rows.find((r) => r.path.id === 'negotiation');
    // May or may not be covered by corpus alone — path-smoke is the intended cover.
    const withSmoke = computeGraphCoverage({
      scripts,
      pathSmokeIds: ['negotiation'],
    });
    const negWith = withSmoke.rows.find((r) => r.path.id === 'negotiation');
    expect(negWith?.covered).toBe(true);
    expect(negWith?.sources).toContain('path-smoke');
    // If corpus didn't cover it, withoutSmoke should show gap/uncovered.
    if (negWithout && !negWithout.covered) {
      expect(negWithout.sources).toContain('gap');
    }
  });
});
