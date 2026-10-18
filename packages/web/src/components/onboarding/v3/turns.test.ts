import { describe, expect, it } from 'vitest';
import { ONBOARDING_CORE_CHOICE_KEYS, type OnboardingDraft } from '@ai-service-os/shared';
import { plumbingCleDraft, withChoices } from './__fixtures__';
import { answeredCount, coreTurns, firstUnanswered, nextUnanswered } from './turns';

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

  it('finds the first unanswered turn in registry order', () => {
    expect(firstUnanswered(plumbingCleDraft)).toBe(GREETING);
    expect(firstUnanswered(withChoices(plumbingCleDraft, { [GREETING]: { option: 'a' }, [PRICE]: { option: 'a' }, [POSTURE]: { option: 'b' } }))).toBe(PAID);
    expect(firstUnanswered(withChoices(plumbingCleDraft, { [PRICE]: { option: 'a' } }))).toBe(GREETING);
  });

  it('has no unanswered turn once all seven are staged', () => {
    const all = Object.fromEntries(ONBOARDING_CORE_CHOICE_KEYS.map((k) => [k, { option: 'a' as const }]));
    expect(firstUnanswered(withChoices(plumbingCleDraft, all))).toBeNull();
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
