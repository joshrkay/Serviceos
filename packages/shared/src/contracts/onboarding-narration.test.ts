import { describe, expect, it } from 'vitest';
import { narrateTurn, type NarratedChoice } from './onboarding-narration.js';

const booking: NarratedChoice = {
  question: 'When someone wants a repair, do I book it or hold it for you?',
  options: [
    {
      key: 'a',
      label: 'Book it on the call',
      detail: 'The caller leaves with a time.',
      rivetLine: 'I have Tuesday at 2 or Wednesday at 9. Which works for you?',
    },
    { key: 'b', label: 'Hold it for me', detail: "I take the details and say you'll confirm", rivetLine: 'Sam will confirm a time.' },
  ],
  mostShops: 'a',
};

describe('narrateTurn', () => {
  it('is the question, each option with why and what callers hear, then which one most shops pick', () => {
    expect(narrateTurn(booking)).toEqual([
      'When someone wants a repair, do I book it or hold it for you?',
      'First: Book it on the call. The caller leaves with a time. Callers hear: “I have Tuesday at 2 or Wednesday at 9. Which works for you?”',
      "Second: Hold it for me. I take the details and say you'll confirm. Callers hear: “Sam will confirm a time.”",
      'Most shops pick the first. Which one?',
    ]);
  });

  it('names the second when that is the usual pick', () => {
    expect(narrateTurn({ ...booking, mostShops: 'b' }).at(-1)).toBe('Most shops pick the second. Which one?');
  });

  it('does not repeat a line that is already what callers hear (the greeting)', () => {
    const greeting: NarratedChoice = {
      question: 'How should I answer your phone?',
      options: [
        { key: 'a', label: 'Walsh Plumbing, how can I help?', detail: 'Short.', rivetLine: 'Walsh Plumbing, how can I help?' },
        { key: 'b', label: 'Thanks for calling.', rivetLine: 'Thanks for calling.' },
      ],
      mostShops: 'a',
    };
    expect(narrateTurn(greeting)).toEqual([
      'How should I answer your phone?',
      'First: Walsh Plumbing, how can I help? Short.',
      'Second: Thanks for calling.',
      'Most shops pick the first. Which one?',
    ]);
  });

  it('is always four clips: one batch request', () => {
    expect(narrateTurn(booking)).toHaveLength(4);
  });
});
