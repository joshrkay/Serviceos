import {
  createInvoiceRevision,
  markInvoiceFinalApproved,
  getInvoiceFinalApprovedRevision,
  InMemoryInvoiceRevisionRepository,
} from '../../../src/ai/evaluation/invoice-revision';
import {
  InMemoryDocumentRevisionRepository,
} from '../../../src/ai/document-revision';

describe('P5-007 — Invoice revisions + final approved version', () => {
  let docRevisionRepo: InMemoryDocumentRevisionRepository;
  let invoiceRevisionRepo: InMemoryInvoiceRevisionRepository;

  const tenantId = 'tenant-1';
  const invoiceId = 'inv-1';

  beforeEach(() => {
    docRevisionRepo = new InMemoryDocumentRevisionRepository();
    invoiceRevisionRepo = new InMemoryInvoiceRevisionRepository();
  });

  it('happy path — creates revision linked to document revision', async () => {
    const { revision, info } = await createInvoiceRevision(
      tenantId,
      invoiceId,
      { lineItems: [] },
      'manual',
      'user-1',
      'owner',
      docRevisionRepo,
      invoiceRevisionRepo
    );

    expect(revision.id).toBeTruthy();
    expect(revision.tenantId).toBe(tenantId);
    expect(revision.documentType).toBe('invoice');
    expect(revision.documentId).toBe(invoiceId);
    expect(revision.version).toBe(1);

    expect(info.id).toBeTruthy();
    expect(info.tenantId).toBe(tenantId);
    expect(info.invoiceId).toBe(invoiceId);
    expect(info.revisionId).toBe(revision.id);
    expect(info.isFinalApproved).toBe(false);
  });

  it('markFinalApproved sets flag', async () => {
    const { info } = await createInvoiceRevision(
      tenantId,
      invoiceId,
      { lineItems: [] },
      'manual',
      'user-1',
      'owner',
      docRevisionRepo,
      invoiceRevisionRepo
    );

    const result = await markInvoiceFinalApproved(
      tenantId,
      invoiceId,
      info.revisionId,
      invoiceRevisionRepo
    );

    expect(result).not.toBeNull();
    expect(result!.isFinalApproved).toBe(true);
    expect(result!.revisionId).toBe(info.revisionId);
  });

  it('getFinalApproved returns correct revision', async () => {
    const { info } = await createInvoiceRevision(
      tenantId,
      invoiceId,
      { lineItems: [] },
      'manual',
      'user-1',
      'owner',
      docRevisionRepo,
      invoiceRevisionRepo
    );

    await markInvoiceFinalApproved(tenantId, invoiceId, info.revisionId, invoiceRevisionRepo);

    const finalApproved = await getInvoiceFinalApprovedRevision(
      tenantId,
      invoiceId,
      invoiceRevisionRepo
    );

    expect(finalApproved).not.toBeNull();
    expect(finalApproved!.revisionId).toBe(info.revisionId);
    expect(finalApproved!.isFinalApproved).toBe(true);
  });

  it('only one final approved at a time', async () => {
    const { info: info1 } = await createInvoiceRevision(
      tenantId,
      invoiceId,
      { lineItems: [] },
      'manual',
      'user-1',
      'owner',
      docRevisionRepo,
      invoiceRevisionRepo
    );

    const { info: info2 } = await createInvoiceRevision(
      tenantId,
      invoiceId,
      { lineItems: [{ id: 'li-1' }] },
      'ai_revised',
      'user-1',
      'owner',
      docRevisionRepo,
      invoiceRevisionRepo
    );

    await markInvoiceFinalApproved(tenantId, invoiceId, info1.revisionId, invoiceRevisionRepo);
    await markInvoiceFinalApproved(tenantId, invoiceId, info2.revisionId, invoiceRevisionRepo);

    const finalApproved = await getInvoiceFinalApprovedRevision(
      tenantId,
      invoiceId,
      invoiceRevisionRepo
    );

    expect(finalApproved).not.toBeNull();
    expect(finalApproved!.revisionId).toBe(info2.revisionId);

    // Verify first revision is no longer final approved
    const allRevisions = await invoiceRevisionRepo.findByInvoice(tenantId, invoiceId);
    const firstRevision = allRevisions.find((r) => r.revisionId === info1.revisionId);
    expect(firstRevision!.isFinalApproved).toBe(false);
  });

  it('validation — markFinalApproved returns null for non-existent revision', async () => {
    const result = await markInvoiceFinalApproved(
      tenantId,
      invoiceId,
      'non-existent-revision',
      invoiceRevisionRepo
    );

    expect(result).toBeNull();
  });

  it('tenant isolation — cross-tenant lookup returns empty', async () => {
    await createInvoiceRevision(
      tenantId,
      invoiceId,
      { lineItems: [] },
      'manual',
      'user-1',
      'owner',
      docRevisionRepo,
      invoiceRevisionRepo
    );

    const crossTenantRevisions = await invoiceRevisionRepo.findByInvoice('tenant-2', invoiceId);
    expect(crossTenantRevisions).toHaveLength(0);
  });
});
