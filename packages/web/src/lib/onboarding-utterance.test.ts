import { describe, expect, it } from 'vitest';
import type { MatchableOptions } from './option-matcher';
import { interpretUtterance, unclearReply, type UtteranceScreen } from './onboarding-utterance';

// Real v3 registry copy (packages/api/src/onboarding/choices/registry/common.ts).
const booking: MatchableOptions = [
  { key: 'a', label: 'Book it on the call' },
  { key: 'b', label: 'Hold it for me' },
];
const greeting: MatchableOptions = [
  { key: 'a', label: 'Reyes Plumbing, how can I help?' },
  { key: 'b', label: "Thanks for calling Reyes Plumbing. What's going on today?" },
];

const ALL_HELP = ['repeat', 'explain', 'example', 'most_shops'] as const;
const choiceTurn: UtteranceScreen = { options: booking, help: ALL_HELP };
const ready: UtteranceScreen = {
  help: ALL_HELP,
  commands: [
    { id: 'make_it_mine', phrases: ['make it mine', "let's make it mine"] },
    { id: 'keep_as_is', phrases: ['that works', 'keep it', 'looks good'] },
  ],
};
const businessName: UtteranceScreen = { help: ALL_HELP, freeAnswer: true };

describe('interpretUtterance: picks', () => {
  it.each([
    ['the second one', 'b', 'ordinal'],
    ['um, first please', 'a', 'ordinal'],
    ['b', 'b', 'letter'],
    ['just hold it for me', 'b', 'label'],
  ] as const)('"%s" picks %s (%s)', (said, key, by) => {
    expect(interpretUtterance(said, choiceTurn)).toMatchObject({ kind: 'pick', key, by, transcript: said });
  });

  it('a greeting read back word for word picks that greeting', () => {
    expect(interpretUtterance("thanks for calling reyes plumbing what's going on today", { options: greeting, help: ALL_HELP })).toMatchObject({
      kind: 'pick',
      key: 'b',
    });
  });
});

describe('interpretUtterance: help, before anything else', () => {
  it.each([
    ['say that again', 'repeat'],
    ['sorry, can you repeat that?', 'repeat'],
    ["I didn't catch that", 'repeat'],
    ['what does that mean', 'explain'],
    ['what does the first one mean', 'explain'],
    ["what's the difference", 'explain'],
    ['I don’t understand', 'explain'],
    ['give me an example', 'example'],
    ['like what?', 'example'],
    ['what do most shops do', 'most_shops'],
    ['which one would you pick', 'most_shops'],
    ['what do you recommend', 'most_shops'],
  ] as const)('"%s" asks for %s', (said, help) => {
    expect(interpretUtterance(said, choiceTurn)).toEqual({ kind: 'help', help, transcript: said });
  });

  it('a screen only hears the help it offers', () => {
    const repeatOnly: UtteranceScreen = { options: booking, help: ['repeat'] };
    expect(interpretUtterance('give me an example', repeatOnly)).toMatchObject({ kind: 'unclear' });
    expect(interpretUtterance('say that again', { options: booking })).toMatchObject({ kind: 'unclear' });
  });
});

describe('interpretUtterance: a screen’s own commands', () => {
  it.each([
    ['make it mine', 'make_it_mine'],
    ["Let's make it mine.", 'make_it_mine'],
    ['yeah that works for me', 'keep_as_is'],
    ['looks good', 'keep_as_is'],
  ] as const)('"%s" is %s', (said, command) => {
    expect(interpretUtterance(said, ready)).toEqual({ kind: 'command', command, transcript: said });
  });

  it('a turned-around command is not that command', () => {
    expect(interpretUtterance("that doesn't work", ready)).toMatchObject({ kind: 'unclear' });
    expect(interpretUtterance('no, wait, keep it', ready)).toMatchObject({ kind: 'unclear' });
  });

  it('a command buried in a longer sentence is not taken', () => {
    expect(interpretUtterance('I was going to say that works but actually I want to change the hours', ready)).toMatchObject({
      kind: 'unclear',
    });
  });
});

describe('interpretUtterance: free answers and unclear', () => {
  it('on a screen that takes the owner’s own words, anything else is the answer', () => {
    expect(interpretUtterance('  Walsh Plumbing and Heating ', businessName)).toEqual({ kind: 'free', text: 'Walsh Plumbing and Heating' });
  });

  it('help still comes first on a free-answer screen', () => {
    expect(interpretUtterance('what do most people put', businessName)).toMatchObject({ kind: 'help', help: 'most_shops' });
  });

  it('nothing matched on a screen with no free answer is unclear, never a guess', () => {
    expect(interpretUtterance('banana', choiceTurn)).toEqual({ kind: 'unclear', transcript: 'banana' });
    expect(interpretUtterance('not the first one', choiceTurn)).toMatchObject({ kind: 'unclear' });
  });

  it('silence or only hesitation is unclear', () => {
    expect(interpretUtterance('', businessName)).toMatchObject({ kind: 'unclear' });
    expect(interpretUtterance('um, uh', businessName)).toMatchObject({ kind: 'unclear' });
  });
});

describe('unclearReply: what was heard and what the screen accepts', () => {
  it('a choice turn: the cards, and an example from the second miss', () => {
    expect(unclearReply('banana', 1, choiceTurn)).toBe('I heard “banana”. Tap one, or say first or second.');
    expect(unclearReply('something else', 2, choiceTurn)).toBe(
      'I heard “something else”. Tap one, or say first or second. For example, say “first”.',
    );
  });

  it('a command screen offers its first phrase for each command', () => {
    expect(unclearReply('hmm okay', 1, ready)).toBe('I heard “hmm okay”. Say “make it mine”, or say “that works”.');
    expect(unclearReply('what', 2, ready)).toBe('I heard “what”. Say “make it mine”, or say “that works”. For example, say “make it mine”.');
  });

  it('nothing heard says so', () => {
    expect(unclearReply('  ', 1, businessName)).toBe("I didn't catch that. Just say your answer.");
  });
});
