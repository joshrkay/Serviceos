/**
 * checkAndFireUpgradeNudge — the trial upgrade nudge at call end. The
 * tenants billing read decides "trialing" as before; the prompt-shown read,
 * the trial-minutes sum and the once-only stamp then run in ONE tenant
 * transaction (rls_app_runtime, raw-pg audit 2026-10-23 §4 P1.5), committed
 * before the funnel event and the email. Real columns and the role are pinned
 * in test/integration/voice-path-tenant-context.test.ts and
 * test/integration/upgrade-nudge.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const recordFunnelEventMock = vi.fn();
vi.mock('../../src/analytics/posthog', () => ({
  recordFunnelEvent: (...args: unknown[]) => recordFunnelEventMock(...args),
}));

import { checkAndFireUpgradeNudge } from '../../src/voice/check-upgrade-nudge';

const TENANT = '00000000-0000-4000-8000-0000000e0d6e';

function world(opts: { status?: string; shown?: boolean; seconds?: number; stampRows?: number }) {
  return fakeTenantPool((sql) => {
    if (sql.includes('FROM tenants')) {
      return { rows: [{ subscription_status: opts.status ?? 'trialing', owner_id: 'u_owner', owner_email: 'owner@shop.test' }] };
    }
    if (sql.includes('UPDATE tenant_settings')) return { rowCount: opts.stampRows ?? 1 };
    if (sql.includes('FROM tenant_settings')) {
      return { rows: [{ onboarding_upgrade_prompt_shown_at: opts.shown ? new Date() : null }] };
    }
    if (sql.includes('FROM call_usage_events')) return { rows: [{ seconds: String(opts.seconds ?? 45 * 60) }] };
    return undefined;
  });
}

describe('checkAndFireUpgradeNudge', () => {
  beforeEach(() => {
    recordFunnelEventMock.mockReset();
  });

  it('reads, sums and stamps on ONE tenant checkout after the tenants read, then fires outside it', async () => {
    const fake = world({});
    const openAt: Record<string, number> = {};
    recordFunnelEventMock.mockImplementation(() => {
      openAt.funnel = fake.open();
    });
    const sendEmail = vi.fn(async () => {
      openAt.email = fake.open();
    });

    expect(await checkAndFireUpgradeNudge({ pool: fake.pool, sendEmail, webUrl: 'https://app.test' }, TENANT)).toEqual({ fired: true });

    expect(fake.checkouts()).toBe(2);
    expect(fake.work().map((s) => [s.checkout, s.sql.match(/(?:FROM|UPDATE) (\w+)/)?.[1]])).toEqual([
      [0, 'tenants'],
      [1, 'tenant_settings'],
      [1, 'call_usage_events'],
      [1, 'tenant_settings'],
    ]);
    const session = fake.statements.filter((s) => s.checkout === 1).map((s) => s.sql.trim().split(/\s+/)[0]);
    expect(session[0]).toBe('BEGIN');
    expect(session.at(-1)).toBe('COMMIT');
    expect(fake.statements.find((s) => s.sql.includes("set_config('app.current_tenant_id'"))?.values).toEqual([TENANT]);
    expect(openAt).toEqual({ funnel: 0, email: 0 });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@shop.test' }));
  });

  it('a tenant that is not trialing never opens a tenant session', async () => {
    const fake = world({ status: 'active' });
    expect(await checkAndFireUpgradeNudge({ pool: fake.pool }, TENANT)).toEqual({ fired: false });
    expect(fake.checkouts()).toBe(1);
  });

  it('already shown, under the threshold, or a lost check-and-set race: no stamp, no event', async () => {
    for (const w of [{ shown: true }, { seconds: 10 * 60 }, { stampRows: 0 }]) {
      const fake = world(w);
      expect(await checkAndFireUpgradeNudge({ pool: fake.pool }, TENANT)).toEqual({ fired: false });
      expect(fake.open()).toBe(0);
    }
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });
});
