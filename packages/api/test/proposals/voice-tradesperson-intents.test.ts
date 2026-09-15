import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_INTENTS,
  type IntentType,
} from '../../src/ai/orchestration/intent-classifier';
import {
  INTENT_TO_PROPOSAL_TYPE,
  intentToProposalType,
} from '../../src/proposals/voice-intent-map';
import type { ProposalType } from '../../src/proposals/proposal';

describe('Phase 1 — alias intents', () => {
  const aliases: Array<[Exclude<IntentType, 'unknown'>, ProposalType]> = [
    ['schedule_inspection', 'create_appointment'],
    ['log_permit', 'add_note'],
    ['log_warranty_claim', 'create_job'],
  ];

  it.each(aliases)('%s is a supported intent mapping to %s', (intent, proposalType) => {
    expect(SUPPORTED_INTENTS).toContain(intent);
    expect(INTENT_TO_PROPOSAL_TYPE[intent]).toBe(proposalType);
    expect(intentToProposalType(intent)).toBe(proposalType);
  });
});

describe('Phase 1 — update_catalog_item voice intent', () => {
  it('is supported and maps to the existing update_catalog_item proposal type', () => {
    expect(SUPPORTED_INTENTS).toContain('update_catalog_item');
    expect(intentToProposalType('update_catalog_item')).toBe('update_catalog_item');
  });
});
