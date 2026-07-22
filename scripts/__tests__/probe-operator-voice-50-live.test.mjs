import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreVoice } from '../probe-operator-voice-50-live.mjs';

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
