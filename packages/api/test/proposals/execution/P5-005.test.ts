import { CreateInvoiceExecutionHandler } from '../../../src/proposals/execution/invoice-execution-handler';
import { createExecutionHandlerRegistry } from '../../../src/proposals/execution/handlers';
import { Proposal } from '../../../src/proposals/proposal';

describe('P5-005 — Deterministic invoice proposal execution', () => {
  let handler: CreateInvoiceExecutionHandler;

  const tenantId = 'tenant-1';

  function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
    return {
      id: 'proposal-1',
      tenantId,
      proposalType: 'draft_invoice',
      status: 'approved',
      payload: {
        customerId: 'cust-1',
        jobId: 'job-1',
        lineItems: [{ id: 'li-1', description: 'Service', quantity: 1, unitPriceCents: 5000 }],
      },
      summary: 'Draft invoice for job',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    handler = new CreateInvoiceExecutionHandler();
  });

  it('happy path — executes with resultEntityId', async () => {
    const proposal = makeProposal();
    const result = await handler.execute(proposal, { tenantId, executedBy: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
    expect(typeof result.resultEntityId).toBe('string');
  });

  it('validation — missing customerId returns error', async () => {
    const proposal = makeProposal({
      payload: { jobId: 'job-1', lineItems: [{ id: 'li-1' }] },
    });
    const result = await handler.execute(proposal, { tenantId, executedBy: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Payload must include a valid customerId');
  });

  it('validation — missing jobId returns error', async () => {
    const proposal = makeProposal({
      payload: { customerId: 'cust-1', lineItems: [{ id: 'li-1' }] },
    });
    const result = await handler.execute(proposal, { tenantId, executedBy: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Payload must include a valid jobId');
  });

  it('validation — empty lineItems returns error', async () => {
    const proposal = makeProposal({
      payload: { customerId: 'cust-1', jobId: 'job-1', lineItems: [] },
    });
    const result = await handler.execute(proposal, { tenantId, executedBy: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Payload must include at least one lineItem');
  });

  it('tenant isolation — proposal tenantId preserved through execution', async () => {
    const proposal = makeProposal({ tenantId: 'tenant-abc' });
    const result = await handler.execute(proposal, { tenantId: 'tenant-abc', executedBy: 'user-1' });

    expect(result.success).toBe(true);
    expect(proposal.tenantId).toBe('tenant-abc');
  });

  it('idempotency — proposal with existing resultEntityId returns same ID', async () => {
    const existingId = 'existing-entity-id';
    const proposal = makeProposal({ resultEntityId: existingId });
    const result = await handler.execute(proposal, { tenantId, executedBy: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(existingId);
  });

  it('invalid transition — non-approved proposal status should still execute (handler is status-agnostic)', async () => {
    const proposal = makeProposal({ status: 'draft' });
    const result = await handler.execute(proposal, { tenantId, executedBy: 'user-1' });

    // Handler validates payload, not proposal status — status enforcement is upstream
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });

  it('registry — handler is registered in createExecutionHandlerRegistry', () => {
    const registry = createExecutionHandlerRegistry();
    const registeredHandler = registry.get('draft_invoice');

    expect(registeredHandler).toBeDefined();
    expect(registeredHandler).toBeInstanceOf(CreateInvoiceExecutionHandler);
  });
});
