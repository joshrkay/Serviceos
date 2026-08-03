/**
 * Pure path-smoke runner. Inject an LLMGateway (real or mock) — never opens
 * sockets itself. Used by the CLI script and offline unit tests.
 */
import type { LLMGateway } from '../../gateway/gateway';
import {
  PATH_SMOKE_CASES,
  PATH_SMOKE_PASS_RATIO,
  type PathSmokeCase,
} from './cases';

/** Synthetic tenant so gateway tier overrides apply (same as voice-eval live). */
export const PATH_SMOKE_TENANT_ID = 'system';

export interface PathSmokeTurnResult {
  utterance: string;
  expectedIntent: string;
  actualIntent: string;
  confidence: number;
  passed: boolean;
  error?: string;
  latencyMs: number;
}

export interface PathSmokeCaseResult {
  pathId: string;
  title: string;
  passed: boolean;
  turns: PathSmokeTurnResult[];
}

export interface PathSmokeReport {
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRatio: number;
  requiredPassRatio: number;
  gatePassed: boolean;
  results: PathSmokeCaseResult[];
  summaryLines: string[];
}

export interface RunPathSmokeOptions {
  gateway: LLMGateway;
  cases?: readonly PathSmokeCase[];
  passRatio?: number;
  /**
   * Optional classify function for tests. Defaults to production classifyIntent
   * loaded dynamically to keep this module light for typecheck.
   */
  classify?: (
    utterance: string,
    context: {
      tenantId: string;
      extendedIntents?: boolean;
      ownerSession?: boolean;
    },
    gateway: LLMGateway,
  ) => Promise<{ intentType: string; confidence: number }>;
}

async function defaultClassify(
  utterance: string,
  context: {
    tenantId: string;
    extendedIntents?: boolean;
    ownerSession?: boolean;
  },
  gateway: LLMGateway,
): Promise<{ intentType: string; confidence: number }> {
  // Dynamic import keeps offline tests that mock `classify` free of the
  // full classifier module graph when they inject their own.
  const { classifyIntent } = await import('../../orchestration/intent-classifier');
  const result = await classifyIntent(
    utterance,
    {
      tenantId: context.tenantId,
      ...(context.extendedIntents ? { extendedIntents: true } : {}),
      ...(context.ownerSession ? { ownerSession: true } : {}),
    },
    gateway,
  );
  return {
    intentType: result.intentType,
    confidence: result.confidence,
  };
}

function turnMatches(
  actual: string,
  expected: string,
  acceptable?: readonly string[],
): boolean {
  if (actual === expected) return true;
  if (acceptable?.includes(actual)) return true;
  return false;
}

export async function runPathSmoke(
  opts: RunPathSmokeOptions,
): Promise<PathSmokeReport> {
  const cases = opts.cases ?? PATH_SMOKE_CASES;
  const requiredPassRatio = opts.passRatio ?? PATH_SMOKE_PASS_RATIO;
  const classify = opts.classify ?? defaultClassify;
  const results: PathSmokeCaseResult[] = [];

  for (const c of cases) {
    const turnResults: PathSmokeTurnResult[] = [];
    for (const turn of c.turns) {
      const started = Date.now();
      try {
        const out = await classify(
          turn.utterance,
          {
            tenantId: PATH_SMOKE_TENANT_ID,
            extendedIntents: c.extendedIntents,
            ownerSession: c.ownerSession,
          },
          opts.gateway,
        );
        const passed = turnMatches(
          out.intentType,
          turn.expectedIntent,
          turn.acceptableIntents,
        );
        turnResults.push({
          utterance: turn.utterance,
          expectedIntent: turn.expectedIntent,
          actualIntent: out.intentType,
          confidence: out.confidence,
          passed,
          latencyMs: Date.now() - started,
        });
      } catch (err) {
        turnResults.push({
          utterance: turn.utterance,
          expectedIntent: turn.expectedIntent,
          actualIntent: '<error>',
          confidence: 0,
          passed: false,
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - started,
        });
      }
    }
    const casePassed = turnResults.every((t) => t.passed);
    results.push({
      pathId: c.pathId,
      title: c.title,
      passed: casePassed,
      turns: turnResults,
    });
  }

  const passedCases = results.filter((r) => r.passed).length;
  const totalCases = results.length;
  const passRatio = totalCases === 0 ? 1 : passedCases / totalCases;
  const gatePassed = passRatio + 1e-9 >= requiredPassRatio;

  const summaryLines = [
    `Agent path smoke: ${passedCases}/${totalCases} cases passed (${(passRatio * 100).toFixed(0)}%, need ${(requiredPassRatio * 100).toFixed(0)}%) — ${gatePassed ? 'PASS' : 'FAIL'}`,
    ...results.map((r) => {
      const flag = r.passed ? '✓' : '✗';
      const detail = r.turns
        .map(
          (t) =>
            `${t.expectedIntent}→${t.actualIntent}${t.error ? ` (${t.error})` : ''} @${t.confidence.toFixed(2)} ${t.latencyMs}ms`,
        )
        .join('; ');
      return `  ${flag} [${r.pathId}] ${r.title}: ${detail}`;
    }),
  ];

  return {
    generatedAt: new Date().toISOString(),
    totalCases,
    passedCases,
    failedCases: totalCases - passedCases,
    passRatio,
    requiredPassRatio,
    gatePassed,
    results,
    summaryLines,
  };
}
