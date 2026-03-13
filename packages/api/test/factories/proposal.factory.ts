import { faker } from '@faker-js/faker';
import { Proposal, ProposalStatus, ProposalType, CreateProposalInput } from '../../src/proposals/proposal';

export function buildProposal(overrides?: Partial<Proposal>): Proposal {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    proposalType: 'draft_estimate' as ProposalType,
    status: 'draft' as ProposalStatus,
    payload: { lineItems: [], summary: faker.lorem.sentence() },
    summary: faker.lorem.sentence(),
    explanation: faker.lorem.paragraph(),
    confidenceScore: faker.number.float({ min: 0.5, max: 1.0, fractionDigits: 2 }),
    confidenceFactors: ['historical_data', 'customer_context'],
    sourceContext: {},
    aiRunId: faker.string.uuid(),
    targetEntityType: 'estimate',
    targetEntityId: faker.string.uuid(),
    idempotencyKey: faker.string.uuid(),
    expiresAt: faker.date.future(),
    createdBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateProposalInput(overrides?: Partial<CreateProposalInput>): CreateProposalInput {
  return {
    tenantId: faker.string.uuid(),
    proposalType: 'draft_estimate',
    payload: { lineItems: [], summary: faker.lorem.sentence() },
    summary: faker.lorem.sentence(),
    confidenceScore: 0.85,
    createdBy: faker.string.uuid(),
    ...overrides,
  };
}
