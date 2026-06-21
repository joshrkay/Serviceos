import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

describe('Postgres integration — settings', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // tenant_settings has UNIQUE(tenant_id), so each test creates its own
  // tenant to avoid duplicate-key conflicts when multiple tests in the
  // suite each call settingsRepo.create().
  describe('CRUD', () => {
    it('creates settings and retrieves via findByTenant', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Test Business',
        businessPhone: '555-1234',
        businessEmail: 'test@business.com',
        timezone: 'America/Chicago',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      const found = await settingsRepo.findByTenant(tenant.tenantId);
      expect(found).not.toBeNull();
      expect(found!.businessName).toBe('Test Business');
      expect(found!.timezone).toBe('America/Chicago');
    });

    it('defaults reminder offsets to [24] and normalizes on update (Story 10.2)', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Cadence Co',
        timezone: 'UTC',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      // DB default column value.
      const created = await settingsRepo.findByTenant(tenant.tenantId);
      expect(created!.appointmentReminderOffsetsHours).toEqual([24]);

      // Update normalizes: dedupe + clamp + sort descending.
      const updated = await settingsRepo.update(tenant.tenantId, {
        appointmentReminderOffsetsHours: [2, 24, 24, 0, 9999],
      });
      expect(updated!.appointmentReminderOffsetsHours).toEqual([24, 2]);

      const found = await settingsRepo.findByTenant(tenant.tenantId);
      expect(found!.appointmentReminderOffsetsHours).toEqual([24, 2]);
    });

    it('updates settings and reflects in findByTenant', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Original Name',
        timezone: 'America/New_York',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      const updated = await settingsRepo.update(tenant.tenantId, {
        businessName: 'Updated Name',
        timezone: 'America/Los_Angeles',
      });

      expect(updated).not.toBeNull();
      expect(updated!.businessName).toBe('Updated Name');
      expect(updated!.timezone).toBe('America/Los_Angeles');

      const found = await settingsRepo.findByTenant(tenant.tenantId);
      expect(found!.businessName).toBe('Updated Name');
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const tenant = await createTestTenant(pool);
      const otherTenant = await createTestTenant(pool);
      const found = await settingsRepo.findByTenant(otherTenant.tenantId);
      expect(found).toBeNull();
    });
  });

  describe('voice-agent binding columns (migration 147)', () => {
    it('projects voice_id + vapi_assistant_id onto TenantSettings (real columns)', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Voice Co',
        timezone: 'America/New_York',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      // Unset on a fresh row → undefined (NULL → undefined convention).
      const fresh = await settingsRepo.findByTenant(tenant.tenantId);
      expect(fresh!.voiceId).toBeUndefined();
      expect(fresh!.vapiAssistantId).toBeUndefined();

      // The provisioning / voice-config paths write these via raw SQL. Once
      // set, findByTenant must surface them — this pins the real column names
      // through SELECT * + mapRow: a wrong column name would still read as
      // undefined here even after the UPDATE (the entity-resolver lesson).
      await pool.query(
        `UPDATE tenant_settings SET voice_id = $1, vapi_assistant_id = $2 WHERE tenant_id = $3`,
        ['adam', 'asst_real_123', tenant.tenantId],
      );
      const bound = await settingsRepo.findByTenant(tenant.tenantId);
      expect(bound!.voiceId).toBe('adam');
      expect(bound!.vapiAssistantId).toBe('asst_real_123');
    });
  });

  describe('speed-to-lead settings (migration 205)', () => {
    it('round-trips speed_to_lead_enabled + template through update/find (real columns)', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Lead Co',
        timezone: 'America/New_York',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      // Opt-in default: OFF, template unset.
      const fresh = await settingsRepo.findByTenant(tenant.tenantId);
      expect(fresh!.speedToLeadEnabled).toBe(false);
      expect(fresh!.speedToLeadTemplate).toBeUndefined();

      await settingsRepo.update(tenant.tenantId, {
        speedToLeadEnabled: true,
        speedToLeadTemplate: 'Hi {first_name}, {business_name} here.',
      });
      const updated = await settingsRepo.findByTenant(tenant.tenantId);
      expect(updated!.speedToLeadEnabled).toBe(true);
      expect(updated!.speedToLeadTemplate).toBe('Hi {first_name}, {business_name} here.');
    });
  });
});
