/**
 * Shared, pure helpers for the in-app 50-case verification suite
 * (docs/plans/2026-09-09-inapp-50-cases-plan.md).
 *
 * Consumed by:
 *   - scripts/inapp-50/release-gate.mjs   (CLI gate)
 *   - scripts/inapp-50/triage-report.mjs  (CLI "degradation causes" report)
 *   - scripts/inapp-50/build-dashboard.mjs (CLI dashboard.html)
 *   - scripts/__tests__/inapp-50-lib.test.mjs
 *
 * Everything here is pure (fs reads aside) and independent of the harness
 * that PRODUCES run-*.json — this module only ever READS the run artifact
 * shape documented under "Run artifact" in the plan. It never trusts a run's
 * own `summary` block: every summary consumed elsewhere is recomputed from
 * `cases[]` by `summarize()`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Severity precedence, most release-critical first. */
export const SEVERITY_ORDER = ['critical', 'core', 'growth'];

/** Verdict precedence, worst first — used for sorting/ranking, not display. */
export const VERDICT_ORDER = ['FAIL', 'DEGRADED', 'PARTIAL', 'PASS'];

/** Root-cause taxonomy from the plan's "Root cause" table (fixed display order). */
export const ROOT_CAUSE_CATEGORIES = [
  'intent',
  'slot_capture',
  'proposal_generation',
  'fallback',
  'infra',
];

/**
 * Clusters whose critical cases gate the release when they end
 * `intent_capture_only` (Gate rule 2 in the plan).
 */
export const GATED_CLUSTERS = ['scheduling', 'search', 'confirmations'];

/** Stages that count as "intent captured but nothing landed" per the plan. */
export const INTENT_CAPTURE_ONLY_STAGES = new Set([
  'intent_detected',
  'clarification_asked',
  'confirmation_asked',
]);

const VERDICT_KEYS = ['PASS', 'PARTIAL', 'DEGRADED', 'FAIL'];

/**
 * The entry points a run can cover, in canonical order:
 *   voice       the live-voice session panel (`POST /api/voice/sessions`)
 *   chat        the assistant page, typed  (`POST /api/assistant/chat`)
 *   chat-voice  the assistant page, mic     (same route, `inputMode: 'voice'`)
 *
 * Kept in sync with `SURFACES` in
 * packages/api/src/ai/voice-quality/inapp-50/register.ts.
 */
export const SURFACES = ['voice', 'chat', 'chat-voice'];

/** Runs written before the register grew a chat surface carry no field. */
export function caseSurface(caseResult) {
  return caseResult?.surface ?? 'voice';
}

/** `book-01` on voice, `book-01@chat` elsewhere — never collapse the two. */
export function caseLabel(caseResult) {
  const surface = caseSurface(caseResult);
  return surface === 'voice' ? caseResult?.key : `${caseResult?.key}@${surface}`;
}

/**
 * How many register cases a clean run of `surface` should contain. A case the
 * register declares meaningless on chat (`chat.skip`) is not run there, so it
 * is not owed a PASS either.
 */
export function expectedCaseCount(register, surface) {
  const cases = Array.isArray(register?.cases) ? register.cases : [];
  if (cases.length === 0) return 50;
  if (surface === 'voice') return cases.length;
  return cases.filter((c) => !c?.chat?.skip).length;
}

function emptyVerdictCounts() {
  return { PASS: 0, PARTIAL: 0, DEGRADED: 0, FAIL: 0 };
}

function emptyRootCauseCounts() {
  return Object.fromEntries(ROOT_CAUSE_CATEGORIES.map((c) => [c, 0]));
}

/**
 * A case is `intent_capture_only` when the furthest stage it reached is one
 * of the three "captured but not acted on" stages, it minted zero proposals,
 * and it did not end in a spoken lookup answer.
 * (docs/plans/2026-09-09-inapp-50-cases-plan.md, stage table + gate rule 2.)
 */
export function isIntentCaptureOnly(caseResult) {
  const stage = caseResult?.stage;
  const proposalCount = Array.isArray(caseResult?.proposals) ? caseResult.proposals.length : 0;
  return INTENT_CAPTURE_ONLY_STAGES.has(stage) && proposalCount === 0 && stage !== 'answered';
}

/**
 * Load every `run-*.json` in `dir` (NOT `latest.json`, which is a copy of
 * the newest full run — see loadLatest). Sorted ascending by `startedAt`
 * (ties broken by filename) so callers can walk chronologically and diff
 * consecutive entries. Batch runs (`run.batch != null`, written as
 * `run-<ISO>-batch<N>.json`) are included and flagged via `isBatch` rather
 * than silently mixed in as if they covered all 50 cases.
 *
 * Returns `[]` if `dir` does not exist (fresh checkout, harness hasn't run
 * yet) rather than throwing.
 */
export function loadRuns(dir) {
  if (!fs.existsSync(dir)) return [];
  const fileNames = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('run-') && f.endsWith('.json'));

  const runs = fileNames.map((fileName) => {
    const filePath = path.join(dir, fileName);
    let run;
    try {
      run = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`loadRuns: failed to parse ${filePath}: ${err.message}`);
    }
    return {
      fileName,
      filePath,
      run,
      isBatch: run?.batch != null,
    };
  });

  runs.sort((a, b) => {
    const at = a.run?.startedAt ?? '';
    const bt = b.run?.startedAt ?? '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
  });

  return runs;
}

/**
 * Load `dir/latest.json` — a copy of the newest full (non-batch) run per
 * the plan. Returns `null` if it does not exist rather than throwing, so
 * callers (e.g. the release gate) can report a clear "no results yet"
 * message instead of an unhandled exception.
 */
export function loadLatest(dir) {
  const filePath = path.join(dir, 'latest.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Recompute a run's PASS/PARTIAL/DEGRADED/FAIL summary — by severity, by
 * cluster, by root-cause category, and the critical intent-capture-only
 * list — directly from `run.cases[]`. Never reads `run.summary`: that
 * field is a courtesy the harness writes for humans skimming the JSON, not
 * a value this suite treats as ground truth (a stale/hand-edited summary
 * block must not be able to move the gate).
 *
 * Shape matches the plan's `summary` block minus `gate` (see gateVerdict,
 * which needs the register to compute the gate and returns the gate
 * alongside a fresh summarize() call).
 */
export function summarize(run) {
  const cases = Array.isArray(run?.cases) ? run.cases : [];

  const counts = emptyVerdictCounts();
  const bySeverity = {};
  const byCluster = {};
  const bySurface = {};
  const byRootCause = emptyRootCauseCounts();
  const intentCaptureOnlyCritical = [];

  for (const c of cases) {
    const verdict = VERDICT_KEYS.includes(c?.verdict) ? c.verdict : undefined;
    if (verdict) counts[verdict] += 1;

    const surface = caseSurface(c);
    bySurface[surface] ??= { ...emptyVerdictCounts(), total: 0 };
    bySurface[surface].total += 1;
    if (verdict) bySurface[surface][verdict] += 1;

    if (c?.severity) {
      bySeverity[c.severity] ??= emptyVerdictCounts();
      if (verdict) bySeverity[c.severity][verdict] += 1;
    }

    if (c?.cluster) {
      byCluster[c.cluster] ??= emptyVerdictCounts();
      if (verdict) byCluster[c.cluster][verdict] += 1;
    }

    const category = c?.rootCause?.category;
    if (category && category in byRootCause) byRootCause[category] += 1;

    if (c?.severity === 'critical' && isIntentCaptureOnly(c)) {
      intentCaptureOnlyCritical.push(caseLabel(c));
    }
  }

  return {
    total: cases.length,
    PASS: counts.PASS,
    PARTIAL: counts.PARTIAL,
    DEGRADED: counts.DEGRADED,
    FAIL: counts.FAIL,
    bySurface,
    bySeverity,
    byCluster,
    byRootCause,
    intentCaptureOnlyCritical,
  };
}

/**
 * Diff two runs (chronologically `prev` before `next`) by case key:
 *   - `flipped`   — cases present in both whose verdict changed at all
 *   - `fixed`     — flipped cases that became PASS
 *   - `regressed` — flipped cases that left PASS
 *   - `changed`   — flipped cases that moved between two non-PASS verdicts
 *   - `newRootCauses`   — cases whose rootCause.category is new or changed
 *   - `fixedRootCauses` — cases whose rootCause cleared (went to PASS)
 *   - `newCases` / `removedCases` — case keys present in only one run
 *     (register grew/shrank, or a batch run only covers a subset)
 *
 * `prev` may be `null` (no prior run) — everything in `next` then reports
 * as `newCases` and nothing else is computed.
 */
export function diffRuns(prev, next) {
  // Keyed by case AND surface (`caseLabel`): the same case can pass spoken and
  // regress typed, and collapsing the two would let one surface's PASS hide the
  // other's regression — the exact blind spot the chat surfaces were added to
  // close. A run whose cases carry no surface labels as the bare key, so a
  // voice-only history diffs exactly as it did before.
  const prevByKey = new Map((prev?.cases ?? []).map((c) => [caseLabel(c), c]));
  const nextByKey = new Map((next?.cases ?? []).map((c) => [caseLabel(c), c]));

  const flipped = [];
  const fixed = [];
  const regressed = [];
  const changed = [];
  const newRootCauses = [];
  const fixedRootCauses = [];

  for (const [key, nextCase] of nextByKey) {
    const prevCase = prevByKey.get(key);
    if (!prevCase) continue;

    if (prevCase.verdict !== nextCase.verdict) {
      const entry = {
        key,
        prevVerdict: prevCase.verdict,
        nextVerdict: nextCase.verdict,
        prevRootCause: prevCase.rootCause ?? null,
        nextRootCause: nextCase.rootCause ?? null,
      };
      flipped.push(entry);
      if (nextCase.verdict === 'PASS' && prevCase.verdict !== 'PASS') fixed.push(entry);
      else if (prevCase.verdict === 'PASS' && nextCase.verdict !== 'PASS') regressed.push(entry);
      else changed.push(entry);
    }

    const prevCategory = prevCase.rootCause?.category ?? null;
    const nextCategory = nextCase.rootCause?.category ?? null;
    if (nextCategory && nextCategory !== prevCategory) {
      newRootCauses.push({ key, rootCause: nextCase.rootCause });
    }
    if (prevCategory && !nextCategory) {
      fixedRootCauses.push({ key, prevRootCause: prevCase.rootCause });
    }
  }

  const newCases = [...nextByKey.keys()].filter((k) => !prevByKey.has(k));
  const removedCases = [...prevByKey.keys()].filter((k) => !nextByKey.has(k));

  return { flipped, fixed, regressed, changed, newRootCauses, fixedRootCauses, newCases, removedCases };
}

/**
 * The three release-gate rules from the plan, evaluated against a
 * RECOMPUTED summary (never `run.summary`):
 *
 *   1. `PASS === 50` ON EVERY SURFACE THE RUN COVERS (or `register.cases.length`
 *      if a register is given and its size differs, minus the cases the
 *      register skips on that surface — a case entirely missing from
 *      `run.cases` also fails this rule, distinctly from a case that ran and
 *      got a non-PASS verdict).
 *
 *      Per surface, not in aggregate: voice and chat are two different entry
 *      points into the same pipeline, and a run that is 50/50 spoken and 31/50
 *      typed is not "81/100, nearly there" — it is a product half of whose
 *      operators are broken. A run with no `surface` field on its cases (every
 *      artifact written before the chat surfaces existed) reads as voice-only
 *      and is judged exactly as it was.
 *   2. Zero CRITICAL cases in cluster scheduling/search/confirmations whose
 *      furthest stage is `intent_capture_only` (see isIntentCaptureOnly).
 *   3. Zero FAIL verdicts, at any severity.
 *
 * `register` is optional (defaults to expecting exactly 50 cases with no
 * cross-check against case metadata) so the function stays testable with
 * bare synthetic runs; pass the loaded
 * `fixtures/voice/inapp-50-cases.json` in real usage so rule 1 also
 * catches cases the run silently dropped, and so rule 2 uses the
 * register's cluster/severity as ground truth rather than trusting the
 * run's own copy of those fields.
 */
export function gateVerdict(run, register) {
  const summary = summarize(run);
  const runCases = Array.isArray(run?.cases) ? run.cases : [];
  const registerCases = Array.isArray(register?.cases) ? register.cases : [];
  const registerByKey = new Map(registerCases.map((c) => [c.key, c]));
  // Keyed by case AND surface — the same identity `latest.json` merges on.
  const runByKey = new Map(runCases.map((c) => [`${c.key}@${caseSurface(c)}`, c]));

  const reasons = [];

  // Rule 1 — per surface: PASS === that surface's expected count, and nothing
  // the register owes that surface is simply absent from the run.
  const surfacesInRun = SURFACES.filter((s) => runCases.some((c) => caseSurface(c) === s));
  const orderedSurfaces = surfacesInRun.length > 0 ? surfacesInRun : ['voice'];
  for (const surface of orderedSurfaces) {
    const tally = summary.bySurface[surface] ?? { ...emptyVerdictCounts(), total: 0 };
    const expected = expectedCaseCount(register, surface);
    const owed =
      surface === 'voice'
        ? registerCases
        : registerCases.filter((c) => !c?.chat?.skip);
    const missingKeys = owed
      .map((c) => c.key)
      .filter((k) => !runByKey.has(`${k}@${surface}`));
    if (tally.PASS !== expected || missingKeys.length > 0) {
      reasons.push(`${surface}: PASS ${tally.PASS}/${expected}`);
      if (missingKeys.length > 0) {
        reasons.push(`${surface}: missing from run: ${missingKeys.join(', ')}`);
      }
    }
  }

  // Rule 2 — zero critical scheduling/search/confirmations intent_capture_only.
  // Cluster/severity come from the register when available (do not trust
  // the run's own copy of case metadata), falling back to the run's fields
  // for register-less callers/tests. Labels are `key` or `key@surface`, so the
  // register lookup uses the key half.
  const gatedIntentCaptureOnly = summary.intentCaptureOnlyCritical.filter((label) => {
    const key = String(label).split('@')[0];
    const cluster = registerByKey.get(key)?.cluster ?? runByKey.get(String(label))?.cluster;
    return GATED_CLUSTERS.includes(cluster);
  });
  if (gatedIntentCaptureOnly.length > 0) {
    reasons.push(`critical intent_capture_only in ${GATED_CLUSTERS.join('/')}: ${gatedIntentCaptureOnly.join(', ')}`);
  }

  // Rule 3 — zero FAIL, any severity, any surface.
  const failKeys = runCases.filter((c) => c.verdict === 'FAIL').map((c) => caseLabel(c));
  if (failKeys.length > 0) {
    reasons.push(`FAIL: ${failKeys.join(', ')}`);
  }

  return { pass: reasons.length === 0, reasons, summary };
}
