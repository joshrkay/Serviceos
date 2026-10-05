/**
 * Postgres integration — migration 304 after-hours voice-mode backfill
 * (#1595 / D-040: AI answering becomes the after-hours default).
 *
 * `after_hours_voice_mode` lives in the `tenant_settings.escalation_settings`
 * JSONB. The OLD default ('voicemail') was never written on its own — it was
 * materialised into a row as a side effect of two whole-blob writers:
 *
 *   - the Call Routing sheet, which PUTs the entire escalation blob on ANY
 *     toggle (audited as `settings.tenant.updated` with
 *     `changedKeys: ['escalationSettings']`), and
 *   - the voice-approval PIN routes, which re-write the blob with the PIN
 *     hash merged in (audited as `settings.voice_approval_pin.*`).
 *
 * The sheet is the only surface where an owner could CHOOSE voicemail, so
 * the backfill rule is: strip a stored 'voicemail' only from rows whose
 * tenant has NO Call Routing save in the audit trail — those rows can only
 * have been written by the old default. A tenant with at least one such
 * save may have chosen voicemail, so the value is kept. 'ai_answering' and
 * absent keys are never touched. Nothing is DROPped.
 *
 * Every assertion reads back through the public seam the /voice webhook
 * uses — `PgSettingsRepository.findByTenant` + `resolveEscalationSettings`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createAuditEvent } from '../../src/audit/audit';
import {
  resolveEscalationSettings,
  type EscalationSettings,
  type TenantSettings,
} from '../../src/settings/settings';
import { MIGRATIONS } from '../../src/db/schema';

const BACKFILL_SQL = MIGRATIONS['304_after_hours_voice_mode_default_backfill'];

/** The blob the pre-#1595 default spread into every whole-blob write. */
const OLD_DEFAULT_BLOB: EscalationSettings = {
  channel_sms: true,
  channel_in_app: true,
  channel_whisper: true,
  trigger_low_confidence: true,
  trigger_explicit_request: true,
  trigger_keyword_frustration: true,
  trigger_llm_sentiment: false,
  llm_sentiment_threshold: 0.7,
  after_hours_voice_mode: 'voicemail',
};

describe('Postgres integration — 304_after_hours_voice_mode_default_backfill', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedTenant(escalationSettings: Partial<EscalationSettings>): Promise<string> {
    const tenant = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Backfill Co',
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    await settingsRepo.update(tenant.tenantId, {
      escalationSettings: escalationSettings as TenantSettings['escalationSettings'],
    });
    return tenant.tenantId;
  }

  /** What PUT /api/settings records when the Call Routing sheet is saved. */
  async function recordCallRoutingSave(tenantId: string): Promise<void> {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: 'user_backfill_test',
        actorRole: 'owner',
        eventType: 'settings.tenant.updated',
        entityType: 'tenant_settings',
        entityId: 'settings',
        metadata: { changedKeys: ['escalationSettings'] },
      }),
    );
  }

  async function resolvedMode(tenantId: string): Promise<string | undefined> {
    const settings = await settingsRepo.findByTenant(tenantId);
    return resolveEscalationSettings(settings).after_hours_voice_mode;
  }

  it("strips a 'voicemail' the old default materialised (no Call Routing save), so the tenant now resolves to ai_answering", async () => {
    const tenantId = await seedTenant({
      ...OLD_DEFAULT_BLOB,
      // The PIN route is one such materialising writer; its credential must survive.
      voice_approval_pin_hash: 'deadbeef',
    });
    expect(await resolvedMode(tenantId)).toBe('voicemail');

    await pool.query(BACKFILL_SQL);

    expect(await resolvedMode(tenantId)).toBe('ai_answering');
    const after = resolveEscalationSettings(await settingsRepo.findByTenant(tenantId));
    expect(after.voice_approval_pin_hash).toBe('deadbeef');
    expect(after.llm_sentiment_threshold).toBe(0.7);
  });

  it("keeps 'voicemail' for a tenant who saved the Call Routing sheet (the only place voicemail could be chosen)", async () => {
    const tenantId = await seedTenant(OLD_DEFAULT_BLOB);
    await recordCallRoutingSave(tenantId);

    await pool.query(BACKFILL_SQL);

    expect(await resolvedMode(tenantId)).toBe('voicemail');
  });

  it("another tenant's Call Routing save does not protect this tenant's materialised 'voicemail'", async () => {
    const protectedTenant = await seedTenant(OLD_DEFAULT_BLOB);
    await recordCallRoutingSave(protectedTenant);
    const unprotectedTenant = await seedTenant(OLD_DEFAULT_BLOB);

    await pool.query(BACKFILL_SQL);

    expect(await resolvedMode(protectedTenant)).toBe('voicemail');
    expect(await resolvedMode(unprotectedTenant)).toBe('ai_answering');
  });

  it("leaves an explicit 'ai_answering' and an absent key alone", async () => {
    const explicitAi = await seedTenant({ ...OLD_DEFAULT_BLOB, after_hours_voice_mode: 'ai_answering' });
    const neverSet = await seedTenant({ channel_sms: false });

    await pool.query(BACKFILL_SQL);

    expect(await resolvedMode(explicitAi)).toBe('ai_answering');
    expect(await resolvedMode(neverSet)).toBe('ai_answering');
    expect(resolveEscalationSettings(await settingsRepo.findByTenant(neverSet)).channel_sms).toBe(false);
  });

  it('is idempotent — a second run changes no rows', async () => {
    await seedTenant(OLD_DEFAULT_BLOB);

    await pool.query(BACKFILL_SQL);
    const second = await pool.query(BACKFILL_SQL);

    expect(second.rowCount).toBe(0);
  });
});
