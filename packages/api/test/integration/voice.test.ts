import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgVoiceRepository } from '../../src/voice/pg-voice';

describe('Postgres integration — voice', () => {
  let pool: Pool;
  let voiceRepo: PgVoiceRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    voiceRepo = new PgVoiceRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates voice recording and retrieves via findById', async () => {
      const recording = await voiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        conversationId: crypto.randomUUID(),
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
      const recording = await voiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
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
      const recording = await voiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
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