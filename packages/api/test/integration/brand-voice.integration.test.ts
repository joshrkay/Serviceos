import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { ensureTenantSettings } from '../../src/settings/settings';
import { readToneFromSettings } from '../../src/ai/brand-voice/composer';
import { PgBrandVoiceRepository } from '../../src/tenants/brand/pg-brand-voice-repository';
import {
  updateBrandVoice,
  rollbackBrandVoice,
} from '../../src/tenants/brand/brand-voice-service';
import { BRAND_VOICE_COOLDOWN_MS } from '../../src/tenants/brand/brand-voice';

/**
 * N-011 integration — drives the Brand-Voice Configurator against real
 * Postgres. Pins the migration-237 history table + migration-238 bookkeeping
 * columns (mocked-Pool would have shipped bad column names), the version bump,
 * the cool-down gate, and the audit event. Runs in PR CI via
 * `npm run test:integration`.
 */
describe('Postgres integration — Brand-Voice Configurator (N-011)', () => {
  let pool: Pool;
  let brandVoiceRepo: PgBrandVoiceRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;

  const sixFields = {
    register: 'friendly' as const,
    opening_lines: ['Thanks for reaching out'],
    signoff: '— The M&R team',
    banned_phrases: ['cheapest in town'],
    persona_name: "M&R Mechanical's office",
    pronoun: 'we' as const,
  };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    brandVoiceRepo = new PgBrandVoiceRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  it('onboarding captures all six fields, writes v1 history, and round-trips to a tone', async () => {
    const tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);

    const result = await updateBrandVoice(
      {
        actor: { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' },
        patch: sixFields,
        onboarding: true,
      },
      brandVoiceRepo,
    );
    expect(result.state.version).toBe(1);
    expect(result.state.locked).toBe(true);

    // Persisted state reflects all six fields + bookkeeping columns.
    const state = await brandVoiceRepo.getState(tenant.tenantId);
    expect(state.config).toMatchObject(sixFields);
    expect(state.version).toBe(1);

    // Settings row exposes the version column, and the blob round-trips.
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings?.brandVoiceVersion).toBe(1);
    expect(settings?.brandVoiceLocked).toBe(true);
    const tone = readToneFromSettings(settings);
    expect(tone?.register).toBe('friendly');
    expect(tone?.persona_name).toBe("M&R Mechanical's office");
    expect(tone?.banned_phrases).toContain('cheapest in town');

    // Append-only history has exactly one row, reason = onboarding.
    const versions = await brandVoiceRepo.listVersions(tenant.tenantId);
    expect(versions).toHaveLength(1);
    expect(versions[0].changeReason).toBe('onboarding');
    expect(versions[0].snapshot).toMatchObject(sixFields);
  });

  it('an explicit edit is audit-logged and cool-down enforced (423), then succeeds after the window', async () => {
    const tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    const actor = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' };
    const t0 = Date.parse('2026-07-10T12:00:00.000Z');

    // Onboarding write (exempt) sets the anchor.
    const first = await updateBrandVoice(
      { actor, patch: sixFields, onboarding: true, now: t0 },
      brandVoiceRepo,
    );
    await auditRepo.create(first.audit);

    // A web edit inside the window is rejected with 423.
    await expect(
      updateBrandVoice(
        { actor, patch: { register: 'formal' }, now: t0 + 60_000 },
        brandVoiceRepo,
      ),
    ).rejects.toMatchObject({ code: 'BRAND_VOICE_COOLDOWN', statusCode: 423 });

    // After the window the edit succeeds, bumps to v2, and audits.
    const second = await updateBrandVoice(
      { actor, patch: { register: 'formal' }, now: t0 + BRAND_VOICE_COOLDOWN_MS },
      brandVoiceRepo,
    );
    await auditRepo.create(second.audit);
    expect(second.state.version).toBe(2);
    expect(second.state.config.register).toBe('formal');
    // The onboarding-set banned phrase survives the edit (union merge).
    expect(second.state.config.banned_phrases).toContain('cheapest in town');

    // Two brand_voice.updated audit events are persisted for the tenant.
    const events = await auditRepo.findByEntity(
      tenant.tenantId,
      'brand_voice',
      tenant.tenantId,
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.eventType === 'brand_voice.updated')).toBe(true);
    const toVersions = events.map((e) => e.metadata?.toVersion).sort();
    expect(toVersions).toEqual([1, 2]);
  });

  it('rollback re-persists an older snapshot as a new bump (history never mutated)', async () => {
    const tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    const actor = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' };
    const t0 = Date.parse('2026-07-10T12:00:00.000Z');

    await updateBrandVoice({ actor, patch: { register: 'friendly' }, onboarding: true, now: t0 }, brandVoiceRepo);
    await updateBrandVoice(
      { actor, patch: { register: 'formal' }, now: t0 + BRAND_VOICE_COOLDOWN_MS },
      brandVoiceRepo,
    );
    const rolled = await rollbackBrandVoice(
      { actor, version: 1, now: t0 + 2 * BRAND_VOICE_COOLDOWN_MS },
      brandVoiceRepo,
    );
    expect(rolled.state.version).toBe(3);
    expect(rolled.state.config.register).toBe('friendly');

    const versions = await brandVoiceRepo.listVersions(tenant.tenantId);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.find((v) => v.version === 3)?.changeReason).toBe('rollback');
  });
});
