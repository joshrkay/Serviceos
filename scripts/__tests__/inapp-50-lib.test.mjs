import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffRuns,
  gateVerdict,
  isIntentCaptureOnly,
  loadLatest,
  loadRuns,
  summarize,
} from '../inapp-50/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const REGISTER = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'fixtures/voice/inapp-50-cases.json'), 'utf8'),
);

function makeRun({
  runId = '2026-09-09T00-00-00Z',
  startedAt = '2026-09-09T00:00:00Z',
  mode = 'hermetic',
  gitSha = 'abc123',
  batch = null,
  cases,
}) {
  return {
    version: 'inapp-50-run-v1',
    runId,
    mode,
    registerVersion: REGISTER.version,
    gitSha,
    startedAt,
    finishedAt: startedAt,
    batch,
    // Deliberately a lie some tests below corrupt further — summarize()
    // must never read this field.
    summary: { total: 50, PASS: 50, PARTIAL: 0, DEGRADED: 0, FAIL: 0 },
    cases,
  };
}

function passingCase(regCase, overrides = {}) {
  const isLookup = regCase.op?.startsWith('lookup') || regCase.cluster === 'search';
  return {
    id: regCase.id,
    key: regCase.key,
    cluster: regCase.cluster,
    severity: regCase.severity,
    op: regCase.op,
    intent: regCase.intent,
    verdict: 'PASS',
    reason: isLookup ? 'answered' : `proposal:${regCase.expectProposal ?? regCase.op}`,
    stage: isLookup ? 'answered' : 'committed',
    rootCause: null,
    turns: [],
    proposals: isLookup
      ? []
      : [
          {
            id: `${regCase.key}-p1`,
            proposalType: regCase.expectProposal ?? regCase.op,
            status: 'ready_for_review',
            missingFields: [],
            payload: {},
          },
        ],
    durationMs: 5,
    ...overrides,
  };
}

function buildFullPassingRun(overrides = {}) {
  const cases = REGISTER.cases.map((c) => passingCase(c));
  return makeRun({ cases, ...overrides });
}

// ---- summarize() -----------------------------------------------------

test('summarize recomputes counts from cases[] and ignores a stale summary block', () => {
  const run = buildFullPassingRun();
  run.cases[0] = {
    ...run.cases[0],
    verdict: 'FAIL',
    rootCause: { category: 'fallback', detail: 'boom' },
  };
  // run.summary (from makeRun) still says PASS: 50 — summarize must not trust it.
  const summary = summarize(run);
  assert.equal(summary.total, 50);
  assert.equal(summary.PASS, 49);
  assert.equal(summary.FAIL, 1);
  assert.equal(summary.byRootCause.fallback, 1);
});

test('summarize buckets by severity and cluster to match the register', () => {
  const run = buildFullPassingRun();
  const summary = summarize(run);
  const criticalTotal = REGISTER.cases.filter((c) => c.severity === 'critical').length;
  assert.equal(summary.bySeverity.critical.PASS, criticalTotal);
  const schedulingTotal = REGISTER.cases.filter((c) => c.cluster === 'scheduling').length;
  assert.equal(summary.byCluster.scheduling.PASS, schedulingTotal);
  assert.equal(summary.intentCaptureOnlyCritical.length, 0);
});

// ---- isIntentCaptureOnly() --------------------------------------------

test('isIntentCaptureOnly is true only for capture-stage + zero proposals + not answered', () => {
  assert.equal(isIntentCaptureOnly({ stage: 'intent_detected', proposals: [] }), true);
  assert.equal(isIntentCaptureOnly({ stage: 'clarification_asked', proposals: [] }), true);
  assert.equal(isIntentCaptureOnly({ stage: 'confirmation_asked', proposals: [] }), true);
  assert.equal(isIntentCaptureOnly({ stage: 'intent_detected', proposals: [{ id: 'p1' }] }), false);
  assert.equal(isIntentCaptureOnly({ stage: 'answered', proposals: [] }), false);
  assert.equal(isIntentCaptureOnly({ stage: 'committed', proposals: [{ id: 'p1' }] }), false);
  assert.equal(isIntentCaptureOnly({ stage: 'entities_resolved', proposals: [] }), false);
});

// ---- gateVerdict() -----------------------------------------------------

test('gateVerdict PASSes a full 50/50 run with no FAILs and no intent-capture-only criticals', () => {
  const run = buildFullPassingRun();
  const verdict = gateVerdict(run, REGISTER);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.summary.PASS, 50);
});

test('gateVerdict fails on a critical search case that ends intent_capture_only', () => {
  const run = buildFullPassingRun();
  const target = run.cases.find((c) => c.cluster === 'search' && c.severity === 'critical');
  assert.ok(target, 'fixture register must have a critical search case');
  target.verdict = 'PARTIAL';
  target.stage = 'intent_detected';
  target.proposals = [];
  target.rootCause = { category: 'fallback', detail: 'lookup fell through to a dead clarification card' };

  const verdict = gateVerdict(run, REGISTER);
  assert.equal(verdict.pass, false);
  assert.ok(
    verdict.reasons.some((r) => r.includes('critical intent_capture_only') && r.includes(target.key)),
    `expected a critical intent_capture_only reason mentioning ${target.key}, got: ${verdict.reasons.join(' | ')}`,
  );
});

test('a critical intent_capture_only case OUTSIDE scheduling/search/confirmations does not trip rule 2', () => {
  const run = buildFullPassingRun();
  const target = run.cases.find((c) => !['scheduling', 'search', 'confirmations'].includes(c.cluster));
  assert.ok(target, 'fixture register must have a case outside the gated clusters');
  target.severity = 'critical'; // force critical to isolate the cluster check
  target.verdict = 'PARTIAL';
  target.stage = 'intent_detected';
  target.proposals = [];

  const verdict = gateVerdict(run, REGISTER);
  // Rule 1 still fails (this case is no longer PASS), but rule 2's specific
  // reason must not fire for an ungated cluster.
  assert.equal(verdict.pass, false);
  assert.equal(
    verdict.reasons.some((r) => r.startsWith('critical intent_capture_only')),
    false,
  );
});

test('gateVerdict fails on any FAIL verdict, regardless of severity', () => {
  const run = buildFullPassingRun();
  const growthCase = run.cases.find((c) => c.severity === 'growth');
  assert.ok(growthCase, 'fixture register must have a growth-severity case');
  growthCase.verdict = 'FAIL';
  growthCase.rootCause = { category: 'proposal_generation', detail: 'voice proposal contract violation' };

  const verdict = gateVerdict(run, REGISTER);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reasons.some((r) => r.startsWith('FAIL:') && r.includes(growthCase.key)));
});

test('gateVerdict flags a case missing from the run entirely, not just a non-PASS verdict', () => {
  const run = buildFullPassingRun();
  run.cases = run.cases.filter((c) => c.key !== 'book-01');

  const verdict = gateVerdict(run, REGISTER);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.summary.PASS, 49);
  assert.ok(verdict.reasons.some((r) => r.includes('missing from run') && r.includes('book-01')));
});

test('gateVerdict passes when latest.json is a merge of five 10-case batches covering all 50 keys', () => {
  const batches = [];
  for (let i = 0; i < 5; i += 1) {
    batches.push(REGISTER.cases.slice(i * 10, i * 10 + 10).map((c) => passingCase(c)));
  }
  const merged = makeRun({
    runId: 'merged-latest',
    startedAt: '2026-09-09T01:00:00Z',
    batch: null,
    cases: batches.flat(),
  });
  assert.equal(merged.cases.length, 50);

  const verdict = gateVerdict(merged, REGISTER);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.summary.PASS, 50);
});

// ---- surfaces ------------------------------------------------------------
//
// A run now covers three ENTRY POINTS — the live-voice FSM, and the assistant
// route typed and by mic. They are scored separately on purpose: a run that is
// 50/50 spoken and 31/50 typed is not "81/100, nearly there", it is a product
// half of whose operators are broken.

function surfaced(cases, surface) {
  return cases.map((c) => ({ ...c, surface }));
}

test('summarize buckets by surface and labels a chat case key@surface', () => {
  const voice = buildFullPassingRun().cases;
  const chat = surfaced(voice, 'chat');
  const run = makeRun({ cases: [...surfaced(voice, 'voice'), ...chat] });
  const summary = summarize(run);

  assert.equal(summary.total, 100);
  assert.equal(summary.bySurface.voice.PASS, 50);
  assert.equal(summary.bySurface.chat.PASS, 50);
  assert.equal(summary.bySurface.chat.total, 50);
});

test('gateVerdict requires 50/50 on EVERY surface, not 100 in aggregate', () => {
  const base = buildFullPassingRun().cases;
  const voice = surfaced(base, 'voice');
  const chat = surfaced(base, 'chat');
  // Chat loses one case; voice is still perfect. Aggregate PASS is 99/100.
  chat[0] = { ...chat[0], verdict: 'PARTIAL', stage: 'proposal_created' };
  const run = makeRun({ cases: [...voice, ...chat] });

  const verdict = gateVerdict(run, REGISTER);
  assert.equal(verdict.pass, false);
  assert.ok(
    verdict.reasons.some((r) => r.startsWith('chat: PASS 49/50')),
    `expected a chat-specific PASS reason, got: ${verdict.reasons.join(' | ')}`,
  );
  assert.equal(
    verdict.reasons.some((r) => r.startsWith('voice:')),
    false,
    'the clean voice surface must not be blamed for the chat regression',
  );
});

test('gateVerdict flags a case missing on ONE surface only', () => {
  const base = buildFullPassingRun().cases;
  const run = makeRun({
    cases: [
      ...surfaced(base, 'voice'),
      ...surfaced(base, 'chat').filter((c) => c.key !== 'book-01'),
    ],
  });

  const verdict = gateVerdict(run, REGISTER);
  assert.equal(verdict.pass, false);
  assert.ok(
    verdict.reasons.some((r) => r.includes('chat: missing from run') && r.includes('book-01')),
  );
});

test('a run whose cases carry no surface is still judged exactly as a voice run', () => {
  const verdict = gateVerdict(buildFullPassingRun(), REGISTER);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.summary.bySurface.voice.PASS, 50);
});

test('the same case failing on two surfaces reports as two distinct findings', () => {
  const base = buildFullPassingRun().cases;
  const voice = surfaced(base, 'voice');
  const chat = surfaced(base, 'chat');
  const target = chat.find((c) => c.cluster === 'search' && c.severity === 'critical');
  target.verdict = 'PARTIAL';
  target.stage = 'intent_detected';
  target.proposals = [];

  const verdict = gateVerdict(makeRun({ cases: [...voice, ...chat] }), REGISTER);
  assert.ok(
    verdict.reasons.some(
      (r) => r.includes('critical intent_capture_only') && r.includes(`${target.key}@chat`),
    ),
    `expected the chat surface to be named, got: ${verdict.reasons.join(' | ')}`,
  );
});

// ---- diffRuns() ----------------------------------------------------------

test('diffRuns reports fixed, regressed, new cases, and root-cause churn', () => {
  const prev = buildFullPassingRun({ runId: 'run-1', startedAt: '2026-09-08T00:00:00Z' });
  const wasFailing = prev.cases.find((c) => c.cluster === 'invoices');
  wasFailing.verdict = 'FAIL';
  wasFailing.rootCause = { category: 'slot_capture', detail: 'missing invoiceId' };

  const next = buildFullPassingRun({ runId: 'run-2', startedAt: '2026-09-09T00:00:00Z' });
  const regressedCase = next.cases.find((c) => c.cluster === 'estimates');
  regressedCase.verdict = 'DEGRADED';
  regressedCase.rootCause = { category: 'fallback', detail: 'unexpected reprompt' };
  next.cases.push({ ...passingCase(REGISTER.cases[0]), key: 'brand-new-case' });

  const diff = diffRuns(prev, next);
  assert.deepEqual(diff.fixed.map((e) => e.key), [wasFailing.key]);
  assert.deepEqual(diff.regressed.map((e) => e.key), [regressedCase.key]);
  assert.deepEqual(diff.newCases, ['brand-new-case']);
  assert.deepEqual(diff.removedCases, []);
  assert.equal(
    diff.newRootCauses.some((e) => e.key === regressedCase.key && e.rootCause.category === 'fallback'),
    true,
  );
  assert.equal(diff.fixedRootCauses.some((e) => e.key === wasFailing.key), true);
});

test('diffRuns treats a null previous run as "everything is new" with no flips', () => {
  const next = buildFullPassingRun({ runId: 'run-1', startedAt: '2026-09-09T00:00:00Z' });
  const diff = diffRuns(null, next);
  assert.equal(diff.flipped.length, 0);
  assert.equal(diff.newCases.length, 50);
});

// ---- loadRuns() / loadLatest() -------------------------------------------

test('loadRuns sorts ascending by startedAt and flags batch runs; loadLatest reads latest.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inapp50-lib-'));
  try {
    const runEarly = buildFullPassingRun({ runId: 'run-early', startedAt: '2026-09-08T00:00:00Z' });
    const runLate = buildFullPassingRun({ runId: 'run-late', startedAt: '2026-09-09T00:00:00Z' });
    const runBatch = makeRun({
      runId: 'run-late-batch1',
      startedAt: '2026-09-09T00:30:00Z',
      batch: { index: 1, size: 10 },
      cases: REGISTER.cases.slice(0, 10).map((c) => passingCase(c)),
    });

    fs.writeFileSync(path.join(dir, 'run-2026-09-08T00-00-00Z.json'), JSON.stringify(runEarly));
    fs.writeFileSync(path.join(dir, 'run-2026-09-09T00-00-00Z.json'), JSON.stringify(runLate));
    fs.writeFileSync(path.join(dir, 'run-2026-09-09T00-30-00Z-batch1.json'), JSON.stringify(runBatch));
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(runLate));

    const runs = loadRuns(dir);
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((r) => r.run.runId),
      ['run-early', 'run-late', 'run-late-batch1'],
    );
    assert.deepEqual(
      runs.map((r) => r.isBatch),
      [false, false, true],
    );

    const latest = loadLatest(dir);
    assert.equal(latest.runId, 'run-late');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRuns / loadLatest return empty/null for a directory that does not exist yet', () => {
  const missing = path.join(os.tmpdir(), `inapp50-does-not-exist-${Date.now()}`);
  assert.deepEqual(loadRuns(missing), []);
  assert.equal(loadLatest(missing), null);
});
