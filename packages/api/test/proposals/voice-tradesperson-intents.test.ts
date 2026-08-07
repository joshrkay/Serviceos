import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_INTENTS,
  type IntentType,
} from '../../src/ai/orchestration/intent-classifier';
import {
  INTENT_TO_PROPOSAL_TYPE,
  intentToProposalType,
} from '../../src/proposals/voice-intent-map';

describe('Phase 1 — alias intents', () => {
  const aliases: Array<[IntentType, string]> = [
    ['schedule_inspection', 'create_appointment'],
    ['log_permit', 'add_note'],
    ['log_warranty_claim', 'create_job'],
  ];

  it.each(aliases)('%s is a supported intent mapping to %s', (intent, proposalType) => {
    expect(SUPPORTED_INTENTS).toContain(intent);
    expect(INTENT_TO_PROPOSAL_TYPE[intent as Exclude<IntentType, 'unknown'>]).toBe(proposalType);
    expect(intentToProposalType(intent)).toBe(proposalType);
  });
});
