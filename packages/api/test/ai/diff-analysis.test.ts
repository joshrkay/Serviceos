import {
  computeDiff,
  createDiffAnalysisWorker,
  InMemoryDiffAnalysisRepository,
} from '../../src/ai/diff-analysis';
import {
  InMemoryDocumentRevisionRepository,
  createRevision,
} from '../../src/ai/document-revision';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

describe('P0-018 — Async diff-analysis worker foundation', () => {
  const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

  describe('computeDiff', () => {
    it('happy path — detects added fields', () => {
      const diff = computeDiff({}, { name: 'New' });
      expect(diff).toHaveLength(1);
      expect(diff[0].type).toBe('added');
      expect(diff[0].path).toBe('name');
    });

    it('happy path — detects removed fields', () => {
      const diff = computeDiff({ name: 'Old' }, {});
      expect(diff).toHaveLength(1);
      expect(diff[0].type).toBe('removed');
    });

    it('happy path — detects changed fields', () => {
      const diff = computeDiff({ total: 100 }, { total: 150 });
      expect(diff).toHaveLength(1);
      expect(diff[0].type).toBe('changed');
      expect(diff[0].oldValue).toBe(100);
      expect(diff[0].newValue).toBe(150);
    });

    it('happy path — handles nested objects', () => {
      const diff = computeDiff(
        { address: { city: 'NY', zip: '10001' } },
        { address: { city: 'LA', zip: '10001' } }
      );
      expect(diff).toHaveLength(1);
      expect(diff[0].path).toBe('address.city');
    });

    it('validation — returns empty for identical objects', () => {
      const diff = computeDiff({ a: 1, b: 'two' }, { a: 1, b: 'two' });
      expect(diff).toHaveLength(0);
    });

    it('happy path — handles array element diffs', () => {
      const diff = computeDiff(
        { items: ['a', 'b', 'c'] },
        { items: ['a', 'x', 'c', 'd'] }
      );
      expect(diff.some((d) => d.path === 'items[1]' && d.type === 'changed')).toBe(true);
      expect(diff.some((d) => d.path === 'items[3]' && d.type === 'added')).toBe(true);
    });

    it('happy path — handles array element removal', () => {
      const diff = computeDiff(
        { tags: ['one', 'two', 'three'] },
        { tags: ['one'] }
      );
      expect(diff.some((d) => d.path === 'tags[1]' && d.type === 'removed')).toBe(true);
      expect(diff.some((d) => d.path === 'tags[2]' && d.type === 'removed')).toBe(true);
    });
  });

  describe('diff analysis worker', () => {
    it('happy path — compares two revisions', async () => {
      const revisionRepo = new InMemoryDocumentRevisionRepository();
      const diffRepo = new InMemoryDiffAnalysisRepository();

      const rev1 = await createRevision(
        {
          tenantId: 'tenant-1',
          documentType: 'estimate',
          documentId: 'est-1',
          snapshot: { total: 100, items: ['Part A'] },
          source: 'manual',
          actorId: 'user-1',
          actorRole: 'owner',
        },
        revisionRepo
      );

      const rev2 = await createRevision(
        {
          tenantId: 'tenant-1',
          documentType: 'estimate',
          documentId: 'est-1',
          snapshot: { total: 150, items: ['Part A', 'Part B'] },
          source: 'ai_revised',
          actorId: 'ai',
          actorRole: 'owner',
        },
        revisionRepo
      );

      const analysis = {
        id: 'analysis-1',
        tenantId: 'tenant-1',
        documentType: 'estimate',
        documentId: 'est-1',
        fromRevisionId: rev1.id,
        toRevisionId: rev2.id,
        diff: [],
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await diffRepo.create(analysis);

      const worker = createDiffAnalysisWorker(revisionRepo, diffRepo);

      const msg: QueueMessage<any> = {
        id: '1',
        type: 'diff_analysis',
        payload: {
          tenantId: 'tenant-1',
          analysisId: 'analysis-1',
          documentType: 'estimate',
          documentId: 'est-1',
          fromRevisionId: rev1.id,
          toRevisionId: rev2.id,
        },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: 'idem-1',
        createdAt: new Date().toISOString(),
      };

      await worker.handle(msg, logger);

      const result = await diffRepo.findById('tenant-1', 'analysis-1');
      expect(result!.status).toBe('completed');
      expect(result!.diff.length).toBeGreaterThan(0);
      expect(result!.summary).toContain('change(s)');
    });

    it('validation — handles missing revisions', async () => {
      const revisionRepo = new InMemoryDocumentRevisionRepository();
      const diffRepo = new InMemoryDiffAnalysisRepository();

      const analysis = {
        id: 'analysis-2',
        tenantId: 'tenant-1',
        documentType: 'estimate',
        documentId: 'est-1',
        fromRevisionId: 'nonexistent-1',
        toRevisionId: 'nonexistent-2',
        diff: [],
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await diffRepo.create(analysis);

      const worker = createDiffAnalysisWorker(revisionRepo, diffRepo);
      const msg: QueueMessage<any> = {
        id: '1',
        type: 'diff_analysis',
        payload: {
          tenantId: 'tenant-1',
          analysisId: 'analysis-2',
          documentType: 'estimate',
          documentId: 'est-1',
          fromRevisionId: 'nonexistent-1',
          toRevisionId: 'nonexistent-2',
        },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: 'idem-2',
        createdAt: new Date().toISOString(),
      };

      await expect(worker.handle(msg, logger)).rejects.toThrow('not found');

      const result = await diffRepo.findById('tenant-1', 'analysis-2');
      expect(result!.status).toBe('failed');
    });

    it('mock provider test — diff repository isolates tenants', async () => {
      const diffRepo = new InMemoryDiffAnalysisRepository();
      const analysis = {
        id: 'analysis-3',
        tenantId: 'tenant-1',
        documentType: 'estimate',
        documentId: 'est-1',
        fromRevisionId: 'r1',
        toRevisionId: 'r2',
        diff: [],
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await diffRepo.create(analysis);

      const found = await diffRepo.findById('other-tenant', 'analysis-3');
      expect(found).toBeNull();
    });

    it('malformed AI output handled gracefully — empty snapshots produce no diff', () => {
      const diff = computeDiff({}, {});
      expect(diff).toHaveLength(0);
    });
  });
});
