import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProbeCases,
  probeCasesMeta,
  scoreVoice,
} from '../probe-operator-voice-50-live.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const V2_CASES = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v2-cases.json');
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
