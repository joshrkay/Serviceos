import {
  createRevision,
  validateRevisionInput,
  InMemoryDocumentRevisionRepository,
} from '../../src/ai/document-revision';

describe('P0-017 — Document revision storage foundation', () => {
  let repo: InMemoryDocumentRevisionRepository;

  beforeEach(() => {
    repo = new InMemoryDocumentRevisionRepository();
  });

  it('happy path — creates revision with auto-incrementing version', async () => {
    const rev1 = await createRevision(
      {
        tenantId: 'tenant-1',
        documentType: 'estimate',
        documentId: 'est-1',
        snapshot: { total: 100, items: [] },
        source: 'manual',
        actorId: 'user-1',
        actorRole: 'owner',
      },
      repo
    );

    expect(rev1.id).toBeTruthy();
    expect(rev1.version).toBe(1);

    const rev2 = await createRevision(
      {
        tenantId: 'tenant-1',
        documentType: 'estimate',
        documentId: 'est-1',
        snapshot: { total: 150, items: [{ name: 'Part A', cost: 50 }] },
        source: 'ai_revised',
        actorId: 'ai-system',
        actorRole: 'owner',
        aiRunId: 'run-1',
      },
      repo
    );

    expect(rev2.version).toBe(2);
  });

  it('happy path — retrieves revisions by document', async () => {
    await createRevision(
      {
        tenantId: 'tenant-1',
        documentType: 'invoice',
        documentId: 'inv-1',
        snapshot: { total: 200 },
        source: 'manual',
        actorId: 'user-1',
        actorRole: 'owner',
      },
      repo
    );
    await createRevision(
      {
        tenantId: 'tenant-1',
        documentType: 'invoice',
        documentId: 'inv-1',
        snapshot: { total: 250 },
        source: 'ai_generated',
        actorId: 'ai',
        actorRole: 'owner',
      },
      repo
    );

    const revisions = await repo.findByDocument('tenant-1', 'invoice', 'inv-1');
    expect(revisions).toHaveLength(2);
    expect(revisions[0].version).toBe(2); // Sorted desc
  });

  it('validation — rejects missing fields', () => {
    const errors = validateRevisionInput({
      tenantId: '',
      documentType: '' as any,
      documentId: '',
      snapshot: null as any,
      source: '' as any,
      actorId: '',
      actorRole: '',
    });
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it('validation — rejects invalid documentType', () => {
    const errors = validateRevisionInput({
      tenantId: 'tenant-1',
      documentType: 'receipt' as any,
      documentId: 'r-1',
      snapshot: {},
      source: 'manual',
      actorId: 'user-1',
      actorRole: 'owner',
    });
    expect(errors).toContain('Invalid documentType');
  });

  it('mock provider test — tenant isolation on findById', async () => {
    const rev = await createRevision(
      {
        tenantId: 'tenant-1',
        documentType: 'estimate',
        documentId: 'est-1',
        snapshot: {},
        source: 'manual',
        actorId: 'user-1',
        actorRole: 'owner',
      },
      repo
    );

    const found = await repo.findById('other-tenant', rev.id);
    expect(found).toBeNull();
  });

  it('malformed AI output handled gracefully — empty snapshot is valid object', async () => {
    const rev = await createRevision(
      {
        tenantId: 'tenant-1',
        documentType: 'proposal',
        documentId: 'prop-1',
        snapshot: {},
        source: 'ai_generated',
        actorId: 'ai',
        actorRole: 'owner',
      },
      repo
    );
    expect(rev.snapshot).toEqual({});
  });
});
