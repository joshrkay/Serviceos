import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import type { QueueMessage } from '../../src/queues/queue';
import {
  createLifecycleEmailWorker,
  LIFECYCLE_EMAIL_JOB_TYPE,
  type LifecycleEmailPayload,
} from '../../src/workers/lifecycle-email-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = '11111111-1111-1111-1111-111111111111';

function ledgerPool(ledger = new Set<string>()): Pool {
  return {
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
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }),
  } as unknown as Pool;
}

function msg(payload: LifecycleEmailPayload): QueueMessage<LifecycleEmailPayload> {
  return {
    id: 'job-1',
    type: LIFECYCLE_EMAIL_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `lifecycle-welcome-${payload.tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

describe('lifecycle email worker (welcome)', () => {
  it('sends the welcome email to the owner', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const worker = createLifecycleEmailWorker({
      delivery,
      pool: ledgerPool(),
      settingsRepo: new InMemorySettingsRepository(),
      auditRepo: new InMemoryAuditRepository(),
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
    });

    await worker.handle(msg({ tenantId: TENANT, ownerEmail: 'owner@shop.com', kind: 'welcome' }), logger);

    expect(delivery.sentEmails).toHaveLength(1);
    expect(delivery.sentEmails[0].to).toBe('owner@shop.com');
    expect(delivery.sentEmails[0].subject).toMatch(/welcome to rivet/i);
    expect(delivery.sentEmails[0].html).toContain('https://app.rivet.ai/onboarding');
  });

  it('is idempotent — the ledger claim prevents a second send', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const ledger = new Set<string>();
    const deps = {
      delivery,
      pool: ledgerPool(ledger),
      settingsRepo: new InMemorySettingsRepository(),
      auditRepo: new InMemoryAuditRepository(),
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
    };
    const worker = createLifecycleEmailWorker(deps);
    const message = msg({ tenantId: TENANT, ownerEmail: 'owner@shop.com', kind: 'welcome' });

    await worker.handle(message, logger);
    await worker.handle(message, logger); // webhook replay

    expect(delivery.sentEmails).toHaveLength(1);
  });

  it('no-ops without a delivery provider (does not throw)', async () => {
    const worker = createLifecycleEmailWorker({
      delivery: null,
      pool: ledgerPool(),
      settingsRepo: new InMemorySettingsRepository(),
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
    });
    await expect(
      worker.handle(msg({ tenantId: TENANT, ownerEmail: 'owner@shop.com', kind: 'welcome' }), logger),
    ).resolves.toBeUndefined();
  });

  it('ignores non-welcome kinds on the queue path (sweeps own those)', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const worker = createLifecycleEmailWorker({
      delivery,
      pool: ledgerPool(),
      settingsRepo: new InMemorySettingsRepository(),
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
    });
    await worker.handle(msg({ tenantId: TENANT, ownerEmail: 'o@s.com', kind: 'trial_3d' }), logger);
    expect(delivery.sentEmails).toHaveLength(0);
  });
});
