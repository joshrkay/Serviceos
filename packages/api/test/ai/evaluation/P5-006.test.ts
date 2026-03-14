import {
  createInvoiceProvenance,
  validateInvoiceProvenanceInput,
  InMemoryInvoiceProvenanceRepository,
  InvoiceSourceType,
} from '../../../src/ai/evaluation/invoice-provenance';

describe('P5-006 — Invoice provenance metadata', () => {
  let repo: InMemoryInvoiceProvenanceRepository;

  const tenantId = 'tenant-1';

  beforeEach(() => {
    repo = new InMemoryInvoiceProvenanceRepository();
  });

  it('happy path — creates provenance with job source', async () => {
    const provenance = await createInvoiceProvenance({
      tenantId,
      invoiceId: 'inv-1',
      sourceType: 'job',
      creatorId: 'user-1',
      creatorRole: 'owner',
    }, repo);

    expect(provenance.id).toBeTruthy();
    expect(provenance.sourceType).toBe('job');
    expect(provenance.tenantId).toBe(tenantId);
  });

  it('happy path — creates provenance with estimate source', async () => {
    const provenance = await createInvoiceProvenance({
      tenantId,
      invoiceId: 'inv-2',
      sourceType: 'estimate',
      creatorId: 'user-1',
      creatorRole: 'owner',
      estimateId: 'est-1',
    }, repo);

    expect(provenance.sourceType).toBe('estimate');
    expect(provenance.estimateId).toBe('est-1');
  });

  it('happy path — creates provenance with conversation source', async () => {
    const provenance = await createInvoiceProvenance({
      tenantId,
      invoiceId: 'inv-3',
      sourceType: 'conversation',
      creatorId: 'ai-system',
      creatorRole: 'system',
      aiRunId: 'run-1',
      conversationId: 'conv-1',
    }, repo);

    expect(provenance.sourceType).toBe('conversation');
    expect(provenance.aiRunId).toBe('run-1');
    expect(provenance.conversationId).toBe('conv-1');
  });

  it('happy path — creates provenance with manual source', async () => {
    const provenance = await createInvoiceProvenance({
      tenantId,
      invoiceId: 'inv-4',
      sourceType: 'manual',
      creatorId: 'user-1',
      creatorRole: 'dispatcher',
    }, repo);

    expect(provenance.sourceType).toBe('manual');
  });

  it('validation — required fields', () => {
    const errors = validateInvoiceProvenanceInput({
      tenantId: '',
      invoiceId: '',
      sourceType: '' as InvoiceSourceType,
      creatorId: '',
      creatorRole: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('invoiceId is required');
    expect(errors).toContain('sourceType is required');
    expect(errors).toContain('creatorId is required');
    expect(errors).toContain('creatorRole is required');
  });

  it('validation — invalid sourceType', () => {
    const errors = validateInvoiceProvenanceInput({
      tenantId: 'tenant-1',
      invoiceId: 'inv-1',
      sourceType: 'invalid' as InvoiceSourceType,
      creatorId: 'user-1',
      creatorRole: 'owner',
    });
    expect(errors).toContain('Invalid sourceType');
  });

  it('tenant isolation — cross-tenant lookup returns null', async () => {
    await createInvoiceProvenance({
      tenantId,
      invoiceId: 'inv-1',
      sourceType: 'job',
      creatorId: 'user-1',
      creatorRole: 'owner',
    }, repo);

    const found = await repo.findByInvoice('tenant-2', 'inv-1');
    expect(found).toBeNull();
  });

  it('tenant isolation — findByTenant filters correctly', async () => {
    await createInvoiceProvenance({
      tenantId: 'tenant-1',
      invoiceId: 'inv-1',
      sourceType: 'job',
      creatorId: 'user-1',
      creatorRole: 'owner',
    }, repo);

    await createInvoiceProvenance({
      tenantId: 'tenant-2',
      invoiceId: 'inv-2',
      sourceType: 'manual',
      creatorId: 'user-2',
      creatorRole: 'owner',
    }, repo);

    const t1Records = await repo.findByTenant('tenant-1');
    expect(t1Records).toHaveLength(1);
    expect(t1Records[0].invoiceId).toBe('inv-1');
  });
});
