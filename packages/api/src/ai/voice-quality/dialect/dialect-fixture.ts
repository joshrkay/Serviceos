/**
 * Dialect eval — fixture builder (the call-mining flywheel bridge).
 *
 * Turns a flagged, human-labeled inbound call into a `DialectEvalCase` the
 * runner consumes: scrubs the labeler's corrected transcript through
 * `scrubPii` (`ai/training/scrub.ts`) and emits the case with the SCRUBBED
 * text as the ground-truth reference.
 *
 * Why scrub the reference: a dialect fixture is a durable, shareable artifact
 * (it lives in the repo / a fixture store), so it must not carry caller PII.
 * Default `rejectOnResidualPii: true` — stricter than the RAG path (which can
 * quarantine), because a fixture has no quarantine tier.
 *
 * Companion — `makeScrubbingTranscriber`: the call AUDIO still contains the
 * caller's spoken PII, so the ASR hypothesis will too. Computing WER between a
 * scrubbed reference and an unscrubbed hypothesis would both (a) leak PII into
 * the report and (b) inflate WER on placeholder mismatch. Wrap the runner's
 * transcriber so the hypothesis is scrubbed with the SAME per-call entities
 * before WER. (Known limitation: an accent can mangle a spoken name so the
 * exact-match name redaction misses it — phone/email/address still align via
 * the regex sweep, but reports should persist WER numbers + redactions, not
 * raw hypothesis text.)
 */
import { scrubPii, type KnownEntities, type Redaction } from '../../training/scrub';
import type { DialectEvalCase } from './dialect-report';
import type { DialectTranscriber } from './dialect-runner';

export interface LabeledDialectCall {
  /** Stable id (e.g. the call / recording id) → DialectEvalCase.id. */
  id: string;
  /** Accent/dialect tag assigned during labeling, e.g. 'southern-us'. */
  dialect: string;
  /** Human-corrected ground-truth transcript of what the caller said. */
  correctedTranscript: string;
  /** Confirmed true intent. Omit for ASR-only cases. */
  expectedIntent?: string;
  /** Path/key to the call audio fixture (the recording) for the runner. */
  audioFixture: string;
  /**
   * Known PII attached to the inbound caller (from customers /
   * service_locations / appointments) — fed to scrubPii for exact-match
   * redaction before the regex sweep. The SAME entities feed
   * `makeScrubbingTranscriber` so the hypothesis is scrubbed symmetrically.
   */
  knownEntities?: KnownEntities;
}

export interface DialectFixtureResult {
  fixture: DialectEvalCase;
  /** Redactions applied to the reference (audit only — never stored with the fixture). */
  redactions: Redaction[];
  hasResidualPii: boolean;
  residualSignals: string[];
}

export interface BuildDialectFixtureOptions {
  /** Refuse to emit a fixture whose scrubbed transcript still trips the residual gate. Default true. */
  rejectOnResidualPii?: boolean;
}

/** Build one `DialectEvalCase` from a labeled call, scrubbing the reference. */
export function buildDialectFixtureFromCall(
  call: LabeledDialectCall,
  options: BuildDialectFixtureOptions = {},
): DialectFixtureResult {
  const reject = options.rejectOnResidualPii ?? true;
  const scrub = scrubPii(
    call.correctedTranscript,
    call.knownEntities ? { knownEntities: call.knownEntities } : {},
  );
  if (scrub.hasResidualPii && reject) {
    throw new Error(
      `buildDialectFixtureFromCall: call ${call.id} still has PII after scrub ` +
        `(${scrub.residualSignals.join(', ')}). Fix the corrected transcript or supply knownEntities.`,
    );
  }
  const fixture: DialectEvalCase = {
    id: call.id,
    dialect: call.dialect,
    referenceTranscript: scrub.scrubbed,
    audioFixture: call.audioFixture,
    ...(call.expectedIntent !== undefined ? { expectedIntent: call.expectedIntent } : {}),
  };
  return {
    fixture,
    redactions: scrub.redactions,
    hasResidualPii: scrub.hasResidualPii,
    residualSignals: scrub.residualSignals,
  };
}

export interface BuildDialectFixturesOutcome {
  fixtures: DialectEvalCase[];
  /** Calls skipped because the scrubbed transcript still tripped the residual gate. */
  skipped: Array<{ id: string; residualSignals: string[] }>;
}

/**
 * Batch builder. Residual-PII calls are collected in `skipped` rather than
 * thrown, so one dirty call can't drop the whole batch — the caller fixes
 * those (better corrected transcript / more known entities) and re-runs.
 */
export function buildDialectFixtures(
  calls: ReadonlyArray<LabeledDialectCall>,
): BuildDialectFixturesOutcome {
  const fixtures: DialectEvalCase[] = [];
  const skipped: BuildDialectFixturesOutcome['skipped'] = [];
  for (const call of calls) {
    const r = buildDialectFixtureFromCall(call, { rejectOnResidualPii: false });
    if (r.hasResidualPii) {
      skipped.push({ id: call.id, residualSignals: r.residualSignals });
    } else {
      fixtures.push(r.fixture);
    }
  }
  return { fixtures, skipped };
}

/** Scrub a transcript for a dialect fixture/hypothesis; returns just the scrubbed string. */
export function scrubForDialect(text: string, knownEntities?: KnownEntities): string {
  return scrubPii(text, knownEntities ? { knownEntities } : {}).scrubbed;
}

/**
 * Wrap a transcriber so its ASR hypothesis is scrubbed with the SAME per-call
 * entities used to build the reference — a PII-safe, placeholder-aligned WER.
 * `entitiesFor` returns the known entities for a case (e.g. a lookup keyed by
 * case id, sourced from the same labeling record the fixture came from).
 */
export function makeScrubbingTranscriber(
  inner: DialectTranscriber,
  entitiesFor: (evalCase: DialectEvalCase) => KnownEntities | undefined,
): DialectTranscriber {
  return async (evalCase) => scrubForDialect(await inner(evalCase), entitiesFor(evalCase));
}
