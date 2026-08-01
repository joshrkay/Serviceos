/**
 * QA-2026-07-28 — existence-checked customerId AND jobId on draft_invoice
 * execution.
 *
 * The voice path used to let the drafting model author both ids (the prompt
 * handed it `"customerId": "<uuid>"` / `"jobId": "<uuid>"` templates and told
 * it to "Ensure customerId and jobId are present"). Development drafts came
 * back carrying "unknown", "<uuid>", and the RFC 4122 EXAMPLE uuid
 * 123e4567-e89b-12d3-a456-426614174000.
 *
 * That last one is the reason this suite exists. It is SYNTACTICALLY VALID:
 * `z.string().uuid()` accepts it, so schema validation alone cannot catch it.
 * Unchecked it reaches real writes:
 *
 *   - a fake `customerId` auto-opens a JOB for a customer that doesn't exist;
 *   - a fake `jobId` is written straight onto the invoice as its job container
 *     AND skips the auto-open path entirely, attaching money to nothing.
 *
 * The only sufficient check is an existence check against THIS tenant, which
 * is what CreateInvoiceExecutionHandler now performs before any write. Mirrors
 * draft-estimate-customer-existence.test.ts (commit 7fd370e4).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CreateInvoiceExecutionHandler } from '../../../src/proposals/execution/invoice-execution-handler';
import { createExecutionHandlerRegistry } from '../../../src/proposals/execution/handlers';
import { validateProposalPayload } from '../../../src/proposals/contracts';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import { InMemorySettingsRepository, TenantSettings } from '../../../src/settings/settings';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../../src/locations/location';
import { InMemoryJobRepository, createJob } from '../../../src/jobs/job';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_TENANT = '660e8400-e29b-41d4-a716-446655440000';
const EXECUTOR = 'user-1';
const CONTEXT = { tenantId: TENANT, executedBy: EXECUTOR };

/** RFC 4122 §C.1 example uuid — well-formed, references nothing. */
const RFC_EXAMPLE_UUID = '123e4567-e89b-12d3-a456-426614174000';

const LINE_ITEMS = [
  { id: 'li-1', description: 'Water heater install', quantity: 1, unitPriceCents: 185_000 },
];

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: TENANT,
    proposalType: 'draft_invoice',
    status: 'approved',
    payload,
    summary: 'draft invoice',
    createdBy: EXECUTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function seededSettings(): InMemorySettingsRepository {
  const repo = new InMemorySettingsRepository();
  const seeded: TenantSettings = {
    id: 'settings-1',
    tenantId: TENANT,
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

describe('CreateInvoiceExecutionHandler — tenant-scoped entity existence checks', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let customerRepo: InMemoryCustomerRepository;
  let locationRepo: InMemoryLocationRepository;
  let jobRepo: InMemoryJobRepository;
  let handler: CreateInvoiceExecutionHandler;
  let realCustomerId: string;
  let realJobId: string;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    customerRepo = new InMemoryCustomerRepository();
    locationRepo = new InMemoryLocationRepository();
    jobRepo = new InMemoryJobRepository();

    const customer = await createCustomer(
      { tenantId: TENANT, firstName: 'Acme', lastName: 'Corp', createdBy: EXECUTOR },
      customerRepo,
    );
    realCustomerId = customer.id;
    const location = await createLocation(
      {
        tenantId: TENANT,
        customerId: realCustomerId,
        street1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        isPrimary: true,
      },
      locationRepo,
    );
    const job = await createJob(
      {
        tenantId: TENANT,
        customerId: realCustomerId,
        locationId: location.id,
        summary: 'Water heater',
        createdBy: EXECUTOR,
      },
      jobRepo,
    );
    realJobId = job.id;

    handler = new CreateInvoiceExecutionHandler(
      invoiceRepo,
      seededSettings(),
      new InMemoryAuditRepository(),
      jobRepo,
      locationRepo,
      customerRepo,
    );
  });

  it('the RFC example uuid passes format validation — proving format alone is insufficient', () => {
    const result = validateProposalPayload('draft_invoice', {
      customerId: RFC_EXAMPLE_UUID,
      jobId: RFC_EXAMPLE_UUID,
      lineItems: LINE_ITEMS,
    });
    expect(result.valid).toBe(true);
  });

  // ── customerId ────────────────────────────────────────────────────────────
  it('rejects the RFC example uuid as customerId because no such customer exists', async () => {
    const result = await handler.execute(
      makeProposal({ customerId: RFC_EXAMPLE_UUID, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(RFC_EXAMPLE_UUID);
    expect(result.error).toMatch(/does not exist in this tenant/i);
    // Nothing was written on the way to the rejection — no invoice, and no
    // auto-opened job for the phantom customer.
    expect(await invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(await jobRepo.findByTenant(TENANT)).toHaveLength(1); // only the seeded one
  });

  it('rejects a well-formed customerId belonging to ANOTHER tenant (lookup is tenant-scoped)', async () => {
    const foreign = await createCustomer(
      { tenantId: OTHER_TENANT, firstName: 'Other', lastName: 'Tenant', createdBy: EXECUTOR },
      customerRepo,
    );

    const result = await handler.execute(
      makeProposal({ customerId: foreign.id, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/customer .* does not exist in this tenant/i);
    expect(await invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  // ── jobId ─────────────────────────────────────────────────────────────────
  it('rejects the RFC example uuid as jobId because no such job exists', async () => {
    const result = await handler.execute(
      makeProposal({
        customerId: realCustomerId,
        jobId: RFC_EXAMPLE_UUID,
        lineItems: LINE_ITEMS,
      }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(RFC_EXAMPLE_UUID);
    expect(result.error).toMatch(/job .* does not exist in this tenant/i);
    // The crux for jobId: a real customer + a fake job must NOT silently fall
    // through to the auto-open path and must NOT write an invoice.
    expect(await invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('rejects a well-formed jobId belonging to ANOTHER tenant', async () => {
    const foreignCustomer = await createCustomer(
      { tenantId: OTHER_TENANT, firstName: 'Other', lastName: 'Tenant', createdBy: EXECUTOR },
      customerRepo,
    );
    const foreignLocation = await createLocation(
      {
        tenantId: OTHER_TENANT,
        customerId: foreignCustomer.id,
        street1: '9 Elsewhere Rd',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        isPrimary: true,
      },
      locationRepo,
    );
    const foreignJob = await createJob(
      {
        tenantId: OTHER_TENANT,
        customerId: foreignCustomer.id,
        locationId: foreignLocation.id,
        summary: 'Someone else work',
        createdBy: EXECUTOR,
      },
      jobRepo,
    );

    const result = await handler.execute(
      makeProposal({
        customerId: realCustomerId,
        jobId: foreignJob.id,
        lineItems: LINE_ITEMS,
      }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/job .* does not exist in this tenant/i);
    expect(await invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  // ── happy paths ───────────────────────────────────────────────────────────
  it('happy path — a real tenant customer + real job executes and persists', async () => {
    const result = await handler.execute(
      makeProposal({ customerId: realCustomerId, jobId: realJobId, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    const stored = await invoiceRepo.findById(TENANT, result.resultEntityId!);
    expect(stored).not.toBeNull();
    expect(stored!.jobId).toBe(realJobId);
    // No extra job opened — the drafted one was used.
    expect(await jobRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('happy path — a real customer with NO jobId auto-opens a job (B6 preserved)', async () => {
    // The jobId existence check must not break the deliberate customer-only
    // path: absence is legitimate, only fabrication is not.
    const result = await handler.execute(
      makeProposal({ customerId: realCustomerId, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    const jobs = await jobRepo.findByTenant(TENANT);
    expect(jobs).toHaveLength(2); // seeded + auto-opened
    const stored = await invoiceRepo.findById(TENANT, result.resultEntityId!);
    expect(stored!.jobId).not.toBe(realJobId);
  });

  it('an unresolved draft carrying only customerReference is refused, not guessed at', async () => {
    const result = await handler.execute(
      makeProposal({ customerReference: 'the Henderson place', lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/customerId/i);
    expect(await invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('stays inert when no customerRepo is wired (existing partial fixtures unchanged)', async () => {
    const unwired = new CreateInvoiceExecutionHandler(
      invoiceRepo,
      seededSettings(),
      new InMemoryAuditRepository(),
      // no jobRepo / locationRepo / customerRepo
    );

    const result = await unwired.execute(
      makeProposal({ customerId: RFC_EXAMPLE_UUID, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    // No repo to check against, so the handler falls through to its existing
    // behavior (here: job auto-creation is not configured).
    expect(result.error).not.toMatch(/does not exist in this tenant/i);
  });

  it('the PRODUCTION registry wires customerRepo, so the check is live end to end', async () => {
    // The estimate fix put this check behind an optional constructor param.
    // If createExecutionHandlerRegistry forgets to forward customerRepo the
    // guard is silently inert in production while every direct-construction
    // unit test above still passes — exactly this repo's defining failure
    // mode. So assert the REGISTRY, not a hand-built handler.
    const registry = createExecutionHandlerRegistry({
      invoiceRepo,
      settingsRepo: seededSettings(),
      auditRepo: new InMemoryAuditRepository(),
      jobRepo,
      locationRepo,
      customerRepo,
    });

    const result = await registry
      .get('draft_invoice')!
      .execute(makeProposal({ customerId: RFC_EXAMPLE_UUID, lineItems: LINE_ITEMS }), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist in this tenant/i);
  });
});
