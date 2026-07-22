import { describe, it, expect } from 'vitest';
import {
  matchDisambiguationFollowUp,
  MAX_DISAMBIGUATION_ATTEMPTS,
  type PendingEntityAmbiguity,
} from '../../../../src/ai/agents/customer-calling/entity-resolution';

const SMITH_PENDING: PendingEntityAmbiguity = {
  entityKind: 'customer',
  reference: 'Smith',
  refKey: 'customerId',
  partialRefs: { scheduledStart: '2026-07-23T14:00:00.000Z' },
  attemptCount: 0,
  candidates: [
    {
      id: 'smith-a',
      name: 'Smith',
      score: 0.91,
      hint: '+14805550104 · 104 QA Cedar Avenue, Phoenix',
    },
    {
      id: 'smith-b',
      name: 'Smith',
      score: 0.9,
      hint: '+14805550105 · 105 QA Cedar Avenue, Phoenix',
    },
  ],
};

describe('matchDisambiguationFollowUp', () => {
  it('matches a service-address follow-up for identical customer names', () => {
    const result = matchDisambiguationFollowUp('104 Cedar', SMITH_PENDING);
    expect(result).toEqual({ status: 'resolved', candidateId: 'smith-a' });
  });

  it('matches phone-tail street numbers when only phone hints are present', () => {
    const pending: PendingEntityAmbiguity = {
      ...SMITH_PENDING,
      candidates: [
        { id: 'smith-a', name: 'Smith', score: 0.91, hint: '+14805550104' },
        { id: 'smith-b', name: 'Smith', score: 0.9, hint: '+14805550105' },
      ],
    };
    expect(matchDisambiguationFollowUp('104 Cedar', pending)).toEqual({
      status: 'resolved',
      candidateId: 'smith-a',
    });
  });

  it('matches ordinals within the candidate list', () => {
    const result = matchDisambiguationFollowUp('the second one', SMITH_PENDING);
    expect(result).toEqual({ status: 'resolved', candidateId: 'smith-b' });
  });

  it('returns still_ambiguous when two candidates share the same address token', () => {
    const pending: PendingEntityAmbiguity = {
      ...SMITH_PENDING,
      candidates: [
        { id: 'a', name: 'Smith', score: 0.9, hint: '104 QA Cedar Avenue' },
        { id: 'b', name: 'Smith', score: 0.89, hint: '104 QA Cedar Lane' },
      ],
    };
    expect(matchDisambiguationFollowUp('104 Cedar', pending)).toEqual({
      status: 'still_ambiguous',
    });
  });

  it('returns unmatched for unrelated follow-ups', () => {
    expect(matchDisambiguationFollowUp('maybe tomorrow', SMITH_PENDING)).toEqual({
      status: 'unmatched',
    });
  });

  it('caps retry attempts at MAX_DISAMBIGUATION_ATTEMPTS', () => {
    expect(MAX_DISAMBIGUATION_ATTEMPTS).toBe(2);
  });
});
