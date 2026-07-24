import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFailureTaxonomy,
  classifyVoiceFailureBucket,
  loadProbeCases,
  probeCasesMeta,
  resolveProbeDisambiguationFollowUp,
  runVoiceSessionProbe,
  scoreVoice,
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
