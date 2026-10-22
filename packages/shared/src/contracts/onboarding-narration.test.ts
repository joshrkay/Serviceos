import { describe, expect, it } from 'vitest';
import { answerHelp, narrateTurn, type NarratedChoice } from './onboarding-narration.js';

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

describe('answerHelp', () => {
  const withHelp: NarratedChoice = {
    ...booking,
    supportLine: 'Emergencies skip this.',
    explain: 'Booking it means I put the job on your calendar while the caller is on the line',
    example: 'A caller needs a repair this week.',
  };

  it('"say that again" is the whole turn again', () => {
    expect(answerHelp(withHelp, 'repeat')).toEqual(narrateTurn(withHelp));
  });

  it('"what does that mean?" is the plain-words explanation, then asks again', () => {
    expect(answerHelp(withHelp, 'explain')).toEqual([
      'Booking it means I put the job on your calendar while the caller is on the line.',
      'Which one?',
    ]);
  });

  it('"give me an example" is the example, then asks again', () => {
    expect(answerHelp(withHelp, 'example')).toEqual(['A caller needs a repair this week.', 'Which one?']);
  });

  it('"what do most shops do?" names the usual pick and why', () => {
    expect(answerHelp(withHelp, 'most_shops')).toEqual(['Most shops pick the first: Book it on the call. The caller leaves with a time.', 'Which one?']);
    expect(answerHelp({ ...withHelp, mostShops: 'b' }, 'most_shops')[0]).toBe(
      "Most shops pick the second: Hold it for me. I take the details and say you'll confirm.",
    );
  });

  it('a draft from before the explanations still answers, from the support line and the cards', () => {
    expect(answerHelp(booking, 'explain')).toEqual([...narrateTurn(booking).slice(1, 3), 'Which one?']);
    expect(answerHelp({ ...booking, supportLine: 'Emergencies skip this' }, 'explain')[0]).toBe('Emergencies skip this.');
    expect(answerHelp(booking, 'example')).toEqual([
      'With the first, callers hear: “I have Tuesday at 2 or Wednesday at 9. Which works for you?”',
      'With the second, callers hear: “Sam will confirm a time.”',
      'Which one?',
    ]);
  });

  it('never more than four clips: one batch request', () => {
    for (const help of ['repeat', 'explain', 'example', 'most_shops'] as const) {
      expect(answerHelp({ ...booking, supportLine: 'Emergencies skip this.' }, help).length).toBeLessThanOrEqual(4);
    }
  });
});
