import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, createTestFile, closeSharedTestDb } from './shared';
import { PgVoiceRepository } from '../../src/voice/pg-voice';

describe('Postgres integration — voice', () => {
  let pool: Pool;
  let voiceRepo: PgVoiceRepository;
  let tenant: { tenantId: string; userId: string };
  let sharedFileId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    voiceRepo = new PgVoiceRepository(pool);
    tenant = await createTestTenant(pool);

    // voice_recordings.file_id references files(id) — insert a shared
    // file row that all tests in this suite can reference.
    sharedFileId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO files (id, tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sharedFileId, tenant.tenantId, 'test.wav', 'audio/wav', 1000, 'test-bucket', 'voice/test.wav', tenant.userId]
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates voice recording and retrieves via findById', async () => {
      const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
      // conversationId is intentionally omitted: the FK target is the
      // conversations table, and seeding a conversation here is more
      // setup than the test needs to exercise voice_recordings CRUD.
      const recording = await voiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        fileId,
        status: 'pending',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await voiceRepo.findById(tenant.tenantId, recording.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('pending');
    });

    it('updates voice recording status', async () => {
      const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
      const recording = await voiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        fileId,
        status: 'pending',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await voiceRepo.updateStatus(
        tenant.tenantId,
        recording.id,
        'completed',
        { transcript: 'Hello, I need AC repair', metadata: { duration: 120 } }
      );

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.transcript).toBe('Hello, I need AC repair');
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
      const recording = await voiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        fileId,
        status: 'pending',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await voiceRepo.findById(otherTenant.tenantId, recording.id);
      expect(found).toBeNull();
    });
  });
});
