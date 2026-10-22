/**
 * Docker-gated integration test for #1766 (D-044) — the forwarding check's
 * correlation record in call_forwarding_checks (migration 333) and the pass
 * it writes to tenant_settings.call_forwarding_verified_at.
 *
 * Pins the real columns and queries under RLS: a pending check is found only
 * for its own tenant, Rivet number and window, settles exactly once, and a
 * new check supersedes the open one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCallForwardingRepository } from '../../src/onboarding/call-forwarding';
import {
  ForwardingCheckService,
  PgForwardingCheckRepository,
  type ForwardingCheck,
} from '../../src/onboarding/forwarding-check';

// Unique per run: migration 274 makes a Twilio DID unique across tenants and
// the suite's database is shared.
const RIVET = `+1512${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

async function liveLine(pool: Pool, tenantId: string, phoneE164: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_integrations (id, tenant_id, provider, status, provider_data)
     VALUES (gen_random_uuid(), $1, 'twilio', 'full_readiness', $2::jsonb)`,
    [tenantId, JSON.stringify({ phoneE164 })],
  );
}

function check(tenantId: string, over: Partial<ForwardingCheck> = {}): ForwardingCheck {
  const createdAt = new Date('2026-10-22T12:00:00Z');
  return {
    id: randomUUID(),
    tenantId,
    status: 'pending',
    mode: 'missed',
    rivetNumber: RIVET,
    businessNumber: '+15125550999',
    callSid: null,
    failureReason: null,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 120_000),
    completedAt: null,
    ...over,
  };
}

describe('#1766 forwarding check (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('finds a pending check only for its tenant, caller and window, and settles it once', async () => {
    const { tenantId } = await createTestTenant(pool);
    const { tenantId: other } = await createTestTenant(pool);
    const repo = new PgForwardingCheckRepository(pool);
    const c = check(tenantId);
    await repo.create(c);
    await repo.setCallSid(tenantId, c.id, 'CA123');

    const inWindow = new Date('2026-10-22T12:00:30Z');
    expect((await repo.findPendingFrom(tenantId, RIVET, inWindow))?.callSid).toBe('CA123');
    expect(await repo.findPendingFrom(tenantId, '+15125550100', inWindow)).toBeNull();
    expect(await repo.findPendingFrom(other, RIVET, inWindow)).toBeNull();
    expect(await repo.findPendingFrom(tenantId, RIVET, new Date('2026-10-22T12:03:00Z'))).toBeNull();

    const at = new Date('2026-10-22T12:00:31Z');
    expect(await repo.settle(tenantId, c.id, { status: 'passed', at })).toBe(true);
    expect(await repo.settle(tenantId, c.id, { status: 'timed_out', at })).toBe(false);
    expect(await repo.findPendingFrom(tenantId, RIVET, inWindow)).toBeNull();
    expect(await repo.latest(tenantId)).toMatchObject({ status: 'passed', completedAt: at });
  });

  it('a new check supersedes the open one', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgForwardingCheckRepository(pool);
    const first = check(tenantId);
    await repo.create(first);
    const second = check(tenantId, {
      createdAt: new Date('2026-10-22T12:01:00Z'),
      expiresAt: new Date('2026-10-22T12:03:00Z'),
    });
    await repo.create(second);

    expect((await repo.latest(tenantId))?.id).toBe(second.id);
    expect(await repo.settle(tenantId, first.id, { status: 'passed', at: new Date() })).toBe(false);
  });

  it('a recognised inbound call records the pass on tenant_settings', async () => {
    const { tenantId } = await createTestTenant(pool);
    await new PgSettingsRepository(pool).upsertIdentityFields(tenantId, { businessName: 'Acme' });
    const forwardingRepo = new PgCallForwardingRepository(pool);
    await forwardingRepo.save(tenantId, { carrier: 'verizon', mode: 'missed' });
    const repo = new PgForwardingCheckRepository(pool);
    const now = new Date('2026-10-22T12:00:30Z');
    const service = new ForwardingCheckService({
      repo,
      forwardingRepo,
      getBusinessPhone: async () => null,
      getCreds: async () => {
        throw new Error('unused');
      },
      now: () => now,
    });
    await liveLine(pool, tenantId, RIVET);
    await repo.create(check(tenantId));

    expect(await service.recognizeInbound({ tenantId, from: RIVET, callSid: 'CA-back' })).toBe(true);
    expect((await forwardingRepo.get(tenantId))?.checkPassedAt).toEqual(now);
    // Already settled: the same call again is an ordinary call.
    expect(await service.recognizeInbound({ tenantId, from: RIVET, callSid: 'CA-back-2' })).toBe(false);
  });

  it('a check placed from a number the tenant no longer has does not restore the proof', async () => {
    const { tenantId } = await createTestTenant(pool);
    await new PgSettingsRepository(pool).upsertIdentityFields(tenantId, { businessName: 'Acme' });
    const forwardingRepo = new PgCallForwardingRepository(pool);
    await forwardingRepo.save(tenantId, { carrier: 'verizon', mode: 'missed' });
    // The line was repointed to a new number after this check was placed.
    const newNumber = `+1737${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    await liveLine(pool, tenantId, newNumber);
    const repo = new PgForwardingCheckRepository(pool);
    const service = new ForwardingCheckService({
      repo,
      forwardingRepo,
      getBusinessPhone: async () => null,
      getCreds: async () => {
        throw new Error('unused');
      },
      now: () => new Date('2026-10-22T12:00:30Z'),
    });
    await repo.create(check(tenantId));

    // Still the check call, so it hangs up rather than reach the AI...
    expect(await service.recognizeInbound({ tenantId, from: RIVET, callSid: 'CA-old' })).toBe(true);
    // ...but forwarding to the released number proves nothing about the new one.
    expect((await forwardingRepo.get(tenantId))?.checkPassedAt).toBeNull();
    // ...and the check itself reads as failed, never "Forwarding works".
    expect((await repo.latest(tenantId))?.status).toBe('failed');
  });

  it('rejects a status outside the allowed set', async () => {
    const { tenantId } = await createTestTenant(pool);
    await expect(
      pool.query(
        `INSERT INTO call_forwarding_checks (id, tenant_id, status, mode, rivet_number, business_number, expires_at)
         VALUES ($1, $2, 'weird', 'missed', $3, $3, NOW())`,
        [randomUUID(), tenantId, RIVET],
      ),
    ).rejects.toThrow();
  });
});
