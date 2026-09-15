import test from 'node:test';
import assert from 'node:assert/strict';
import { requireReleaseCredentials, verifyReleaseResults } from './verification-policy.mjs';
const valid = { E2E_CLERK_PUBLISHABLE_KEY: 'pk_test_fixture', E2E_CLERK_SECRET_KEY: 'sk_test_fixture' };
test('release requires both Clerk development keys, without leaking values', () => {
  for (const key of Object.keys(valid)) {
    assert.throws(() => requireReleaseCredentials({ ...valid, [key]: '' }), new RegExp(key));
    assert.throws(() => requireReleaseCredentials({ ...valid, [key]: 'live-secret-do-not-print' }), e => e.message.includes(key) && !e.message.includes('live-secret'));
  }
  assert.doesNotThrow(() => requireReleaseCredentials(valid));
});
test('release cannot pass empty, skipped, failed, interrupted or flaky runs', () => {
  for (const stats of [ {}, { expected: 0 }, { expected: 1, skipped: 1 }, { expected: 1, unexpected: 1 }, { expected: 1, flaky: 1 } ]) {
    assert.throws(() => verifyReleaseResults(stats));
  }
  assert.doesNotThrow(() => verifyReleaseResults({ expected: 2, skipped: 0, unexpected: 0, flaky: 0 }));
});
