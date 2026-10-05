/**
 * #1602 — `gradeVoiceSession(tenantId, sessionId)`: grade ONE production call
 * with the existing Layer 2 graders and persist the result.
 *
 * Reuses, unchanged:
 *   - `gradePerceivedCompletion` (criterion 12, whole-transcript judge — one
 *     LLM call per call);
 *   - `gradeDispositionLlm` (criteria 10 + 12 per caller turn — one judge
 *     call per answered turn, bounded by `maxDispositionTurns`);
 *   - `noHang` (floor #3) over the stored timing markers when present.
 *
 * Gates, in order (each a `skipped` result with its reason, no LLM spend):
 *   not_found · not_ended · not_inbound · no_disclosure (consent gate — see
 *   `GradableVoiceSession.recordingDisclosed`) · not_billable (owner /
 *   business-phone test calls per `call_usage_events.billable`) ·
 *   empty_transcript. An already-graded call returns its stored grade unless
 *   `force` (the manual re-grade path).
 *
 * Cost accounting: the gateway handed to the graders is wrapped so every
 * judge call is attributed to the REAL tenant (the harness graders stamp the
 * system bucket), counted, and its `costMicroCents` summed onto the grade.
 * `resetJudgeCache()` runs after each call: the disposition grader's
 * module-level cache is keyed by script id, which is unique per production
 * call, so without the reset a long-lived worker would only ever grow it.
 */
import { randomUUID } from 'crypto';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../ai/gateway/gateway';
import { gradePerceivedCompletion } from '../../ai/voice-quality/graders/perceived-completion';
import { gradeDispositionLlm, resetJudgeCache } from '../../ai/voice-quality/graders/disposition-llm';
import { noHang } from '../../ai/voice-quality/graders/floor';
import { buildGraderInputs } from './transcript-observation';
import type {
  VoiceGradeTrigger,
  VoiceSessionGrade,
  VoiceSessionGradeCriterion,
  VoiceSessionGradeStore,
} from './voice-session-grade-store';

/** Structural slice of the LLM gateway — what the graders actually call. */
export interface GraderGateway {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export type GradeSkipReason =
  | 'not_found'
  | 'not_ended'
  | 'not_inbound'
  | 'no_disclosure'
  | 'not_billable'
  | 'empty_transcript';

export type GradeVoiceSessionResult =
  | { status: 'graded'; grade: VoiceSessionGrade }
  | { status: 'already_graded'; grade: VoiceSessionGrade }
  | { status: 'skipped'; reason: GradeSkipReason };

export interface VoiceSessionGraderDeps {
  store: VoiceSessionGradeStore;
  gateway: GraderGateway;
  now?: () => Date;
  /**
   * Cost bound per call: the disposition judge runs once per caller turn, so
   * only the first N turns are judged (default 12). Perceived completion
   * always reads the whole transcript in its single call.
   */
  maxDispositionTurns?: number;
}

export interface GradeVoiceSessionOptions {
  trigger?: VoiceGradeTrigger;
  /** Re-grade even when a grade exists (manual path). */
  force?: boolean;
}

export const DEFAULT_MAX_DISPOSITION_TURNS = 12;

/** Rubric v1 names for the criteria this service grades. */
const CRITERION_NAME: Record<number, string> = {
  3: 'noHang',
  10: 'rightSlotsExtracted',
  12: 'rightCallerFacingAnswer',
};

export interface VoiceSessionGrader {
  gradeVoiceSession(
    tenantId: string,
    sessionId: string,
    opts?: GradeVoiceSessionOptions,
  ): Promise<GradeVoiceSessionResult>;
}

export function createVoiceSessionGrader(deps: VoiceSessionGraderDeps): VoiceSessionGrader {
  const now = deps.now ?? (() => new Date());
  const maxDispositionTurns = deps.maxDispositionTurns ?? DEFAULT_MAX_DISPOSITION_TURNS;

  async function gradeVoiceSession(
    tenantId: string,
    sessionId: string,
    opts: GradeVoiceSessionOptions = {},
  ): Promise<GradeVoiceSessionResult> {
    const session = await deps.store.loadSession(tenantId, sessionId);
    if (!session) return { status: 'skipped', reason: 'not_found' };
    if (!session.endedAt) return { status: 'skipped', reason: 'not_ended' };
    if (session.channel !== 'voice_inbound') return { status: 'skipped', reason: 'not_inbound' };
    if (!session.recordingDisclosed) return { status: 'skipped', reason: 'no_disclosure' };
    if (session.billable !== true) return { status: 'skipped', reason: 'not_billable' };

    if (!opts.force) {
      const existing = await deps.store.findGrade(tenantId, sessionId);
      if (existing) return { status: 'already_graded', grade: existing };
    }

    const endedAt = session.endedAt;
    const full = buildGraderInputs(session, endedAt);
    if (full.turns.length === 0) return { status: 'skipped', reason: 'empty_transcript' };

    const accounting = { calls: 0, model: '', costMicroCents: 0 };
    const gateway = {
      complete: async (request: LLMRequest): Promise<LLMResponse> => {
        const response = await deps.gateway.complete({ ...request, tenantId });
        accounting.calls += 1;
        accounting.model = response.model;
        accounting.costMicroCents += response.costMicroCents ?? 0;
        return response;
      },
    } as unknown as LLMGateway;

    const criteria: VoiceSessionGradeCriterion[] = [];
    try {
      if (full.observation.perTurnLatencyMs.length > 0) {
        const hang = noHang(full.observation);
        criteria.push({
          grader: 'floor',
          criterion: 3,
          name: CRITERION_NAME[3],
          passed: hang.passed,
          rationale: hang.reason ?? 'Every turn was answered within the 7s hard cap',
        });
      }

      const perceived = await gradePerceivedCompletion({
        observation: full.observation,
        script: full.script,
        gateway,
      });
      criteria.push({
        grader: 'perceived_completion',
        criterion: 12,
        name: CRITERION_NAME[12],
        passed: perceived.passed,
        rationale: perceived.verdict.rationale,
      });

      const bounded =
        full.turns.length > maxDispositionTurns
          ? buildGraderInputs(session, endedAt, maxDispositionTurns)
          : full;
      const disposition = await gradeDispositionLlm({
        observation: bounded.observation,
        script: bounded.script,
        gateway,
      });
      for (const criterion of [12, 10] as const) {
        const failed = disposition.failedCriteria.includes(criterion);
        criteria.push({
          grader: 'disposition_llm',
          criterion,
          name: CRITERION_NAME[criterion],
          passed: !failed,
          rationale: failed
            ? disposition.reasons[criterion]
            : dispositionPassRationale(disposition.perTurnDetail),
        });
      }
    } finally {
      resetJudgeCache();
    }

    const grade: VoiceSessionGrade = {
      id: randomUUID(),
      tenantId,
      sessionId,
      gradedAt: now(),
      passed: criteria.every((c) => c.passed),
      criteria,
      rubricVersion: 'v1',
      model: accounting.model,
      judgeCalls: accounting.calls,
      costMicroCents: accounting.costMicroCents,
      trigger: opts.trigger ?? 'manual',
      callEndedAt: endedAt,
      outcome: session.outcome,
    };
    await deps.store.saveGrade(grade);
    return { status: 'graded', grade };
  }

  return { gradeVoiceSession };
}

/**
 * The disposition grader only names a reason for a FAILED criterion. For a
 * pass, surface the judge's rationale from the last judged turn so the owner
 * still sees why the call was called right.
 */
function dispositionPassRationale(
  detail: ReadonlyArray<{ spokenAnswer: string | null; judgeRationale: string }>,
): string {
  const judged = detail.filter((d) => d.spokenAnswer !== null);
  const last = judged[judged.length - 1];
  return last ? last.judgeRationale : 'No agent reply was captured to judge';
}
