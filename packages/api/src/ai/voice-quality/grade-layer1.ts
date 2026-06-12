/**
 * VQ-023 — Layer 1 per-script grading (floor + disposition).
 *
 * The corpus runner (`runScript`) only produces an `Observation`. This
 * module folds floor + structured-disposition + LLM-disposition graders
 * into a `PerScriptVerdict` for the report aggregator.
 */
import type { LLMGateway } from '../gateway/gateway';
import type { Observation } from './observation';
import type { VoiceQualityScript } from './schema';
import { gradeFloor } from './graders/floor';
import { gradeDispositionStructured } from './graders/disposition-structured';
import { gradeDispositionLlm } from './graders/disposition-llm';
import { gradeDisclosureTiming } from './graders/disclosure-timing';
import type { PerScriptVerdict } from './graders/report';

export interface GradeLayer1Input {
  observation: Observation;
  script: VoiceQualityScript;
  gateway: LLMGateway;
  durationMs: number;
}

export async function gradeLayer1Script(
  input: GradeLayer1Input,
): Promise<PerScriptVerdict> {
  const floorResult = gradeFloor(input.observation, input.script);

  // RV-131 — disclosure-timing check, REPORT-ONLY (see
  // graders/disclosure-timing.ts header for why it is not a floor
  // criterion and not a verdict field): a violation surfaces as a warning
  // in the corpus run output and never moves `passed` / the launch gate.
  const disclosureTiming = gradeDisclosureTiming(input.observation);
  if (disclosureTiming.applicable && !disclosureTiming.passed) {
    // eslint-disable-next-line no-console
    console.warn(
      `[voice-quality] RV-131 disclosure-timing violation on ${input.script.id}: ` +
        (disclosureTiming.reason ?? 'unknown'),
    );
  }
  const dispositionStructuredResult = gradeDispositionStructured(
    input.observation,
    input.script,
  );
  const dispositionLlmResult = await gradeDispositionLlm({
    observation: input.observation,
    script: input.script,
    gateway: input.gateway,
  });

  const passed =
    floorResult.passed &&
    dispositionStructuredResult.passed &&
    dispositionLlmResult.passed;

  return {
    scriptId: input.script.id,
    bucket: input.script.bucket,
    passed,
    floorResult,
    dispositionStructuredResult,
    dispositionLlmResult,
    durationMs: input.durationMs,
    costCents: input.observation.totalCostCents,
    perTurnLatencyMs: input.observation.perTurnLatencyMs,
  };
}
