import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import {
  runTrialReminderSweep,
  trialWindow,
  type TrialReminderSweepDeps,
} from '../../src/workers/trial-reminder-sweep';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-06-21T12:00:00Z');
const TENANT = '11111111-1111-1111-1111-111111111111';
const HOUR = 60 * 60 * 1000;

interface Candidate {
  tenant_id: string;
  owner_email: string | null;
  trial_ends_at: Date;
}

function fakePool(candidates: Candidate[], ledger = new Set<string>()) {
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO lifecycle_emails')) {
        const key = `${params[0]}:${params[1]}`;
        if (ledger.has(key)) return { rows: [], rowCount: 0 } as unknown as QueryResult;
        ledger.add(key);
        return { rows: [{ tenant_id: params[0] }], rowCount: 1 } as unknown as QueryResult;
      }
      if (sql.includes('DELETE FROM lifecycle_emails')) {
        ledger.delete(`${params[0]}:${params[1]}`);
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      // eligibility SELECT
      return { rows: candidates, rowCount: candidates.length } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return { pool, ledger };
}

function makeDeps(candidates: Candidate[], ledger?: Set<string>): {
  deps: TrialReminderSweepDeps;
  delivery: InMemoryDeliveryProvider;
} {
  const delivery = new InMemoryDeliveryProvider();
  const { pool } = fakePool(candidates, ledger);
  return {
    delivery,
    deps: {
      pool,
      settingsRepo: new InMemorySettingsRepository(),
      delivery,
      auditRepo: new InMemoryAuditRepository(),
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
      now: () => NOW,
    },
  };
}

describe('trialWindow', () => {
  it('maps hours-remaining to the right window or null in the gaps', () => {
    expect(trialWindow(60)?.kind).toBe('trial_3d');
    expect(trialWindow(60)?.daysLeft).toBe(3);
    expect(trialWindow(18)?.kind).toBe('trial_1d');
    expect(trialWindow(6)?.kind).toBe('trial_0d');
    expect(trialWindow(36)).toBeNull(); // between 1d and 3d windows
    expect(trialWindow(0)).toBeNull(); // already ended
    expect(trialWindow(100)).toBeNull(); // beyond 72h
  });
});

describe('runTrialReminderSweep', () => {
  it('no-ops without a pool', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const res = await runTrialReminderSweep({
      pool: null,
      settingsRepo: new InMemorySettingsRepository(),
      delivery,
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
      now: () => NOW,
    });
    expect(res).toEqual({ candidates: 0, sent: 0, skipped: 0, failed: 0 });
    expect(delivery.sentEmails).toHaveLength(0);
  });

  it('sends the 3-day reminder for a trial ending in ~60h', async () => {
    const { deps, delivery } = makeDeps([
      { tenant_id: TENANT, owner_email: 'owner@shop.com', trial_ends_at: new Date(NOW.getTime() + 60 * HOUR) },
    ]);
    const res = await runTrialReminderSweep(deps);
    expect(res.sent).toBe(1);
    expect(delivery.sentEmails).toHaveLength(1);
    expect(delivery.sentEmails[0].to).toBe('owner@shop.com');
    expect(delivery.sentEmails[0].subject).toMatch(/in 3 days/i);
  });

  it('skips a trial in the between-window gap (~36h)', async () => {
    const { deps, delivery } = makeDeps([
      { tenant_id: TENANT, owner_email: 'owner@shop.com', trial_ends_at: new Date(NOW.getTime() + 36 * HOUR) },
    ]);
    const res = await runTrialReminderSweep(deps);
    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(delivery.sentEmails).toHaveLength(0);
  });

  it('is idempotent per window — a second sweep does not re-send', async () => {
    const ledger = new Set<string>();
    const candidate: Candidate = {
      tenant_id: TENANT,
      owner_email: 'owner@shop.com',
      trial_ends_at: new Date(NOW.getTime() + 6 * HOUR), // day-of window
    };
    const first = makeDeps([candidate], ledger);
    await runTrialReminderSweep(first.deps);
    expect(first.delivery.sentEmails).toHaveLength(1);
    expect(first.delivery.sentEmails[0].subject).toMatch(/today/i);

    // Same ledger, fresh delivery — claim already held, so no second send.
    const second = makeDeps([candidate], ledger);
    const res = await runTrialReminderSweep(second.deps);
    expect(res.sent).toBe(0);
    expect(second.delivery.sentEmails).toHaveLength(0);
  });
});
