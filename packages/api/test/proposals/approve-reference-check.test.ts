/**
 * QA 2026-09-16 (matrix row AST-04) — belt and braces under the drafting
 * gates. approveProposal blocked ONLY on missingFields, so a proposal whose
 * invoiceId named a JOB (a real UUID, wrong entity) approved and then died at
 * execution with "Invoice not found". The drafting handler now checks what a
 * UUID names, but approval is the last human-visible seam: an approvable
 * proposal must also be an executable one (D-029). A reference check that
 * finds no such record refuses approval the same way an unfilled gate does,
 * so the review card's edit path takes over instead of a dead end.
 */
import { describe, it, expect } from 'vitest';
import { approveProposal, approveChainSet } from '../../src/proposals/actions';
import {
  InMemoryProposalRepository,
  createProposal,
  type CreateProposalInput,
} from '../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { buildInvoice } from '../factories/invoice.factory';
import {
  invoiceReferenceCheck,
  serviceLocationReferenceCheck,
  executionAnchorReferenceCheck,
  jobReferenceCheck,
  describeDanglingReferences,
  askForExecutabilityGaps,
  holdForExecutability,
} from '../../src/proposals/approval-reference-checks';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryLocationRepository, createLocation } from '../../src/locations/location';
import { buildChainRefToken } from '../../src/proposals/chain';
import { ValidationError } from '../../src/shared/errors';

const tenantId = 'tenant-ast04';
const actorId = 'user-ast04';
const JOB_ID = 'c73844bd-4928-4d1f-b8c5-f669ceb10018';
const INVOICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function sendInvoiceInput(invoiceId: string): CreateProposalInput {
  return {
    tenantId,
    proposalType: 'send_invoice',
    payload: { channel: 'sms', invoiceId },
    summary: 'Send the invoice by text',
    createdBy: actorId,
  };
}

describe('approveProposal — approval-time reference check (AST-04 belt and braces)', () => {
  it('refuses a send_invoice whose invoiceId names no invoice for the tenant, as an unfilled invoiceId gate', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(sendInvoiceInput(JOB_ID));
    await repo.create(proposal);
    const invoiceRepo = new InMemoryInvoiceRepository(); // the "invoice" is a job id — nothing here

    const attempt = approveProposal(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'ui', {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo)],
    });
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toMatchObject({ details: { missingFields: ['invoiceId'] } });
    // Untouched — still draft, still editable.
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('draft');
  });

  it('approves when the invoice exists for the tenant', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(sendInvoiceInput(INVOICE_ID));
    await repo.create(proposal);
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(buildInvoice({ id: INVOICE_ID, tenantId, jobId: JOB_ID }));

    const approved = await approveProposal(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'ui', {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo)],
    });
    expect(approved.status).toBe('approved');
  });

  // Codex review on PR #1311 — chained send_invoice tails carry a symbolic
  // reference until resolveChainReferences replaces it at execution time;
  // the check must not read that token as an id and refuse a legitimate chain.
  it('leaves a chain-reference token alone (it resolves at execution, not at approval)', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(sendInvoiceInput(buildChainRefToken(0, 'invoiceId')));
    await repo.create(proposal);
    const invoiceRepo = new InMemoryInvoiceRepository(); // nothing to find — and nothing should be looked up

    const approved = await approveProposal(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'ui', {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo)],
    });
    expect(approved.status).toBe('approved');
  });

  // Codex review on PR #1311 — the voice approval path goes through
  // approveChainSet, which must carry the same checks as the dashboard route.
  it('approveChainSet applies the reference checks to the head it approves', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(sendInvoiceInput(JOB_ID)); // not chained → approveChainSet approves the head directly
    await repo.create(proposal);
    const invoiceRepo = new InMemoryInvoiceRepository();

    const attempt = approveChainSet(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'voice', undefined, {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo)],
    });
    await expect(attempt).rejects.toMatchObject({ details: { missingFields: ['invoiceId'] } });
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('draft');
  });
});

// #1271 — a resolved draft_estimate / draft_invoice with no jobId makes the
// executor open a job at the customer's service location, and fails
// "Customer has no service location — add one before approving this
// estimate" when there is none. That is a precondition the executor itself
// calls a pre-approval check, so approval refuses it up front (D-029).
describe('approveProposal — service-location reference check (#1271)', () => {
  const CUSTOMER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  function estimateInput(payload: Record<string, unknown>): CreateProposalInput {
    return {
      tenantId,
      proposalType: 'draft_estimate',
      payload: {
        customerId: CUSTOMER_ID,
        lineItems: [{ description: 'Water heater install', quantity: 1, unitPriceCents: 117000 }],
        ...payload,
      },
      summary: 'Estimate for the water heater',
      createdBy: actorId,
    };
  }

  async function approveWith(proposalInput: CreateProposalInput, locationRepo: InMemoryLocationRepository) {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(proposalInput);
    await repo.create(proposal);
    const attempt = approveProposal(repo, tenantId, proposal.id, actorId, 'owner', undefined, 'ui', {
      referenceChecks: [serviceLocationReferenceCheck(locationRepo)],
    });
    return { repo, proposal, attempt };
  }

  it('refuses a resolved draft_estimate whose customer has no service location, as a locationId gate', async () => {
    const { repo, proposal, attempt } = await approveWith(estimateInput({}), new InMemoryLocationRepository());
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toMatchObject({ details: { missingFields: ['locationId'] } });
    await expect(attempt).rejects.toThrow(/service location/i);
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('draft');
  });

  it('refuses a draft_invoice in the same shape (the invoice executor has the same precondition)', async () => {
    const { attempt } = await approveWith(
      { ...estimateInput({}), proposalType: 'draft_invoice' },
      new InMemoryLocationRepository(),
    );
    await expect(attempt).rejects.toMatchObject({ details: { missingFields: ['locationId'] } });
  });

  it('ignores an archived location — the executor does too', async () => {
    const locationRepo = new InMemoryLocationRepository();
    const loc = await createLocation(
      { tenantId, customerId: CUSTOMER_ID, street1: '456 Oak Ave', city: 'Phoenix', state: 'AZ', postalCode: '85002' },
      locationRepo,
    );
    await locationRepo.update(tenantId, loc.id, { isArchived: true });
    const { attempt } = await approveWith(estimateInput({}), locationRepo);
    await expect(attempt).rejects.toMatchObject({ details: { missingFields: ['locationId'] } });
  });

  it('does not apply when the draft already names a job (no job is opened, no location needed)', async () => {
    const { attempt } = await approveWith(estimateInput({ jobId: JOB_ID }), new InMemoryLocationRepository());
    await expect(attempt).resolves.toMatchObject({ status: 'approved' });
  });

  it('leaves a chained customer to execution (a create_customer head writes its location first)', async () => {
    const { attempt } = await approveWith(
      estimateInput({ customerId: buildChainRefToken(0, 'customerId') }),
      new InMemoryLocationRepository(),
    );
    await expect(attempt).resolves.toMatchObject({ status: 'approved' });
  });

  it('approves when the customer has a live service location', async () => {
    const locationRepo = new InMemoryLocationRepository();
    await createLocation(
      { tenantId, customerId: CUSTOMER_ID, street1: '456 Oak Ave', city: 'Phoenix', state: 'AZ', postalCode: '85002' },
      locationRepo,
    );
    const { attempt } = await approveWith(estimateInput({}), locationRepo);
    await expect(attempt).resolves.toMatchObject({ status: 'approved' });
  });
});

describe('#1480 — an estimate/invoice draft with no customer and no job is never approvable', () => {
  function invoiceDraft(payload: Record<string, unknown>): CreateProposalInput {
    return {
      tenantId,
      proposalType: 'draft_invoice',
      payload: {
        customerReference: 'the accepted estimate',
        lineItems: [{ description: 'Service', quantity: 1, unitPriceCents: 18000 }],
        ...payload,
      },
      summary: 'Invoice from the accepted estimate',
      createdBy: actorId,
    };
  }

  async function approveDraft(input: CreateProposalInput) {
    const repo = new InMemoryProposalRepository();
    const draft = createProposal(input);
    await repo.create(draft);
    return approveProposal(repo, tenantId, draft.id, actorId, 'owner', undefined, 'ui', {
      referenceChecks: [executionAnchorReferenceCheck()],
    });
  }

  it('refuses a draft_invoice that carries only an estimateId, gated on customerId', async () => {
    await expect(
      approveDraft(invoiceDraft({ estimateId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })),
    ).rejects.toMatchObject({ details: { missingFields: ['customerId'] } });
  });

  it('approves the same draft once it names a job', async () => {
    await expect(approveDraft(invoiceDraft({ jobId: JOB_ID }))).resolves.toMatchObject({
      status: 'approved',
    });
  });
});


// OVAS-03 — no check looked at a drafted jobId at all: a fabricated uuid, a
// foreign tenant's job, or a job of a different customer than the card's
// approved (or auto-approved) and then failed, or attached the document to
// the wrong customer, after the tap.
describe('jobReferenceCheck — a drafted jobId must name this tenant\'s job, of the card\'s customer', () => {
  const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const OTHER_CUSTOMER = '8d0f7780-8536-41ef-a55c-f18ad2a01bf8';
  const RFC_EXAMPLE = '123e4567-e89b-12d3-a456-426614174000';

  async function jobs(): Promise<InMemoryJobRepository> {
    const repo = new InMemoryJobRepository();
    const base: Omit<Job, 'id' | 'tenantId' | 'customerId'> = {
      locationId: 'loc-1',
      jobNumber: 'JOB-1',
      summary: 'AC repair',
      status: 'scheduled',
      priority: 'normal',
      createdBy: actorId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await repo.create({ ...base, id: JOB_ID, tenantId, customerId: CUSTOMER } as Job);
    await repo.create({
      ...base,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: 'tenant-elsewhere',
      customerId: CUSTOMER,
    } as Job);
    return repo;
  }

  function proposalOf(proposalType: CreateProposalInput['proposalType'], payload: Record<string, unknown>) {
    return createProposal({ tenantId, proposalType, payload, summary: 's', createdBy: actorId });
  }

  for (const type of ['draft_estimate', 'draft_invoice', 'create_appointment'] as const) {
    it(`${type}: a jobId naming no job is a jobId gap`, async () => {
      const check = jobReferenceCheck(await jobs());
      expect(await check(tenantId, proposalOf(type, { customerId: CUSTOMER, jobId: RFC_EXAMPLE }))).toEqual(['jobId']);
    });

    it(`${type}: another tenant's job is a jobId gap`, async () => {
      const check = jobReferenceCheck(await jobs());
      expect(
        await check(tenantId, proposalOf(type, { customerId: CUSTOMER, jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
      ).toEqual(['jobId']);
    });

    it(`${type}: a different customer's job is a mismatch gap`, async () => {
      const check = jobReferenceCheck(await jobs());
      expect(await check(tenantId, proposalOf(type, { customerId: OTHER_CUSTOMER, jobId: JOB_ID }))).toEqual([
        'jobCustomerMismatch',
      ]);
    });

    it(`${type}: the customer's own job (or a job with no customer named) passes`, async () => {
      const check = jobReferenceCheck(await jobs());
      expect(await check(tenantId, proposalOf(type, { customerId: CUSTOMER, jobId: JOB_ID }))).toEqual([]);
      expect(await check(tenantId, proposalOf(type, { jobId: JOB_ID }))).toEqual([]);
    });
  }

  it('create_appointment checks linkedJobId (the job a revisit books against) when present', async () => {
    const check = jobReferenceCheck(await jobs());
    expect(
      await check(tenantId, proposalOf('create_appointment', { customerId: CUSTOMER, linkedJobId: RFC_EXAMPLE })),
    ).toEqual(['linkedJobId']);
  });

  it('ignores other types, an absent jobId, and an unresolved chain token', async () => {
    const check = jobReferenceCheck(await jobs());
    expect(await check(tenantId, proposalOf('update_job', { jobId: RFC_EXAMPLE, status: 'completed' }))).toEqual([]);
    expect(await check(tenantId, proposalOf('draft_estimate', { customerId: CUSTOMER }))).toEqual([]);
    expect(
      await check(tenantId, proposalOf('draft_estimate', { jobId: buildChainRefToken(0, 'jobId') })),
    ).toEqual([]);
  });

  it('an auto-approved draft with a dangling job is held, and approval refuses it with a sentence', async () => {
    const check = jobReferenceCheck(await jobs());
    const proposal = {
      ...proposalOf('draft_estimate', { customerId: OTHER_CUSTOMER, jobId: JOB_ID }),
      status: 'approved' as const,
    };
    const held = await holdForExecutability(tenantId, proposal, [check]);
    expect(held.proposal.status).toBe('ready_for_review');
    expect(held.gaps).toEqual(['jobCustomerMismatch']);
    expect(describeDanglingReferences(held.gaps)).toMatch(/different customer/);
    expect(askForExecutabilityGaps(held.gaps)).toMatch(/different customer/);
    expect(askForExecutabilityGaps(held.gaps)).not.toMatch(/does not name an existing record/);
  });
});
