import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as queryString from '../src/lib/queryStringCompat';

// This lane requires mobile's installed dependencies, unlike the root-only
// Vitest lane. Run it beside the Metro bundle check in mobile-typecheck.
test('Expo Router namespace serializes route parameters without reordering', () => {
  assert.equal(queryString.stringify({ name: 'A & B', job: '123' }, { sort: false }),
    'name=A%20%26%20B&job=123');
});

test('encoded route parameters and repeated values round-trip', () => {
  const params = { name: 'José / repair', tag: ['urgent', 'service'] };
  assert.deepEqual({ ...queryString.parse(queryString.stringify(params)) }, params);
});
