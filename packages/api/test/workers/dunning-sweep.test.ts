import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import {
  runDunningSweep,
  dunningWindow,
  DUNNING_GRACE_HOURS,
  type DunningSweepDeps,
} from '../../src/workers/dunning-sweep';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-06-21T12:00:00Z');
const TENANT = '11111111-1111-1111-1111-111111111111';
const HOUR = 60 * 60 * 1000;

interface Candidate {
  tenant_id: string;
  owner_email: string | null;
  past_due_grace_until: Date;
}

/** grace_until = failure time + 7 days. */
function failedHoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR + DUNNING_GRACE_HOURS * HOUR);
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
  deps: DunningSweepDeps;
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

describe('dunningWindow', () => {
  it('maps hours-since-failure to the right window or null in the gaps', () => {
    expect(dunningWindow(6)?.kind).toBe('dunning_0d');
    expect(dunningWindow(6)?.dunningDay).toBe(0);
    expect(dunningWindow(72)?.kind).toBe('dunning_3d');
    expect(dunningWindow(72)?.dunningDay).toBe(3);
    expect(dunningWindow(160)?.kind).toBe('dunning_7d');
    expect(dunningWindow(160)?.dunningDay).toBe(7);
    expect(dunningWindow(30)).toBeNull(); // between 0d and 3d windows
    expect(dunningWindow(100)).toBeNull(); // between 3d and 7d windows
    expect(dunningWindow(0)).toBeNull(); // not yet failed
    expect(dunningWindow(200)).toBeNull(); // grace lapsed
  });
});

describe('runDunningSweep', () => {
  it('no-ops without a pool', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const res = await runDunningSweep({
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

  it('sends the day-of dunning email right after the failure', async () => {
    const { deps, delivery } = makeDeps([
      { tenant_id: TENANT, owner_email: 'owner@shop.com', past_due_grace_until: failedHoursAgo(6) },
    ]);
    const res = await runDunningSweep(deps);
    expect(res.sent).toBe(1);
    expect(delivery.sentEmails).toHaveLength(1);
    expect(delivery.sentEmails[0].to).toBe('owner@shop.com');
    expect(delivery.sentEmails[0].subject).toMatch(/didn.t go through/i);
  });

  it('sends the +3d dunning email ~3 days after the failure', async () => {
    const { deps, delivery } = makeDeps([
      { tenant_id: TENANT, owner_email: 'owner@shop.com', past_due_grace_until: failedHoursAgo(72) },
    ]);
    const res = await runDunningSweep(deps);
    expect(res.sent).toBe(1);
    expect(delivery.sentEmails[0].subject).toMatch(/4 days left/i);
  });

  it('sends the +7d dunning email on the last day of grace', async () => {
    const { deps, delivery } = makeDeps([
      { tenant_id: TENANT, owner_email: 'owner@shop.com', past_due_grace_until: failedHoursAgo(160) },
    ]);
    const res = await runDunningSweep(deps);
    expect(res.sent).toBe(1);
    expect(delivery.sentEmails[0].subject).toMatch(/last day/i);
  });

  it('skips a tenant in the between-window gap', async () => {
    const { deps, delivery } = makeDeps([
      { tenant_id: TENANT, owner_email: 'owner@shop.com', past_due_grace_until: failedHoursAgo(36) },
    ]);
    const res = await runDunningSweep(deps);
    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(delivery.sentEmails).toHaveLength(0);
  });

  it('is idempotent per window — a second sweep does not re-send', async () => {
    const ledger = new Set<string>();
    const candidate: Candidate = {
      tenant_id: TENANT,
      owner_email: 'owner@shop.com',
      past_due_grace_until: failedHoursAgo(6),
    };
    const first = makeDeps([candidate], ledger);
    await runDunningSweep(first.deps);
    expect(first.delivery.sentEmails).toHaveLength(1);

    const second = makeDeps([candidate], ledger);
    const res = await runDunningSweep(second.deps);
    expect(res.sent).toBe(0);
    expect(second.delivery.sentEmails).toHaveLength(0);
  });
});
