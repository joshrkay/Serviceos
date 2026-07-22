import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreAssistant, scoreVoice } from '../probe-operator-voice-50-live.mjs';

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

test('accepts read-only lookup assistant answers without a proposal', () => {
  const result = scoreAssistant(
    {
      message: { content: 'Smith owes $450 on invoice INV-0041.' },
      model: 'gpt-4o-mini-2024-07-18',
      taskType: 'assistant.lookup_balance',
    },
    200,
    null,
    true,
  );

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.reason, 'read_only_answer');
  assert.equal(result.proposalId, null);
});

test('still degrades read-only ops when the assistant envelope is fallback', () => {
  const result = scoreAssistant(
    {
      message: { content: 'fallback text' },
      degraded: true,
      fallbackStage: 'error-envelope',
      model: 'fallback',
    },
    200,
    null,
    true,
  );

  assert.equal(result.verdict, 'DEGRADED');
  assert.equal(result.reason, 'llm_fallback_envelope');
});
