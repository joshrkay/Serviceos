import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { checkAndFireUpgradeNudge } from '../../src/voice/check-upgrade-nudge';

function mockPool(rows: {
  subscriptionStatus: string | null;
  ownerEmail?: string | null;
  promptShownAt?: Date | null;
  minutes?: number;
  updateRowCount?: number;
}): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM tenants')) {
        return {
          rows: [
            { subscription_status: rows.subscriptionStatus, owner_email: rows.ownerEmail ?? null },
          ],
        };
      }
      if (sql.includes('FROM tenant_settings')) {
        return { rows: [{ onboarding_upgrade_prompt_shown_at: rows.promptShownAt ?? null }] };
      }
      if (sql.includes('FROM voice_sessions')) {
        return { rows: [{ mins: rows.minutes ?? 0 }] };
      }
      if (sql.startsWith('UPDATE tenant_settings')) {
        return { rows: [], rowCount: rows.updateRowCount ?? 1 };
      }
      return { rows: [] };
    }),
  } as unknown as Pool;
}

describe('checkAndFireUpgradeNudge', () => {
  it('no-ops when not trialing', async () => {
    const r = await checkAndFireUpgradeNudge(
      { pool: mockPool({ subscriptionStatus: 'active', minutes: 100 }) },
      't1',
    );
    expect(r.fired).toBe(false);
  });

  it('no-ops when prompt already shown', async () => {
    const r = await checkAndFireUpgradeNudge(
      {
        pool: mockPool({
          subscriptionStatus: 'trialing',
          promptShownAt: new Date(),
          minutes: 100,
        }),
      },
      't1',
    );
    expect(r.fired).toBe(false);
  });

  it('no-ops under 30 minutes of usage', async () => {
    const r = await checkAndFireUpgradeNudge(
      { pool: mockPool({ subscriptionStatus: 'trialing', minutes: 20 }) },
      't1',
    );
    expect(r.fired).toBe(false);
  });

  it('fires at 30 minutes and sends email when configured', async () => {
    const sendEmail = vi.fn(async () => undefined);
    const r = await checkAndFireUpgradeNudge(
      {
        pool: mockPool({
          subscriptionStatus: 'trialing',
          minutes: 30,
          ownerEmail: 'owner@example.com',
        }),
        sendEmail,
      },
      't1',
    );
    expect(r.fired).toBe(true);
    expect(sendEmail).toHaveBeenCalledOnce();
    const call = sendEmail.mock.calls[0][0];
    expect(call.to).toBe('owner@example.com');
    expect(call.subject).toMatch(/subscription/i);
  });

  it('fires without sendEmail wired — still records the timestamp', async () => {
    const r = await checkAndFireUpgradeNudge(
      { pool: mockPool({ subscriptionStatus: 'trialing', minutes: 50 }) },
      't1',
    );
    expect(r.fired).toBe(true);
  });

  it('race-safe: returns fired=false when UPDATE matches 0 rows', async () => {
    const r = await checkAndFireUpgradeNudge(
      {
        pool: mockPool({
          subscriptionStatus: 'trialing',
          minutes: 60,
          updateRowCount: 0,
        }),
      },
      't1',
    );
    expect(r.fired).toBe(false);
  });

  it('email failure does not undo the timestamp', async () => {
    const sendEmail = vi.fn(async () => {
      throw new Error('email service down');
    });
    const r = await checkAndFireUpgradeNudge(
      {
        pool: mockPool({
          subscriptionStatus: 'trialing',
          minutes: 31,
          ownerEmail: 'owner@example.com',
        }),
        sendEmail,
      },
      't1',
    );
    expect(r.fired).toBe(true);
  });
});
