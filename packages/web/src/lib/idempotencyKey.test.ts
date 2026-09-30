import { describe, it, expect } from 'vitest';
import { createSubmissionKeyer } from './idempotencyKey';

function counter(): () => string {
  let n = 0;
  return () => `key-${++n}`;
}

describe('createSubmissionKeyer (#1489)', () => {
  it('keeps one key while the same body is retried', () => {
    const keyer = createSubmissionKeyer(counter());
    expect(keyer.keyFor({ firstName: 'Grace' })).toBe('key-1');
    expect(keyer.keyFor({ firstName: 'Grace' })).toBe('key-1');
  });

  it('a changed body is a new submission and gets a new key (never a 422 reuse)', () => {
    const keyer = createSubmissionKeyer(counter());
    expect(keyer.keyFor({ firstName: 'Grace' })).toBe('key-1');
    expect(keyer.keyFor({ firstName: 'Grace H.' })).toBe('key-2');
  });

  it('after a successful submission the same body starts a new key', () => {
    const keyer = createSubmissionKeyer(counter());
    expect(keyer.keyFor({ firstName: 'Grace' })).toBe('key-1');
    keyer.settle();
    expect(keyer.keyFor({ firstName: 'Grace' })).toBe('key-2');
  });
});
