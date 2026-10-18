import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_CHOICE_KEYS,
  ONBOARDING_DRAFT_EXECUTION_STATES,
  ApproveOnboardingDraftBodySchema,
  ApproveOnboardingDraftResponseSchema,
  CreateOnboardingDraftBodySchema,
  OnboardingDraftExecutionSchema,
  OnboardingDraftSchema,
  RetryOnboardingDraftResponseSchema,
  StageOnboardingChoiceBodySchema,
  StagedOnboardingChoiceSchema,
} from './onboarding-draft.js';

const option = (key: 'a' | 'b') => ({
  key,
  label: key === 'a' ? 'Walsh Plumbing, how can I help?' : 'Thanks for calling. What is going on today?',
  rivetLine: 'Walsh Plumbing, how can I help?',
  writes: { voiceGreeting: 'Walsh Plumbing, how can I help?' },
});

function draftFixture() {
  return {
    id: '5d6f7d0e-1b57-4d1e-9d6a-0d6f0c2a9a11',
    tenantId: '00000000-0000-0000-0000-0000000000a1',
    packId: 'plumbing',
    trade: 'plumbing',
    metroCode: 'CLE',
    metroName: 'Cleveland',
    businessName: 'Walsh Plumbing',
    ownerFirstName: 'Jenna',
    clientTimezone: 'America/New_York',
    assembled: {
      trade: 'plumbing',
      packId: 'plumbing',
      metroCode: 'CLE',
      metroName: 'Cleveland',
      metroCandidates: [],
      priceSource: 'metro',
      showsCity: true,
      choices: [
        {
          settingKey: 'greeting',
          question: 'How should I answer your phone?',
          options: [option('a'), option('b')],
          mostShops: 'a',
        },
      ],
      defaults: { greeting: 'a' },
    },
    choices: {},
    status: 'draft',
    version: 1,
    proposalIds: [],
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    approvedAt: null,
  };
}

describe('onboarding draft wire contract', () => {
  it('parses a draft and keeps every field', () => {
    const parsed = OnboardingDraftSchema.parse(draftFixture());
    expect(parsed).toEqual(draftFixture());
  });

  it('lists the seven core choices plus the established-shop one', () => {
    expect(ONBOARDING_CHOICE_KEYS).toHaveLength(8);
    expect(ONBOARDING_CHOICE_KEYS[0]).toBe('greeting');
  });

  it('rejects a draft with an unknown status or a non-ISO date', () => {
    expect(OnboardingDraftSchema.safeParse({ ...draftFixture(), status: 'saved' }).success).toBe(false);
    expect(OnboardingDraftSchema.safeParse({ ...draftFixture(), createdAt: 'yesterday' }).success).toBe(false);
  });

  it('accepts an option pick and a free-speech override as a staged choice', () => {
    expect(StagedOnboardingChoiceSchema.safeParse({ option: 'b' }).success).toBe(true);
    expect(
      StagedOnboardingChoiceSchema.safeParse({
        override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } },
      }).success,
    ).toBe(true);
    expect(StagedOnboardingChoiceSchema.safeParse({ option: 'c' }).success).toBe(false);
    expect(StagedOnboardingChoiceSchema.safeParse({ option: 'a', extra: 1 }).success).toBe(false);
  });

  it('requires a positive integer version on the stage body', () => {
    expect(StageOnboardingChoiceBodySchema.safeParse({ choice: { option: 'a' }, version: 1 }).success).toBe(true);
    expect(StageOnboardingChoiceBodySchema.safeParse({ choice: { option: 'a' }, version: 0 }).success).toBe(false);
    expect(StageOnboardingChoiceBodySchema.safeParse({ choice: { option: 'a' } }).success).toBe(false);
  });

  it('keeps the create body to the fields the API accepts', () => {
    expect(
      CreateOnboardingDraftBodySchema.safeParse({ packId: 'plumbing', businessName: 'Walsh Plumbing', clientTimezone: 'America/New_York' }).success,
    ).toBe(true);
    expect(CreateOnboardingDraftBodySchema.safeParse({ packId: 'plumbing' }).success).toBe(false);
    expect(CreateOnboardingDraftBodySchema.safeParse({ packId: 'plumbing', businessName: 'W', nope: 1 }).success).toBe(false);
  });

  it('parses the approve response with its two proposal ids', () => {
    const draft = { ...draftFixture(), status: 'approved', version: 2, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' };
    const parsed = ApproveOnboardingDraftResponseSchema.parse({ draft, proposalIds: ['p1', 'p2'], approvedNow: true });
    expect(parsed.proposalIds).toHaveLength(2);
  });

  it('parses a draft with and without ownerPhone, so an API that predates the field still parses', () => {
    expect(OnboardingDraftSchema.parse(draftFixture()).ownerPhone).toBeUndefined();
    expect(OnboardingDraftSchema.parse({ ...draftFixture(), ownerPhone: '+12165550142' }).ownerPhone).toBe('+12165550142');
    expect(OnboardingDraftSchema.parse({ ...draftFixture(), ownerPhone: null }).ownerPhone).toBeNull();
    expect(OnboardingDraftSchema.safeParse({ ...draftFixture(), ownerPhone: 12165550142 }).success).toBe(false);
    expect(OnboardingDraftSchema.safeParse({ ...draftFixture(), somethingNew: 1 }).success).toBe(false);
  });

  it('takes an optional positive-integer expectedVersion on the approve body and nothing else', () => {
    expect(ApproveOnboardingDraftBodySchema.safeParse({}).success).toBe(true);
    expect(ApproveOnboardingDraftBodySchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
    for (const bad of [{ expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: '3' }, { version: 3 }]) {
      expect(ApproveOnboardingDraftBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('parses the retry response and rejects a body that lacks the re-queued ids', () => {
    const draft = { ...draftFixture(), status: 'approved', version: 2, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' };
    expect(RetryOnboardingDraftResponseSchema.parse({ draft, retriedProposalIds: ['p2'] }).retriedProposalIds).toEqual(['p2']);
    expect(RetryOnboardingDraftResponseSchema.safeParse({ draft }).success).toBe(false);
    expect(RetryOnboardingDraftResponseSchema.safeParse({ draft, retriedProposalIds: [], extra: 1 }).success).toBe(false);
  });

  it('lists the five execution states the status reports', () => {
    expect([...ONBOARDING_DRAFT_EXECUTION_STATES]).toEqual(['pending', 'executing', 'executed', 'failed', 'stopped']);
    expect(OnboardingDraftExecutionSchema.safeParse('failed').success).toBe(true);
    expect(OnboardingDraftExecutionSchema.safeParse('execution_failed').success).toBe(false);
  });
});
