import { draftInvoicePayloadSchema, validateProposalPayload } from '../../src/proposals/contracts';
import { createProposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import { isValidInvoiceProposalPayload } from '../../src/invoices/invoice-proposal';

describe('P5-001 — draft_invoice proposal contract', () => {
  let repo: InMemoryProposalRepository;

  const validPayload = {
    customerId: '00000000-0000-0000-0000-000000000001',
    jobId: '00000000-0000-0000-0000-000000000002',
    lineItems: [
      { description: 'AC Repair', quantity: 2, unitPrice: 7500, category: 'labor' },
      { description: 'Filter replacement', quantity: 1, unitPrice: 3000 },
    ],
    discountCents: 500,
    taxRateBps: 825,
    customerMessage: 'Thank you for your business',
  };

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
  });

  it('happy path — valid payload passes schema validation', () => {
    const result = draftInvoicePayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('happy path — valid payload passes validateProposalPayload', () => {
    const result = validateProposalPayload('draft_invoice', validPayload);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('happy path — creates proposal with draft_invoice type', async () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'draft_invoice',
      payload: validPayload,
      summary: 'Invoice for AC repair job',
      createdBy: 'user-1',
    });

    expect(proposal.proposalType).toBe('draft_invoice');
    expect(proposal.status).toBe('draft');
    expect(proposal.tenantId).toBe('tenant-1');

    const stored = await repo.create(proposal);
    expect(stored.id).toBe(proposal.id);
  });

  it('happy path — optional fields are accepted', () => {
    const payloadWithOptionals = {
      ...validPayload,
      estimateId: '00000000-0000-0000-0000-000000000003',
      invoiceNumber: 'INV-0001',
      internalNotes: 'Rush job',
    };
    const result = draftInvoicePayloadSchema.safeParse(payloadWithOptionals);
    expect(result.success).toBe(true);
  });

  it('validation — rejects missing lineItems', () => {
    const { lineItems, ...noItems } = validPayload;
    const result = validateProposalPayload('draft_invoice', noItems);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes('lineItems'))).toBe(true);
  });

  it('validation — rejects empty lineItems array', () => {
    const result = validateProposalPayload('draft_invoice', { ...validPayload, lineItems: [] });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('lineItems'))).toBe(true);
  });

  it('validation — rejects invalid customerId UUID', () => {
    const result = validateProposalPayload('draft_invoice', { ...validPayload, customerId: 'not-a-uuid' });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('customerId'))).toBe(true);
  });

  it('validation — rejects invalid jobId UUID', () => {
    const result = validateProposalPayload('draft_invoice', { ...validPayload, jobId: 'not-a-uuid' });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('jobId'))).toBe(true);
  });

  it('validation — rejects negative discountCents', () => {
    const result = validateProposalPayload('draft_invoice', { ...validPayload, discountCents: -100 });
    expect(result.valid).toBe(false);
  });

  it('validation — rejects taxRateBps exceeding 10000', () => {
    const result = validateProposalPayload('draft_invoice', { ...validPayload, taxRateBps: 15000 });
    expect(result.valid).toBe(false);
  });

  it('tenant isolation — proposal created with correct tenantId', async () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'draft_invoice',
      payload: validPayload,
      summary: 'Invoice for AC repair',
      createdBy: 'user-1',
    });
    await repo.create(proposal);

    const found = await repo.findById('tenant-1', proposal.id);
    expect(found).not.toBeNull();

    const crossTenant = await repo.findById('tenant-2', proposal.id);
    expect(crossTenant).toBeNull();
  });

  it('malformed AI output — completely invalid payload rejected', () => {
    const result = validateProposalPayload('draft_invoice', { garbage: true });
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('malformed AI output — null payload rejected', () => {
    const result = validateProposalPayload('draft_invoice', null);
    expect(result.valid).toBe(false);
  });

  it('malformed AI output — string payload rejected', () => {
    const result = validateProposalPayload('draft_invoice', 'not an object');
    expect(result.valid).toBe(false);
  });

  it('type guard — isValidInvoiceProposalPayload works correctly', () => {
    expect(isValidInvoiceProposalPayload(validPayload)).toBe(true);
    expect(isValidInvoiceProposalPayload({})).toBe(false);
    expect(isValidInvoiceProposalPayload(null)).toBe(false);
    expect(isValidInvoiceProposalPayload({ customerId: 'x', jobId: 'y', lineItems: [] })).toBe(false);
  });

  it('mock provider — InMemory repo stores and retrieves proposal correctly', async () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'draft_invoice',
      payload: validPayload,
      summary: 'Test invoice',
      createdBy: 'user-1',
    });
    await repo.create(proposal);

    const found = await repo.findById('tenant-1', proposal.id);
    expect(found).not.toBeNull();
    expect(found!.proposalType).toBe('draft_invoice');
    expect(found!.payload).toEqual(validPayload);
  });
});
