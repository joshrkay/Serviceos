import { describe, expect, it } from 'vitest';
import { withoutListeningPromise } from './listening-copy';

describe('withoutListeningPromise (a turn that cannot listen never tells the owner to say anything)', () => {
  it('drops the say-first-or-second sentence and keeps the rest of the line', () => {
    expect(withoutListeningPromise('Tap one to hear it. Say "first" or "second" to pick.')).toBe('Tap one to hear it.');
    expect(withoutListeningPromise('Tap one to hear it. Say “first” or “second” to pick.')).toBe('Tap one to hear it.');
    expect(withoutListeningPromise('Tap the one that sounds right, or say "first" or "second". Nothing is saved until you say so.')).toBe(
      'Tap the one that sounds right. Nothing is saved until you say so.',
    );
  });

  it('leaves "say" that does not mean speaking alone: the emergency line\'s "Say a caller tells me"', () => {
    const emergency = 'Say a caller tells me "my basement is flooding". Safety first, then a person. That part I always do. This part is yours.';
    expect(withoutListeningPromise(emergency)).toBe(emergency);
    expect(withoutListeningPromise("Nothing's saved until you say so.")).toBe("Nothing's saved until you say so.");
  });

  it('passes an empty or absent line through', () => {
    expect(withoutListeningPromise('')).toBe('');
    expect(withoutListeningPromise(undefined)).toBeUndefined();
  });
});
