import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFailureTaxonomy,
  buildRegisterCaseRow,
  classifyVoiceFailureBucket,
  isRegisterProbeCase,
  loadProbeCases,
  probeCasesMeta,
  renderRegisterSummaryMarkdown,
  resolveProbeDisambiguationFollowUp,
  runVoiceSessionProbe,
  scoreRegisterCase,
  scoreVoice,
  summarizeRegisterRun,
} from '../probe-operator-voice-50-live.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const V2_CASES = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v2-cases.json');
const V3_CASES = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v3-cases.json');
const V4_CASES = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v4-cases.json');
const V5_CASES = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v5-cases.json');
const V6_CASES = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v6-cases.json');
const LEGACY = path.join(
  ROOT,
  'docs/verification-runs/operator-voice-50-live-2026-07-20.results.json',
);
const INAPP_50_CASES = path.join(ROOT, 'fixtures/voice/inapp-50-cases.json');

test('loadProbeCases accepts v2 cases[] corpus', () => {
  const source = JSON.parse(fs.readFileSync(V2_CASES, 'utf8'));
  const cases = loadProbeCases(source);
  assert.equal(cases.length, 50);
  assert.equal(cases[0].id, 1);
  assert.equal(cases[0].utterance.includes('Sofia Chen'), true);
  assert.deepEqual(cases[0].fixtureRefs, []);
  assert.equal(cases[3].fixtureRefs?.[0], 'customer.khan');
  const meta = probeCasesMeta(source, V2_CASES);
  assert.equal(meta.version, 'v2');
});

test('loadProbeCases accepts legacy results[] artifact', () => {
  const source = JSON.parse(fs.readFileSync(LEGACY, 'utf8'));
  const cases = loadProbeCases(source);
  assert.equal(cases.length, 50);
  assert.equal(cases[0].utterance.includes('Maria Alvarez'), true);
  assert.equal(cases[0].fixtureRefs, undefined);
});

test('v2 utterances are all distinct from the 2026-07-20 baseline', () => {
  const v2 = loadProbeCases(JSON.parse(fs.readFileSync(V2_CASES, 'utf8')));
  const v1 = loadProbeCases(JSON.parse(fs.readFileSync(LEGACY, 'utf8')));
  const v1Set = new Set(v1.map((c) => c.utterance.trim().toLowerCase()));
  for (const row of v2) {
    assert.equal(
      v1Set.has(row.utterance.trim().toLowerCase()),
      false,
      `v2 case #${row.id} duplicates v1 utterance`,
    );
  }
});

test('v3 utterances are distinct from v1 and v2', () => {
  const v3 = loadProbeCases(JSON.parse(fs.readFileSync(V3_CASES, 'utf8')));
  const prior = new Set([
    ...loadProbeCases(JSON.parse(fs.readFileSync(LEGACY, 'utf8'))).map((c) =>
      c.utterance.trim().toLowerCase(),
    ),
    ...loadProbeCases(JSON.parse(fs.readFileSync(V2_CASES, 'utf8'))).map((c) =>
      c.utterance.trim().toLowerCase(),
    ),
  ]);
  for (const row of v3) {
    assert.equal(
      prior.has(row.utterance.trim().toLowerCase()),
      false,
      `v3 case #${row.id} duplicates a prior corpus utterance`,
    );
  }
  assert.equal(probeCasesMeta(JSON.parse(fs.readFileSync(V3_CASES, 'utf8')), V3_CASES).version, 'v3');
});

function loadAllPriorUtterances(extraPaths = []) {
  const paths = [LEGACY, V2_CASES, V3_CASES, ...extraPaths];
  const prior = new Set();
  for (const casesPath of paths) {
    if (!fs.existsSync(casesPath)) continue;
    for (const row of loadProbeCases(JSON.parse(fs.readFileSync(casesPath, 'utf8')))) {
      prior.add(row.utterance.trim().toLowerCase());
    }
  }
  return prior;
}

for (const [version, casesPath] of [
  ['v4', V4_CASES],
  ['v5', V5_CASES],
  ['v6', V6_CASES],
]) {
  test(`${version} utterances are distinct from all prior corpora`, () => {
    const priorPaths =
      version === 'v4'
        ? []
        : version === 'v5'
          ? [V4_CASES]
          : [V4_CASES, V5_CASES];
    const prior = loadAllPriorUtterances(priorPaths);
    const rows = loadProbeCases(JSON.parse(fs.readFileSync(casesPath, 'utf8')));
    assert.equal(rows.length, 50);
    for (const row of rows) {
      assert.equal(
        prior.has(row.utterance.trim().toLowerCase()),
        false,
        `${version} case #${row.id} duplicates a prior corpus utterance`,
      );
      prior.add(row.utterance.trim().toLowerCase());
    }
    assert.equal(probeCasesMeta(JSON.parse(fs.readFileSync(casesPath, 'utf8')), casesPath).version, version);
  });
}

test('scores an audited emergency on-call dispatch without a proposal', () => {
  const result = scoreVoice(
    {
      state: 'escalating',
      proposalIds: [],
      sideEffects: [
        { type: 'audit_log', payload: { eventType: 'emergency_dispatch', score: 1 } },
        { type: 'notify_oncall', payload: { rotationId: 'rotation-1' } },
      ],
    },
    200,
  );

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.reason, 'voice_emergency_oncall');
  assert.deepEqual(result.emergencyEvidence, {
    auditEventType: 'emergency_dispatch',
    onCallNotified: true,
  });
});

test('keeps provider failures distinct from low-confidence reprompts', () => {
  const result = scoreVoice(
    {
      state: 'intent_capture',
      sideEffects: [
        { type: 'audit_log', payload: { eventType: 'classifier_provider_failure', score: 0 } },
      ],
    },
    200,
  );

  assert.equal(result.verdict, 'DEGRADED');
  assert.equal(result.reason, 'voice_classifier_provider');
});

test('scores semantic low confidence as a reprompt', () => {
  const result = scoreVoice(
    {
      state: 'intent_capture',
      sideEffects: [{ type: 'audit_log', payload: { eventType: 'reprompt', score: 0 } }],
    },
    200,
  );

  assert.equal(result.verdict, 'DEGRADED');
  assert.equal(result.reason, 'voice_reprompt_low_confidence');
});

test('resolveProbeDisambiguationFollowUp defaults ambiguous-name cases to 104 Cedar', () => {
  assert.equal(
    resolveProbeDisambiguationFollowUp({ tags: ['ambiguous-name'] }),
    '104 Cedar',
  );
  assert.equal(
    resolveProbeDisambiguationFollowUp({
      tags: ['ambiguous-name'],
      disambiguationFollowUp: '105 QA Cedar Avenue',
    }),
    '105 QA Cedar Avenue',
  );
  assert.equal(resolveProbeDisambiguationFollowUp({ tags: [] }), null);
});

test('runVoiceSessionProbe sends disambiguation then confirmation turns', async () => {
  const calls = [];
  const apiFn = async (method, path, { body }) => {
    calls.push({ method, path, body });
    if (body.text === '104 Cedar') {
      return { status: 200, json: { state: 'intent_confirm', proposalIds: [] } };
    }
    return { status: 200, json: { state: 'closing', proposalIds: ['p1'] } };
  };

  const firstTurn = { status: 200, json: { state: 'entity_resolution', proposalIds: [] } };
  const result = await runVoiceSessionProbe(apiFn, 'token', 'sess-1', {
    tags: ['ambiguous-name'],
  }, firstTurn);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.text, '104 Cedar');
  assert.equal(calls[1].body.text, 'yes');
  assert.equal(result.finalVoiceTurn.json.proposalIds[0], 'p1');
});

test('classifyVoiceFailureBucket tags classifier_provider as infra A', () => {
  const voice = scoreVoice(
    {
      state: 'intent_capture',
      proposalIds: [],
      sideEffects: [
        {
          type: 'audit_log',
          payload: {
            eventType: 'classifier_provider_failure',
            failureClass: 'provider',
            errorCode: 'LLM_PROVIDER_UNAVAILABLE',
          },
        },
      ],
    },
    200,
  );
  const bucket = classifyVoiceFailureBucket(voice);
  assert.equal(bucket.bucket, 'A');
  assert.equal(bucket.errorCode, 'LLM_PROVIDER_UNAVAILABLE');
});

test('classifyVoiceFailureBucket tags voice_no_proposal as product B', () => {
  const voice = {
    verdict: 'PARTIAL',
    reason: 'voice_no_proposal',
    rawSideEffects: [
      { type: 'audit_log', payload: { eventType: 'agent.calling.intent_capture.intent_classified' } },
    ],
  };
  const bucket = classifyVoiceFailureBucket(voice);
  assert.equal(bucket.bucket, 'B');
});

test('classifyVoiceFailureBucket returns null for PASS', () => {
  assert.equal(
    classifyVoiceFailureBucket({ verdict: 'PASS', reason: 'voice_proposal' }),
    null,
  );
});

test('buildFailureTaxonomy counts A and B', () => {
  const taxonomy = buildFailureTaxonomy([
    {
      id: 1,
      op: 'create_client',
      voice: {
        verdict: 'DEGRADED',
        reason: 'voice_classifier_provider',
        rawSideEffects: [
          {
            type: 'audit_log',
            payload: {
              eventType: 'classifier_provider_failure',
              errorCode: 'LLM_PROVIDER_UNAVAILABLE',
            },
          },
        ],
      },
    },
    {
      id: 2,
      op: 'lookup',
      voice: { verdict: 'PARTIAL', reason: 'voice_no_proposal', rawSideEffects: [] },
    },
    { id: 3, op: 'ok', voice: { verdict: 'PASS', reason: 'voice_proposal' } },
  ]);
  assert.equal(taxonomy.A, 1);
  assert.equal(taxonomy.B, 1);
  assert.equal(taxonomy.cases.length, 2);
});

// ── Register loading (fixtures/voice/inapp-50-cases.json) ──────────────────

test('loadProbeCases preserves register-only fields for the inapp-50 register', () => {
  const source = JSON.parse(fs.readFileSync(INAPP_50_CASES, 'utf8'));
  const cases = loadProbeCases(source);
  assert.equal(cases.length, 50);

  const book01 = cases.find((c) => c.key === 'book-01');
  assert.ok(book01);
  assert.equal(book01.cluster, 'scheduling');
  assert.equal(book01.severity, 'critical');
  assert.equal(book01.intent, 'create_appointment');
  assert.equal(book01.expect.outcome, 'proposal');
  assert.equal(isRegisterProbeCase(book01), true);

  const book05 = cases.find((c) => c.key === 'book-05');
  assert.deepEqual(book05.turns, [
    'Book a service visit',
    "It's for Khan, Tuesday at 2 pm, condenser install",
  ]);

  const conf01 = cases.find((c) => c.key === 'conf-01');
  assert.equal(conf01.autoConfirm, false);
});

test('loadProbeCases leaves v3 legacy cases with no register fields', () => {
  const v3 = loadProbeCases(JSON.parse(fs.readFileSync(V3_CASES, 'utf8')));
  for (const c of v3) {
    assert.equal(isRegisterProbeCase(c), false);
    assert.equal('turns' in c, false);
    assert.equal('autoConfirm' in c, false);
    assert.equal('expect' in c, false);
  }
});

// ── runVoiceSessionProbe — register-aware driving ───────────────────────────

function makeApiFn(script) {
  // `script` maps sent text -> the turn response to return. Falls back to a
  // terminal `closing` turn with no proposal for anything unscripted.
  const calls = [];
  const apiFn = async (method, p, { body }) => {
    calls.push({ method, path: p, body });
    const scripted = script[body.text];
    if (scripted) return scripted;
    return { status: 200, json: { state: 'closing', proposalIds: [], sideEffects: [] } };
  };
  return { apiFn, calls };
}

test('runVoiceSessionProbe sends remaining scripted turns, then auto-confirms', async () => {
  const probeCase = {
    key: 'book-05',
    turns: ['Book a service visit', "It's for Khan, Tuesday at 2 pm, condenser install"],
    expect: { outcome: 'proposal' },
  };
  const firstTurn = { status: 200, json: { state: 'intent_capture', proposalIds: [], sideEffects: [] } };
  const { apiFn, calls } = makeApiFn({
    "It's for Khan, Tuesday at 2 pm, condenser install": {
      status: 200,
      json: { state: 'intent_confirm', proposalIds: [], sideEffects: [] },
    },
    yes: {
      status: 200,
      json: { state: 'closing', proposalIds: ['p1'], sideEffects: [] },
    },
  });

  const result = await runVoiceSessionProbe(apiFn, 'token', 'sess-1', probeCase, firstTurn);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.text, "It's for Khan, Tuesday at 2 pm, condenser install");
  assert.equal(calls[1].body.text, 'yes');
  assert.equal(result.turns.length, 3);
  assert.equal(result.turns[0].text, 'Book a service visit');
  assert.equal(result.finalVoiceTurn.json.proposalIds[0], 'p1');
});

test('runVoiceSessionProbe with autoConfirm:false sends only the scripted turns', async () => {
  const probeCase = {
    key: 'conf-01',
    turns: ['Book Garcia for Tuesday at 2 pm for the HVAC install', 'uh yeah, go ahead'],
    autoConfirm: false,
    expect: { outcome: 'proposal' },
  };
  const firstTurn = { status: 200, json: { state: 'intent_confirm', proposalIds: [], sideEffects: [] } };
  const { apiFn, calls } = makeApiFn({
    'uh yeah, go ahead': {
      status: 200,
      json: { state: 'closing', proposalIds: ['p1'], sideEffects: [] },
    },
  });

  const result = await runVoiceSessionProbe(apiFn, 'token', 'sess-1', probeCase, firstTurn);

  // Only the one scripted follow-up turn — no auto "yes" appended even
  // though the scripted turn's response state came back at intent_confirm's
  // sibling / terminal state.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, 'uh yeah, go ahead');
  assert.equal(result.turns.length, 2);
  assert.equal(result.voiceConfirmationTurn, undefined);
});

test('runVoiceSessionProbe auto-confirms through entity_confirm then intent_confirm', async () => {
  const probeCase = { key: 'book-x', expect: { outcome: 'proposal' } };
  const firstTurn = { status: 200, json: { state: 'entity_confirm', proposalIds: [], sideEffects: [] } };
  const { apiFn, calls } = makeApiFn({});
  let call = 0;
  const scriptedApiFn = async (method, p, opts) => {
    call += 1;
    calls.push(opts.body);
    if (call === 1) return { status: 200, json: { state: 'intent_confirm', proposalIds: [], sideEffects: [] } };
    return { status: 200, json: { state: 'closing', proposalIds: ['p9'], sideEffects: [] } };
  };

  const result = await runVoiceSessionProbe(scriptedApiFn, 'token', 'sess-1', probeCase, firstTurn);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, 'yes');
  assert.equal(calls[1].text, 'yes');
  assert.equal(result.finalVoiceTurn.json.proposalIds[0], 'p9');
});

test('runVoiceSessionProbe caps total turns at 6', async () => {
  const probeCase = {
    key: 'noise-loop',
    turns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    expect: { outcome: 'proposal' },
  };
  const firstTurn = { status: 200, json: { state: 'intent_capture', proposalIds: [], sideEffects: [] } };
  const apiFn = async () => ({ status: 200, json: { state: 'intent_capture', proposalIds: [], sideEffects: [] } });

  const result = await runVoiceSessionProbe(apiFn, 'token', 'sess-1', probeCase, firstTurn);

  assert.equal(result.turns.length, 6);
});

test('v3 legacy case still drives and scores through scoreVoice identically', async () => {
  const v3 = loadProbeCases(JSON.parse(fs.readFileSync(V3_CASES, 'utf8')));
  const probeCase = v3[0];
  assert.equal(isRegisterProbeCase(probeCase), false);

  const firstTurn = {
    status: 200,
    json: { state: 'closing', proposalIds: ['p1'], sideEffects: [] },
  };
  const apiFn = async () => {
    throw new Error('should never be called — nothing to disambiguate or confirm');
  };

  const result = await runVoiceSessionProbe(apiFn, 'token', 'sess-1', probeCase, firstTurn);
  assert.equal(result.finalVoiceTurn, firstTurn);
  assert.deepEqual(result.turns, [firstTurn]);

  const viaHelper = scoreVoice(result.finalVoiceTurn.json, result.finalVoiceTurn.status);
  const viaDirect = scoreVoice(firstTurn.json, firstTurn.status);
  assert.deepEqual(viaHelper, viaDirect);
  assert.equal(viaHelper.verdict, 'PASS');
});

// ── scoreRegisterCase — per-outcome PASS / non-PASS ─────────────────────────

function turn(state, { proposalIds = [], sideEffects = [], ttsText, status = 200, trace } = {}) {
  return { status, json: { state, proposalIds, sideEffects, ttsText, trace } };
}

function auditFx(eventType, payload = {}) {
  return { type: 'audit_log', payload: { eventType, ...payload } };
}

test('scoreRegisterCase: proposal outcome PASS and non-PASS', () => {
  const probeCase = {
    key: 'book-01',
    expect: { outcome: 'proposal', proposalCount: 1 },
  };
  const pass = scoreRegisterCase(probeCase, [
    turn('intent_confirm'),
    turn('closing', { proposalIds: ['p1'], sideEffects: [auditFx('proposal_draft.proposal_queued')] }),
  ]);
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.stage, 'committed');
  assert.deepEqual(pass.proposals, [{ id: 'p1' }]);

  const fail = scoreRegisterCase(probeCase, [turn('intent_capture')]);
  assert.equal(fail.verdict, 'PARTIAL');
  assert.ok(fail.failures.includes('no proposal was created'));
});

test('scoreRegisterCase: lookup_answer outcome PASS and non-PASS', () => {
  const probeCase = {
    key: 'search-01',
    intent: 'lookup_day_overview',
    expect: { outcome: 'lookup_answer', proposalCount: 0, spokenMatches: 'appointment|nothing scheduled' },
  };
  const pass = scoreRegisterCase(probeCase, [
    turn('intent_capture', {
      ttsText: 'You have 2 appointments today.',
      sideEffects: [{ type: 'tts_play', payload: { text: 'You have 2 appointments today.' } }],
    }),
  ]);
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.stage, 'answered');
  assert.equal(pass.intentCaptureOnly, false);

  const fail = scoreRegisterCase(probeCase, [
    turn('intent_capture', { ttsText: 'I am not sure what you mean.' }),
  ]);
  assert.equal(fail.verdict, 'PARTIAL');
  assert.ok(fail.failures.some((f) => f.includes('spoken line did not match')));
});

test('scoreRegisterCase: clarification_question outcome PASS and non-PASS', () => {
  const probeCase = {
    key: 'search-08',
    expect: { outcome: 'clarification_question', proposalCount: 0, spokenMatches: 'which one' },
  };
  const pass = scoreRegisterCase(probeCase, [
    turn('intent_capture', {
      ttsText: 'There is more than one Smith — which one did you mean?',
      sideEffects: [{ type: 'tts_play', payload: { text: 'There is more than one Smith — which one did you mean?' } }],
    }),
  ]);
  assert.equal(pass.verdict, 'PASS');

  const fail = scoreRegisterCase(probeCase, [turn('intent_capture', { ttsText: 'Smith owes $400.' })]);
  assert.equal(fail.verdict, 'PARTIAL');
  assert.ok(fail.failures.includes('no which-one clarification was asked'));
});

test('scoreRegisterCase: not_found outcome PASS and non-PASS', () => {
  const probeCase = {
    key: 'cancel-02',
    expect: { outcome: 'not_found', proposalCount: 0 },
  };
  const pass = scoreRegisterCase(probeCase, [turn('intent_capture', { ttsText: "I couldn't find that." })]);
  assert.equal(pass.verdict, 'PASS');

  const fail = scoreRegisterCase(probeCase, [turn('closing', { proposalIds: ['p1'] })]);
  assert.equal(fail.verdict, 'PARTIAL');
  assert.ok(fail.failures.includes('a proposal was minted for a not-found reference'));
});

test('scoreRegisterCase: guard outcome PASS and non-PASS', () => {
  const probeCase = {
    key: 'noise-02',
    expect: { outcome: 'guard', proposalCount: 0, allowedStates: ['intent_capture'] },
  };
  const pass = scoreRegisterCase(probeCase, [
    turn('intent_capture', { sideEffects: [auditFx('agent.calling.intent_capture.confirm_without_pending')] }),
  ]);
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.stage, 'guarded');

  const fail = scoreRegisterCase(probeCase, [turn('intent_capture')]);
  assert.equal(fail.verdict, 'PARTIAL');
  assert.ok(fail.failures.includes('no guard fired'));
});

test('scoreRegisterCase: direct_act outcome PASS and non-PASS, forbidProposalTypes via trace', () => {
  const probeCase = {
    key: 'dispatch-03',
    expect: {
      outcome: 'direct_act',
      proposalCount: 0,
      requireAuditEvents: ['appointment.en_route_triggered'],
      forbidProposalTypes: ['voice_clarification'],
    },
  };
  const pass = scoreRegisterCase(probeCase, [
    turn('intent_capture', { ttsText: 'Marked en route.', trace: { stage: 'answered' } }),
  ]);
  assert.equal(pass.verdict, 'PASS');
  assert.deepEqual(pass.unchecked, ['requireAuditEvents']);

  const fail = scoreRegisterCase(probeCase, [
    turn('intent_capture', {
      proposalIds: ['p1'],
      trace: { stage: 'proposal_created', proposalType: 'voice_clarification' },
    }),
  ]);
  assert.equal(fail.verdict, 'PARTIAL');
  assert.ok(fail.failures.includes('a proposal replaced the direct act'));
  assert.ok(fail.failures.some((f) => f.includes("forbidden proposal type 'voice_clarification'")));
});

test('scoreRegisterCase: escalation outcome PASS and non-PASS', () => {
  const probeCase = {
    key: 'dispatch-01',
    expect: {
      outcome: 'escalation',
      requireSideEffects: ['notify_oncall'],
      allowedStates: ['escalating', 'terminated'],
      spokenMatches: 'emergency|on-call',
    },
  };
  const pass = scoreRegisterCase(probeCase, [
    turn('escalating', {
      sideEffects: [{ type: 'notify_oncall', payload: {} }],
      ttsText: 'This is an emergency — paging on-call now.',
    }),
  ]);
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.stage, 'escalated');

  const fail = scoreRegisterCase(probeCase, [turn('intent_capture')]);
  assert.equal(fail.verdict, 'PARTIAL');
  assert.ok(fail.failures.includes('the case did not escalate'));
});

// ── scoreRegisterCase — infra precedence, unchecked, intentCaptureOnly ─────

test('scoreRegisterCase: an infra classifier failure wins over an otherwise-PASS expectation', () => {
  const probeCase = { key: 'book-01', expect: { outcome: 'proposal' } };
  const score = scoreRegisterCase(probeCase, [
    turn('intent_capture', { sideEffects: [auditFx('classifier_provider_failure')] }),
    turn('closing', { proposalIds: ['p1'] }),
  ]);
  assert.equal(score.verdict, 'DEGRADED');
  assert.equal(score.reason, 'voice_classifier_provider');
  assert.equal(score.rootCause.category, 'infra');
});

test('scoreRegisterCase: 401/403 and 5xx keep BLOCKED/FAIL and win over expectations', () => {
  const probeCase = { key: 'book-01', expect: { outcome: 'proposal' } };
  const blocked = scoreRegisterCase(probeCase, [turn('intent_capture', { status: 403 })]);
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.equal(blocked.reason, 'auth_403');

  const failed = scoreRegisterCase(probeCase, [
    turn('intent_capture'),
    turn('intent_capture', { status: 500 }),
  ]);
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.reason, 'http_500');
});

test('scoreRegisterCase: fields the live route cannot answer are reported as unchecked, not silently passed', () => {
  const probeCase = {
    key: 'book-01',
    expect: {
      outcome: 'proposal',
      status: 'ready_for_review',
      payloadContains: { customerId: 'customer.garcia' },
      payloadHas: ['scheduledStart'],
      missingFieldsContains: ['customerId'],
      scheduledStartWeekday: 4,
      requireAuditEvents: ['agent.calling.proposal_draft.proposal_queued'],
    },
  };
  const score = scoreRegisterCase(probeCase, [turn('closing', { proposalIds: ['p1'] })]);
  assert.equal(score.verdict, 'PASS');
  assert.deepEqual(
    [...score.unchecked].sort(),
    [
      'missingFieldsContains',
      'payloadContains',
      'payloadHas',
      'requireAuditEvents',
      'scheduledStartWeekday',
      'status',
    ].sort(),
  );
});

test('scoreRegisterCase: forbidProposalTypes is unchecked when no turn carries a trace', () => {
  const probeCase = {
    key: 'dispatch-03',
    expect: { outcome: 'direct_act', proposalCount: 0, forbidProposalTypes: ['voice_clarification'] },
  };
  const score = scoreRegisterCase(probeCase, [turn('intent_capture')]);
  assert.equal(score.verdict, 'PASS');
  assert.ok(score.unchecked.includes('forbidProposalTypes'));
});

test('scoreRegisterCase: intentCaptureOnly true when intent is captured but nothing landed', () => {
  const probeCase = { key: 'book-01', intent: 'create_appointment', expect: { outcome: 'proposal' } };
  const score = scoreRegisterCase(probeCase, [
    turn('intent_capture', { sideEffects: [auditFx('agent.calling.intent_capture.intent_classified')] }),
  ]);
  assert.equal(score.stage, 'intent_detected');
  assert.equal(score.intentCaptureOnly, true);
});

// ── Register run summary — cases[] row, gate, markdown ──────────────────────

test('buildRegisterCaseRow + summarizeRegisterRun + renderRegisterSummaryMarkdown', () => {
  const register = JSON.parse(fs.readFileSync(INAPP_50_CASES, 'utf8'));
  const cases = loadProbeCases(register);
  const book01 = cases.find((c) => c.key === 'book-01');
  const search01 = cases.find((c) => c.key === 'search-01');

  const rows = [
    buildRegisterCaseRow(
      book01,
      scoreRegisterCase(book01, [
        turn('intent_confirm'),
        turn('closing', { proposalIds: ['p1'] }),
      ]),
    ),
    buildRegisterCaseRow(
      search01,
      scoreRegisterCase(search01, [turn('intent_capture', { ttsText: 'Nothing scheduled today.' })]),
    ),
  ];

  const gate = summarizeRegisterRun(rows, register);
  assert.equal(gate.summary.PASS, 2);
  // Only 2/50 register cases were actually run — rule 1 must fail and name
  // what's missing from the run, not silently report PASS 2/2.
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((r) => r.startsWith('PASS 2/50')));

  const md = renderRegisterSummaryMarkdown(gate, rows);
  assert.match(md, /Register — per cluster/);
  assert.match(md, /Register — per severity/);
  assert.match(md, /Gate:\*\* FAIL/);
});
