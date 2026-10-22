import { describe, expect, it } from 'vitest';
import { narrateTurn, ONBOARDING_CORE_CHOICE_KEYS, type OnboardingDraft } from '@ai-service-os/shared';
import { plumbingCleDraft, withChoices } from './__fixtures__';
import { answeredCount, coreTurns, landingTarget, makeItMineTarget, nextUnanswered } from './turns';

const [GREETING, PRICE, POSTURE, PAID, HOURS, EMERGENCY, AFTER] = ONBOARDING_CORE_CHOICE_KEYS;

describe('turns', () => {
  it('lists the seven core choices in the order Rivet asks them, and not the established-shop one', () => {
    const turns = coreTurns(plumbingCleDraft);
    expect(turns.map((t) => t.settingKey)).toEqual([...ONBOARDING_CORE_CHOICE_KEYS]);
    expect(plumbingCleDraft.assembled.choices.map((c) => c.settingKey)).toContain('existing_number');
  });

  it('skips a core choice the draft does not carry instead of inventing one', () => {
    const draft: OnboardingDraft = {
      ...plumbingCleDraft,
      assembled: { ...plumbingCleDraft.assembled, choices: plumbingCleDraft.assembled.choices.filter((c) => c.settingKey !== HOURS) },
    };
    expect(coreTurns(draft).map((t) => t.settingKey)).not.toContain(HOURS);
    expect(coreTurns(draft)).toHaveLength(6);
  });

  it('counts a choice as answered once it is staged, whichever way it was answered', () => {
    expect(answeredCount(plumbingCleDraft)).toBe(0);
    const draft = withChoices(plumbingCleDraft, {
      [GREETING]: { option: 'b' },
      [PRICE]: { override: { label: '$120 to come out, then $175 an hour', writes: {}, prices: { tripFeeCents: 12000, hourlyRateCents: 17500 } } },
    });
    expect(answeredCount(draft)).toBe(2);
  });

  it('does not count the established-shop choice toward the seven', () => {
    expect(answeredCount(withChoices(plumbingCleDraft, { existing_number: { option: 'a' } }))).toBe(0);
  });

  it('moves on to the next unanswered turn after the current one, skipping answered ones', () => {
    expect(nextUnanswered(plumbingCleDraft, GREETING)).toBe(PRICE);
    const draft = withChoices(plumbingCleDraft, { [PAID]: { option: 'a' }, [HOURS]: { option: 'b' } });
    expect(nextUnanswered(draft, POSTURE)).toBe(EMERGENCY);
    expect(nextUnanswered(draft, PRICE)).toBe(POSTURE);
  });

  it('ends at the read-back after the last unanswered turn', () => {
    expect(nextUnanswered(plumbingCleDraft, AFTER)).toBeNull();
    const draft = withChoices(plumbingCleDraft, { [EMERGENCY]: { option: 'a' }, [AFTER]: { option: 'a' } });
    expect(nextUnanswered(draft, HOURS)).toBeNull();
  });
});

describe('what Rivet says on a turn (narrateTurn, on the assembled draft)', () => {
  it('the price turn: the question, both prices with why and what callers hear, then the usual pick', () => {
    const price = coreTurns(plumbingCleDraft).find((t) => t.settingKey === PRICE)!;
    expect(narrateTurn(price)).toEqual([
      'What do you charge to come out?',
      `First: ${price.options[0].label}. ${price.options[0].detail} Callers hear: “It's $89 for the visit, and that's credited if you go ahead with the repair.”`,
      `Second: ${price.options[1].label}. Fewer calls, better ones. Your other prices move up with it. Callers hear: “It's $129 for the visit. That covers the diagnosis, and it's credited toward the repair.”`,
      'Most shops pick the first. Which one?',
    ]);
  });

  it('the greeting is not said twice: its options are already what callers hear', () => {
    const greeting = coreTurns(plumbingCleDraft).find((t) => t.settingKey === GREETING)!;
    const [, first] = narrateTurn(greeting);
    expect(first).toBe(`First: ${greeting.options[0].label} ${greeting.options[0].detail}`);
    expect(first).not.toContain('Callers hear');
  });
});

describe('where the owner goes', () => {
  const all = Object.fromEntries(ONBOARDING_CORE_CHOICE_KEYS.map((k) => [k, { option: 'a' as const }]));

  it('"Make it mine" opens the first unanswered turn', () => {
    expect(makeItMineTarget(plumbingCleDraft)).toEqual({ screen: 'turn', key: GREETING });
    expect(makeItMineTarget(withChoices(plumbingCleDraft, { [GREETING]: { option: 'a' }, [PRICE]: { option: 'b' }, [POSTURE]: { option: 'a' } }))).toEqual({
      screen: 'turn',
      key: PAID,
    });
  });

  it('"Make it mine" asks in registry order, so an answer to a later turn does not skip an earlier one', () => {
    expect(makeItMineTarget(withChoices(plumbingCleDraft, { [PRICE]: { option: 'a' } }))).toEqual({ screen: 'turn', key: GREETING });
  });

  it('"Make it mine" goes to the read-back when all seven are already answered', () => {
    expect(makeItMineTarget(withChoices(plumbingCleDraft, all))).toEqual({ screen: 'readback' });
  });

  it('a new draft opens on Ready, which is not a turn', () => {
    expect(landingTarget(plumbingCleDraft)).toBeNull();
  });

  it('a returning owner picks up on the first unanswered turn', () => {
    const draft = withChoices(plumbingCleDraft, { [GREETING]: { option: 'b' }, [PRICE]: { option: 'a' }, [POSTURE]: { option: 'b' } });
    expect(landingTarget(draft)).toEqual({ screen: 'turn', key: PAID });
  });

  it('a returning owner who answered everything lands on the read-back', () => {
    expect(landingTarget(withChoices(plumbingCleDraft, all))).toEqual({ screen: 'readback' });
  });

  it('an answer to the established-shop choice alone does not move the owner off Ready', () => {
    expect(landingTarget(withChoices(plumbingCleDraft, { existing_number: { option: 'a' } }))).toBeNull();
  });
});
