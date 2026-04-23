import { describe, it, expect, beforeEach } from 'vitest';
import {
  CreateCustomerExecutionHandler,
  UpdateCustomerExecutionHandler,
} from '../../../src/proposals/execution/handlers';
import { Proposal, ProposalType } from '../../../src/proposals/proposal';
import {
  InMemoryCustomerRepository,
  createCustomer,
} from '../../../src/customers/customer';

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

describe('UpdateCustomerExecutionHandler', () => {
  let customerRepo: InMemoryCustomerRepository;

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
  });

  async function seedCustomer() {
    return createCustomer(
      {
        tenantId,
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        primaryPhone: '555-0100',
        createdBy: 'user-1',
      },
      customerRepo
    );
  }

  it('persists the patch and leaves untouched fields intact', async () => {
    const handler = new UpdateCustomerExecutionHandler(customerRepo);
    const seeded = await seedCustomer();

    const proposal = makeProposal('update_customer', {
      customerId: seeded.id,
      email: 'jane.doe@acme.com',
      phone: '555-0199',
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    const persisted = await customerRepo.findById(tenantId, seeded.id);
    expect(persisted!.email).toBe('jane.doe@acme.com');
    expect(persisted!.primaryPhone).toBe('555-0199');
    // Unchanged fields survive the patch.
    expect(persisted!.firstName).toBe('Jane');
    expect(persisted!.lastName).toBe('Doe');
  });

  it('returns failure when the customer does not exist', async () => {
    const handler = new UpdateCustomerExecutionHandler(customerRepo);
    const proposal = makeProposal('update_customer', {
      customerId: 'does-not-exist',
      email: 'new@example.com',
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects a payload missing customerId', async () => {
    const handler = new UpdateCustomerExecutionHandler(customerRepo);
    const proposal = makeProposal('update_customer', { email: 'new@example.com' });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('customerId');
  });

  it('returns success without persistence when no repo is wired', async () => {
    const handler = new UpdateCustomerExecutionHandler();
    const proposal = makeProposal('update_customer', { customerId: 'cust-1' });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
  });
});
