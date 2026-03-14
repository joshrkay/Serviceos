import {
  createEstimateRevision,
  markFinalApproved,
  getFinalApprovedRevision,
  InMemoryEstimateRevisionRepository,
} from '../../src/estimates/revision';
import { InMemoryDocumentRevisionRepository } from '../../src/ai/document-revision';

describe('P1-009C — Estimate revisions + final approved version', () => {
  let docRevisionRepo: InMemoryDocumentRevisionRepository;
  let estRevisionRepo: InMemoryEstimateRevisionRepository;

  beforeEach(() => {
    docRevisionRepo = new InMemoryDocumentRevisionRepository();
    estRevisionRepo = new InMemoryEstimateRevisionRepository();
  });

  it('happy path — creates estimate revision with auto-versioning', async () => {
    const { revision, info } = await createEstimateRevision(
      'tenant-1', 'est-1', { total: 10000, items: [] }, 'manual', 'user-1', 'owner',
      docRevisionRepo, estRevisionRepo
    );

    expect(revision.version).toBe(1);
    expect(info.isFinalApproved).toBe(false);

    const { revision: rev2 } = await createEstimateRevision(
      'tenant-1', 'est-1', { total: 15000, items: ['Part A'] }, 'ai_revised', 'ai', 'owner',
      docRevisionRepo, estRevisionRepo
    );

    expect(rev2.version).toBe(2);
  });

  it('happy path — marks final approved revision', async () => {
    const { info } = await createEstimateRevision(
      'tenant-1', 'est-1', { total: 10000 }, 'manual', 'user-1', 'owner',
      docRevisionRepo, estRevisionRepo
    );

    const marked = await markFinalApproved('tenant-1', 'est-1', info.revisionId, estRevisionRepo);
    expect(marked!.isFinalApproved).toBe(true);
  });

  it('happy path — retrieves final approved revision', async () => {
    const { info: info1 } = await createEstimateRevision(
      'tenant-1', 'est-1', { total: 10000 }, 'manual', 'user-1', 'owner',
      docRevisionRepo, estRevisionRepo
    );
    const { info: info2 } = await createEstimateRevision(
      'tenant-1', 'est-1', { total: 12000 }, 'manual', 'user-1', 'owner',
      docRevisionRepo, estRevisionRepo
    );

    await markFinalApproved('tenant-1', 'est-1', info2.revisionId, estRevisionRepo);

    const final = await getFinalApprovedRevision('tenant-1', 'est-1', estRevisionRepo);
    expect(final).not.toBeNull();
    expect(final!.revisionId).toBe(info2.revisionId);
  });

  it('validation — only one final approved at a time', async () => {
    const { info: info1 } = await createEstimateRevision(
      'tenant-1', 'est-1', { total: 10000 }, 'manual', 'u-1', 'owner',
      docRevisionRepo, estRevisionRepo
    );
    const { info: info2 } = await createEstimateRevision(
      'tenant-1', 'est-1', { total: 12000 }, 'manual', 'u-1', 'owner',
      docRevisionRepo, estRevisionRepo
    );

    await markFinalApproved('tenant-1', 'est-1', info1.revisionId, estRevisionRepo);
    await markFinalApproved('tenant-1', 'est-1', info2.revisionId, estRevisionRepo);

    const revisions = await estRevisionRepo.findByEstimate('tenant-1', 'est-1');
    const finalCount = revisions.filter((r) => r.isFinalApproved).length;
    expect(finalCount).toBe(1);
  });
});
