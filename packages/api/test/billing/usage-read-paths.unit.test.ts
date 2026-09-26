/**
 * Unit cover for the AI-minute read paths (usage summary, usage alerts, cap
 * store, ledger, plan features) over a fake pool. The Postgres integration
 * tests (ai-usage, usage-alerts, call-usage-events, voice-gate-usage) are the
 * proof the SQL itself works.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiUsageReader } from '../../src/billing/ai-usage';
import { checkUsageAlerts } from '../../src/billing/usage-alerts';
import { PgOverageCapStore } from '../../src/billing/overage-cap';
import { PgCallUsageRepository } from '../../src/billing/call-usage-events';
import { planIncludesQuickBooks, quickBooksUpgradeRequired, readTenantPlanId } from '../../src/billing/plan-features';
import { fakePool } from './fake-pool';

const TENANT = '22222222-2222-4222-8222-222222222222';
const START = new Date('2026-10-01T00:00:00Z');
const END = new Date('2026-11-01T00:00:00Z');

interface World {
  status?: string | null;
  planId?: 'starter' | 'growth' | null;
  period?: boolean;
  seconds?: number;
  capCents?: number | null;
  uncapped?: boolean;
  alreadyAlerted?: string[];
  settingsRow?: boolean;
}

function world(w: World) {
  const inserted: string[] = [];
  const pool = fakePool((sql, params) => {
    if (sql.includes('FROM tenants')) {
      return {
        rows: [{
          subscription_status: w.status ?? 'active',
          plan_id: w.planId === undefined ? 'starter' : w.planId,
          current_period_start: w.period === false ? null : START,
          current_period_end: w.period === false ? null : END,
          owner_email: 'owner@shop.test',
          owner_id: 'u_owner',
        }],
      };
    }
    if (sql.includes('SUM(duration_seconds)')) return { rows: [{ seconds: String(w.seconds ?? 0) }] };
    if (sql.includes('FROM tenant_settings')) {
      return w.settingsRow === false
        ? { rows: [] }
        : { rows: [{ ai_overage_cap_cents: w.capCents ?? null, ai_overage_uncapped: w.uncapped ?? false }] };
    }
    if (sql.includes('INSERT INTO usage_alerts')) {
      const threshold = String(params[2]);
      if ((w.alreadyAlerted ?? []).includes(threshold) || inserted.includes(threshold)) return { rowCount: 0 };
      inserted.push(threshold);
      return { rowCount: 1 };
    }
    return undefined;
  });
  return { pool, inserted };
}

describe('AiUsageReader (unit)', () => {
  it('summarises a paid period, a trial, and a tenant with no period yet', async () => {
    expect(await new AiUsageReader(world({ seconds: 1_469 }).pool).getUsage(TENANT)).toMatchObject({
      kind: 'period', usedMinutes: 25, includedMinutes: 20, overageMinutes: 5, projectedChargeCents: 625, capCents: 7_900,
    });
    expect(await new AiUsageReader(world({ status: 'trialing', seconds: 45 * 60 }).pool).getUsage(TENANT)).toEqual({
      kind: 'trial', planId: 'starter', usedMinutes: 45, includedMinutes: 60,
    });
    expect(await new AiUsageReader(world({ period: false }).pool).getUsage(TENANT)).toEqual({ kind: 'none' });
    expect(
      await new AiUsageReader(world({ seconds: 200 * 60, uncapped: true }).pool).getUsage(TENANT),
    ).toMatchObject({ capCents: null, projectedChargeCents: 22_500 });
  });
});

describe('checkUsageAlerts (unit)', () => {
  it('emails the highest newly reached threshold once and skips trials and quiet periods', async () => {
    const sendEmail = vi.fn(async () => undefined);
    const deps = (w: World) => ({ pool: world(w).pool, sendEmail, appBaseUrl: 'https://app.test' });

    await checkUsageAlerts(deps({ seconds: 10 * 60 }), TENANT);
    await checkUsageAlerts(deps({ status: 'trialing', seconds: 30 * 60 }), TENANT);
    expect(sendEmail).not.toHaveBeenCalled();

    await checkUsageAlerts(deps({ seconds: 16 * 60 }), TENANT);
    await checkUsageAlerts(deps({ seconds: 25 * 60, alreadyAlerted: ['included_80'] }), TENANT);
    await checkUsageAlerts(deps({ seconds: 84 * 60, alreadyAlerted: ['included_80', 'included_100'] }), TENANT);
    await checkUsageAlerts(deps({ seconds: 84 * 60, alreadyAlerted: ['included_80', 'included_100', 'cap_reached'] }), TENANT);

    expect(sendEmail.mock.calls.map((c) => (c[0] as { subject: string }).subject)).toEqual([
      "You've used 80% of your AI answering minutes",
      "You've used all your included AI answering minutes",
      'Your AI overage cap is reached — calls now ring you',
    ]);
  });

  it('says "no limit" when the owner removed the cap, and survives a failing email', async () => {
    const sendEmail = vi.fn(async () => {
      throw new Error('smtp down');
    });
    await expect(
      checkUsageAlerts({ pool: world({ seconds: 20 * 60, uncapped: true }).pool, sendEmail, appBaseUrl: '' }, TENANT),
    ).resolves.toBeUndefined();
    expect((sendEmail.mock.calls[0][0] as { text: string }).text).toContain('overage cap of no limit');
  });
});

describe('PgOverageCapStore (unit)', () => {
  it('reads default / custom / removed caps and validates writes', async () => {
    expect(await new PgOverageCapStore(world({}).pool).get(TENANT)).toBeUndefined();
    expect(await new PgOverageCapStore(world({ capCents: 20_000 }).pool).get(TENANT)).toBe(20_000);
    expect(await new PgOverageCapStore(world({ uncapped: true }).pool).get(TENANT)).toBeNull();

    const store = new PgOverageCapStore(fakePool((sql) => (sql.startsWith('UPDATE tenant_settings') ? { rowCount: 1 } : undefined)));
    await expect(store.set(TENANT, 5_000)).resolves.toBeUndefined();
    await expect(store.set(TENANT, null)).resolves.toBeUndefined();
    await expect(store.set(TENANT, -1)).rejects.toThrow(RangeError);
    const missingRow = new PgOverageCapStore(fakePool(() => ({ rowCount: 0 })));
    await expect(missingRow.set(TENANT, 5_000)).rejects.toThrow(/No tenant_settings row/);
  });
});

describe('PgCallUsageRepository (unit)', () => {
  it('classifies against the tenant phones on insert and sums billable seconds', async () => {
    const pool = fakePool((sql) => {
      if (sql.includes('FROM tenant_settings')) return { rows: [{ owner_phone: '+14805550100', business_phone: null }] };
      if (sql.includes('SUM(duration_seconds)')) return { rows: [{ seconds: '90' }] };
      return { rowCount: 1 };
    });
    const repo = new PgCallUsageRepository(pool);
    await repo.recordCallEnded({
      tenantId: TENANT, callId: 'c1', channel: 'voice_inbound', callerPhone: '+14805550100',
      endedAt: END, usageSeconds: 120,
    });
    expect(pool.calls.some((c) => c.includes('INSERT INTO call_usage_events'))).toBe(true);
    expect(await repo.sumBillableSeconds(TENANT, START, END)).toBe(90);
  });
});

describe('plan features (unit)', () => {
  it('gates QuickBooks to Growth and reads the tenant plan', async () => {
    expect(planIncludesQuickBooks('growth')).toBe(true);
    expect(planIncludesQuickBooks('starter')).toBe(false);
    expect(planIncludesQuickBooks(null)).toBe(false);
    expect(quickBooksUpgradeRequired()).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', statusCode: 403 });
    expect(await readTenantPlanId(world({ planId: 'growth' }).pool, TENANT)).toBe('growth');
    expect(await readTenantPlanId(fakePool(() => ({ rows: [] })), TENANT)).toBeNull();
  });
});
