import { CreateInvoiceExecutionHandler } from '../../../src/proposals/execution/invoice-execution-handler';
import { createExecutionHandlerRegistry } from '../../../src/proposals/execution/handlers';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import {
  InMemorySettingsRepository,
  TenantSettings,
} from '../../../src/settings/settings';

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

  describe('real persistence path (invoiceRepo + settingsRepo wired)', () => {
    function makeSettingsRepo(): InMemorySettingsRepository {
      const repo = new InMemorySettingsRepository();
      const seeded: TenantSettings = {
        id: 'settings-1',
        tenantId,
        businessName: 'Test Co',
        timezone: 'UTC',
        estimatePrefix: 'EST-',
        invoicePrefix: 'INV-',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      void repo.create(seeded);
      return repo;
    }

    it('creates a real invoice row in the repository when deps are wired', async () => {
      const invoiceRepo = new InMemoryInvoiceRepository();
      const settingsRepo = makeSettingsRepo();
      const handlerWithDeps = new CreateInvoiceExecutionHandler(invoiceRepo, settingsRepo);

      const proposal = makeProposal();
      const result = await handlerWithDeps.execute(proposal, {
        tenantId,
        executedBy: 'user-1',
      });

      expect(result.success).toBe(true);
      expect(result.resultEntityId).toBeTruthy();

      const stored = await invoiceRepo.findById(tenantId, result.resultEntityId!);
      expect(stored).not.toBeNull();
      expect(stored!.jobId).toBe('job-1');
      expect(stored!.invoiceNumber).toMatch(/^INV-/);
      expect(stored!.lineItems).toHaveLength(1);
      expect(stored!.status).toBe('draft');
      expect(stored!.createdBy).toBe('user-1');
    });

    it('auto-increments the invoice number across executions', async () => {
      const invoiceRepo = new InMemoryInvoiceRepository();
      const settingsRepo = makeSettingsRepo();
      const handlerWithDeps = new CreateInvoiceExecutionHandler(invoiceRepo, settingsRepo);

      const r1 = await handlerWithDeps.execute(makeProposal({ id: 'p1' }), {
        tenantId,
        executedBy: 'user-1',
      });
      const r2 = await handlerWithDeps.execute(makeProposal({ id: 'p2' }), {
        tenantId,
        executedBy: 'user-1',
      });

      const inv1 = await invoiceRepo.findById(tenantId, r1.resultEntityId!);
      const inv2 = await invoiceRepo.findById(tenantId, r2.resultEntityId!);

      expect(inv1!.invoiceNumber).toBe('INV-0001');
      expect(inv2!.invoiceNumber).toBe('INV-0002');
    });

    it('returns an error when invoice creation fails downstream', async () => {
      const invoiceRepo = new InMemoryInvoiceRepository();
      const settingsRepo = makeSettingsRepo();
      const handlerWithDeps = new CreateInvoiceExecutionHandler(invoiceRepo, settingsRepo);

      // Force createInvoice to reject validation by passing through the
      // existing validation path (empty lineItems is already caught before
      // persistence, so we simulate a different failure — non-string jobId
      // will still pass our guard but createInvoice.validateInvoiceInput
      // requires a non-empty jobId string; cast to force the repo-level
      // error).
      const proposal = makeProposal();
      (proposal.payload.lineItems as unknown) = 'not an array';
      const result = await handlerWithDeps.execute(proposal, {
        tenantId,
        executedBy: 'user-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('does not burn an invoice number when invoiceRepo.create fails', async () => {
      const settingsRepo = makeSettingsRepo();
      const failingRepo = new InMemoryInvoiceRepository();
      // Make the next create() call reject so we can observe whether the
      // settings counter was incremented before the row was persisted.
      const origCreate = failingRepo.create.bind(failingRepo);
      let firstCallRejected = false;
      failingRepo.create = async (invoice) => {
        if (!firstCallRejected) {
          firstCallRejected = true;
          throw new Error('simulated db failure');
        }
        return origCreate(invoice);
      };

      const handlerWithDeps = new CreateInvoiceExecutionHandler(failingRepo, settingsRepo);

      // First execute fails mid-flight.
      const r1 = await handlerWithDeps.execute(makeProposal({ id: 'p-fail' }), {
        tenantId,
        executedBy: 'user-1',
      });
      expect(r1.success).toBe(false);

      // Counter must still be at 1 — the failed create never allocated a
      // number, so the next successful run lands on INV-0001 (no gap).
      const r2 = await handlerWithDeps.execute(makeProposal({ id: 'p-ok' }), {
        tenantId,
        executedBy: 'user-1',
      });
      expect(r2.success).toBe(true);
      const invoice = await failingRepo.findById(tenantId, r2.resultEntityId!);
      expect(invoice!.invoiceNumber).toBe('INV-0001');
    });
  });
});
