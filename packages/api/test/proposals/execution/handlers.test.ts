import { describe, it, expect, beforeEach } from 'vitest';
import {
  CreateCustomerExecutionHandler,
} from '../../../src/proposals/execution/handlers';
import { Proposal, ProposalType } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';
const context = { tenantId, executedBy: 'user-1' };

function makeProposal(
  proposalType: ProposalType,
  payload: Record<string, unknown>
): Proposal {
  return {
    id: 'prop-1',
    tenantId,
    proposalType,
    status: 'approved',
    payload,
    summary: 'Voice proposal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('CreateCustomerExecutionHandler', () => {
  let customerRepo: InMemoryCustomerRepository;

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
  });

  it('persists the customer when a repo is wired and returns the persisted id', async () => {
    const handler = new CreateCustomerExecutionHandler(customerRepo);
    const proposal = makeProposal('create_customer', {
      name: 'Jane Doe',
      email: 'jane@example.com',
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const persisted = await customerRepo.findById(tenantId, result.resultEntityId!);
    expect(persisted).not.toBeNull();
    expect(persisted!.firstName).toBe('Jane Doe');
    expect(persisted!.email).toBe('jane@example.com');
    expect(persisted!.tenantId).toBe(tenantId);
    expect(persisted!.createdBy).toBe('user-1');
  });

  it('returns a synthetic id when no repo is wired (legacy in-memory tests)', async () => {
    const handler = new CreateCustomerExecutionHandler();
    const proposal = makeProposal('create_customer', { name: 'Jane Doe' });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
  });

  it('rejects a payload missing name', async () => {
    const handler = new CreateCustomerExecutionHandler(customerRepo);
    const proposal = makeProposal('create_customer', {});

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('name');
  });

  it('is idempotent on proposals with a pre-existing resultEntityId', async () => {
    const handler = new CreateCustomerExecutionHandler(customerRepo);
    const proposal = {
      ...makeProposal('create_customer', { name: 'Jane Doe' }),
      resultEntityId: 'already-assigned-id',
    };

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('already-assigned-id');
    // No write should have happened — the id was already known.
    const persisted = await customerRepo.findById(tenantId, 'already-assigned-id');
    expect(persisted).toBeNull();
  });
});
