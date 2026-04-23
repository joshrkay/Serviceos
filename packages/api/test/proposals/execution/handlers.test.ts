import { describe, it, expect, beforeEach } from 'vitest';
import {
  CreateCustomerExecutionHandler,
  UpdateCustomerExecutionHandler,
  CreateJobExecutionHandler,
} from '../../../src/proposals/execution/handlers';
import { Proposal, ProposalType } from '../../../src/proposals/proposal';
import {
  InMemoryCustomerRepository,
  createCustomer,
} from '../../../src/customers/customer';
import {
  InMemoryLocationRepository,
  createLocation,
} from '../../../src/locations/location';
import { InMemoryJobRepository } from '../../../src/jobs/job';

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

describe('CreateJobExecutionHandler', () => {
  let customerRepo: InMemoryCustomerRepository;
  let locationRepo: InMemoryLocationRepository;
  let jobRepo: InMemoryJobRepository;

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
    locationRepo = new InMemoryLocationRepository();
    jobRepo = new InMemoryJobRepository();
  });

  async function seedCustomerWithPrimaryLocation() {
    const customer = await createCustomer(
      {
        tenantId,
        firstName: 'Jane',
        lastName: 'Doe',
        createdBy: 'user-1',
      },
      customerRepo
    );
    const location = await createLocation(
      {
        tenantId,
        customerId: customer.id,
        street1: '123 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      },
      locationRepo
    );
    return { customer, location };
  }

  it('persists the job against the customer primary location and returns the persisted id', async () => {
    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const { customer, location } = await seedCustomerWithPrimaryLocation();

    const proposal = makeProposal('create_job', {
      customerId: customer.id,
      title: 'Water heater replacement',
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const persisted = await jobRepo.findById(tenantId, result.resultEntityId!);
    expect(persisted).not.toBeNull();
    expect(persisted!.customerId).toBe(customer.id);
    expect(persisted!.locationId).toBe(location.id);
    expect(persisted!.summary).toBe('Water heater replacement');
    expect(persisted!.tenantId).toBe(tenantId);
  });

  it('accepts payload.summary in addition to payload.title', async () => {
    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const { customer } = await seedCustomerWithPrimaryLocation();

    const proposal = makeProposal('create_job', {
      customerId: customer.id,
      summary: 'Annual HVAC maintenance',
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    const persisted = await jobRepo.findById(tenantId, result.resultEntityId!);
    expect(persisted!.summary).toBe('Annual HVAC maintenance');
  });

  it('prefers an explicit payload.locationId over the primary', async () => {
    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const { customer } = await seedCustomerWithPrimaryLocation();
    // Add a secondary location — still attached to same customer, not primary.
    const secondary = await createLocation(
      {
        tenantId,
        customerId: customer.id,
        street1: '500 Back Office Rd',
        city: 'Austin',
        state: 'TX',
        postalCode: '78704',
      },
      locationRepo
    );

    const proposal = makeProposal('create_job', {
      customerId: customer.id,
      title: 'Visit secondary site',
      locationId: secondary.id,
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    const persisted = await jobRepo.findById(tenantId, result.resultEntityId!);
    expect(persisted!.locationId).toBe(secondary.id);
  });

  it('fails loud when the customer has no locations', async () => {
    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const customer = await createCustomer(
      {
        tenantId,
        firstName: 'No',
        lastName: 'Locations',
        createdBy: 'user-1',
      },
      customerRepo
    );

    const proposal = makeProposal('create_job', {
      customerId: customer.id,
      title: 'Will fail — no location',
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no service location|no location/i);
  });

  it('rejects a payload missing customerId', async () => {
    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const proposal = makeProposal('create_job', { title: 'Missing customer' });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('customerId');
  });

  it('rejects a payload missing both title and summary', async () => {
    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const { customer } = await seedCustomerWithPrimaryLocation();
    const proposal = makeProposal('create_job', { customerId: customer.id });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/title|summary/i);
  });

  it('returns a synthetic id when no repos are wired (legacy in-memory tests)', async () => {
    const handler = new CreateJobExecutionHandler();
    const proposal = makeProposal('create_job', {
      customerId: 'cust-1',
      title: 'Legacy path',
    });

    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
  });
});
