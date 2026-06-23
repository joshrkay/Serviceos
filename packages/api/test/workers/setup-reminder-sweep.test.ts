import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import type { OnboardingFacts } from '../../src/onboarding/derive-status';
import {
  runSetupReminderSweep,
  type SetupReminderSweepDeps,
} from '../../src/workers/setup-reminder-sweep';

// Control onboarding completeness directly; the sweep's own SQL (eligibility +
// ledger) is exercised through the fake pool below.
vi.mock('../../src/onboarding/load-facts', () => ({
  loadOnboardingFacts: vi.fn(),
}));
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = '11111111-1111-1111-1111-111111111111';
const mockedLoad = vi.mocked(loadOnboardingFacts);

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    tenantId: TENANT,
    tenantExists: true,
    identity: {
      businessName: 'Acme HVAC',
      businessHours: { mon: '9-5' },
      jobBufferMinutes: 30,
      hourlyRateCents: 12000,
    },
    packActivated: true,
    twilioStatus: 'full_readiness',
    twilioPhoneNumber: '+15555550123',
    subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
    inboundCallCount: 1,
    testCallSkippedAt: null,
    voiceAgentLiveAt: new Date(),
    activatedAt: null,
    aiConfigPresent: true,
    aiVerificationStatus: 'passed',
    ...overrides,
  };
}

function fakePool(candidates: Array<{ tenant_id: string; owner_email: string | null }>) {
  const ledger = new Set<string>();
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
      return { rows: candidates, rowCount: candidates.length } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return { pool, ledger };
}

function makeDeps(
  candidates: Array<{ tenant_id: string; owner_email: string | null }>,
): { deps: SetupReminderSweepDeps; delivery: InMemoryDeliveryProvider; ledger: Set<string> } {
  const delivery = new InMemoryDeliveryProvider();
  const { pool, ledger } = fakePool(candidates);
  return {
    delivery,
    ledger,
    deps: {
      pool,
      settingsRepo: new InMemorySettingsRepository(),
      delivery,
      auditRepo: new InMemoryAuditRepository(),
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
    },
  };
}

describe('runSetupReminderSweep', () => {
  beforeEach(() => mockedLoad.mockReset());

  it('no-ops without a pool', async () => {
    const res = await runSetupReminderSweep({
      pool: null,
      settingsRepo: new InMemorySettingsRepository(),
      delivery: new InMemoryDeliveryProvider(),
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
    });
    expect(res).toEqual({ candidates: 0, sent: 0, suppressed: 0, failed: 0 });
  });

  it('emails an incomplete tenant with the outstanding steps listed', async () => {
    // Identity not done → onboarding incomplete.
    mockedLoad.mockResolvedValue(
      facts({ identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null } }),
    );
    const { deps, delivery } = makeDeps([{ tenant_id: TENANT, owner_email: 'owner@shop.com' }]);

    const res = await runSetupReminderSweep(deps);

    expect(res.sent).toBe(1);
    expect(delivery.sentEmails).toHaveLength(1);
    expect(delivery.sentEmails[0].to).toBe('owner@shop.com');
    expect(delivery.sentEmails[0].text).toMatch(/business details/i);
  });

  it('suppresses (stamps, no email) a tenant that is already complete', async () => {
    mockedLoad.mockResolvedValue(facts()); // all steps done
    const { deps, delivery, ledger } = makeDeps([{ tenant_id: TENANT, owner_email: 'owner@shop.com' }]);

    const res = await runSetupReminderSweep(deps);

    expect(res.sent).toBe(0);
    expect(res.suppressed).toBe(1);
    expect(delivery.sentEmails).toHaveLength(0);
    // Ledger stamped so the sweep never re-evaluates this tenant.
    expect(ledger.has(`${TENANT}:setup_reminder`)).toBe(true);
  });

  it('suppresses a tenant with no deliverable email', async () => {
    mockedLoad.mockResolvedValue(
      facts({ identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null } }),
    );
    const { deps, delivery } = makeDeps([{ tenant_id: TENANT, owner_email: null }]);

    const res = await runSetupReminderSweep(deps);

    expect(res.suppressed).toBe(1);
    expect(delivery.sentEmails).toHaveLength(0);
  });
});
