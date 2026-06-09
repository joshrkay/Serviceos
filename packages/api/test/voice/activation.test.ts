import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';

// Capture funnel emissions without touching PostHog.
const recordFunnelEventMock = vi.fn();
vi.mock('../../src/analytics/posthog', () => ({
  recordFunnelEvent: (...args: unknown[]) => recordFunnelEventMock(...args),
}));

import { maybeFireFirstRealCallActivation } from '../../src/voice/activation';

interface TenantRow {
  owner_id: string | null;
  owner_email: string | null;
  subscription_status: string | null;
}
interface SettingsRow {
  voice_agent_live_at: Date | null;
  activated_at: Date | null;
  onboarding_test_call_skipped_at: Date | null;
}
interface PoolOverrides {
  tenant?: TenantRow | null;
  settings?: SettingsRow | null;
  inboundCount?: number;
  updateRowCount?: number;
}

/**
 * Fake pg Pool that routes queries by SQL shape. Defaults describe the
 * activation happy path (live trialing tenant, agent live, not yet
 * activated, two inbound calls); each test overrides the one fact it
 * exercises.
 */
function makePool(overrides: PoolOverrides = {}) {
  const state = {
    tenant:
      overrides.tenant !== undefined
        ? overrides.tenant
        : { owner_id: 'clerk_owner', owner_email: 'owner@example.com', subscription_status: 'trialing' },
    settings:
      overrides.settings !== undefined
        ? overrides.settings
        : { voice_agent_live_at: new Date('2026-01-01T00:00:00Z'), activated_at: null, onboarding_test_call_skipped_at: null },
    inboundCount: overrides.inboundCount ?? 2,
    updateRowCount: overrides.updateRowCount ?? 1,
  };
  const updateParams: unknown[][] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/UPDATE\s+tenant_settings/i.test(sql) && /activated_at\s*=\s*now\(\)/i.test(sql)) {
      updateParams.push(params ?? []);
      return { rowCount: state.updateRowCount, rows: [] };
    }
    if (/FROM\s+tenants/i.test(sql)) {
      return { rows: state.tenant ? [state.tenant] : [] };
    }
    if (/FROM\s+tenant_settings/i.test(sql)) {
      return { rows: state.settings ? [state.settings] : [] };
    }
    if (/COUNT\(\*\)/i.test(sql) && /voice_sessions/i.test(sql)) {
      return { rows: [{ n: state.inboundCount }] };
    }
    return { rows: [] };
  });
  const pool = { query } as unknown as Pool;
  return { pool, query, updateParams };
}

function makeAuditRepo() {
  return { create: vi.fn(async () => undefined) } as never;
}

describe('maybeFireFirstRealCallActivation', () => {
  beforeEach(() => {
    recordFunnelEventMock.mockClear();
  });

  it('fires first_real_call_received once on the first real inbound call (count >= 2)', async () => {
    const { pool, updateParams } = makePool();
    const auditRepo = makeAuditRepo();
    const sendEmail = vi.fn(async () => ({}));

    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo, sendEmail },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );

    expect(res).toEqual({ fired: true });
    // check-and-set ran for this tenant
    expect(updateParams).toEqual([['tenant-1']]);
    // funnel event carries the four required fields
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'clerk_owner',
        event: 'first_real_call_received',
        properties: expect.objectContaining({
          tenant_id: 'tenant-1',
          user_id: 'clerk_owner',
          source: 'server',
          timestamp: expect.any(String),
        }),
      }),
    );
    // audit + email both fired
    expect((auditRepo as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@example.com', subject: expect.stringContaining('first real call') }),
    );
  });

  it('is idempotent: when the check-and-set writes 0 rows, nothing fires', async () => {
    const { pool } = makePool({ updateRowCount: 0 });
    const sendEmail = vi.fn(async () => ({}));

    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo(), sendEmail },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );

    expect(res).toEqual({ fired: false });
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not fire for non-inbound channels', async () => {
    const { pool, query } = makePool();
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo() },
      { tenantId: 'tenant-1', channel: 'inapp_voice' },
    );
    expect(res).toEqual({ fired: false });
    expect(query).not.toHaveBeenCalled();
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });

  it('does not fire when the subscription is not live', async () => {
    const { pool } = makePool({
      tenant: { owner_id: 'o', owner_email: 'o@x.com', subscription_status: 'canceled' },
    });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo() },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: false });
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });

  it('does not fire before the voice agent is live', async () => {
    const { pool } = makePool({
      settings: { voice_agent_live_at: null, activated_at: null, onboarding_test_call_skipped_at: null },
    });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo() },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: false });
  });

  it('does not fire when already activated', async () => {
    const { pool, updateParams } = makePool({
      settings: {
        voice_agent_live_at: new Date(),
        activated_at: new Date('2026-02-01T00:00:00Z'),
        onboarding_test_call_skipped_at: null,
      },
    });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo() },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: false });
    // never reached the check-and-set
    expect(updateParams).toEqual([]);
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
  });

  it('treats the test call as inbound #1: a single call does NOT activate when the test call was made', async () => {
    const { pool } = makePool({ inboundCount: 1 });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo() },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: false });
  });

  it('activates on inbound #1 when the test call was skipped (threshold drops to 1)', async () => {
    const { pool } = makePool({
      inboundCount: 1,
      settings: {
        voice_agent_live_at: new Date(),
        activated_at: null,
        onboarding_test_call_skipped_at: new Date('2026-01-02T00:00:00Z'),
      },
    });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo() },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: true });
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);
  });

  it('still fires the funnel event when no email channel is wired', async () => {
    const { pool } = makePool();
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo() },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: true });
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);
  });

  it('skips the email but still activates when the owner has no email on file', async () => {
    const { pool } = makePool({
      tenant: { owner_id: 'o', owner_email: null, subscription_status: 'active' },
    });
    const sendEmail = vi.fn(async () => ({}));
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: makeAuditRepo(), sendEmail },
      { tenantId: 'tenant-1', channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);
  });
});
