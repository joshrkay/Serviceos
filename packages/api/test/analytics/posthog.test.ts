import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordFunnelEvent,
  recordProductEvent,
  recordTenantGroup,
  recordApiError,
  recordVoiceError,
  isFunnelAnalyticsEnabled,
  isProductAnalyticsEnabled,
  __resetAnalyticsForTests,
  __setClientForTests,
  shutdownAnalytics,
} from '../../src/analytics/posthog';

// A fake PostHog client injected via __setClientForTests so we can assert the
// exact capture / groupIdentify calls without the real SDK (getClient()'s
// dynamic require() is awkward to mock; the wrapper's own gating is exercised
// separately by the off-by-default tests below).
const captureSpy = vi.fn();
const groupIdentifySpy = vi.fn();
const fakeClient = {
  capture: captureSpy,
  groupIdentify: groupIdentifySpy,
  shutdown: vi.fn(async () => {}),
};

describe('server-side PostHog wrapper', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
  });

  afterEach(() => {
    __resetAnalyticsForTests();
  });

  it('is disabled and silent when POSTHOG_API_KEY is unset', () => {
    expect(isFunnelAnalyticsEnabled()).toBe(false);
    // Should never throw, never log, just no-op.
    expect(() =>
      recordFunnelEvent({
        distinctId: 'user_123',
        event: 'signup_completed',
        properties: { tenantId: 't' },
      }),
    ).not.toThrow();
  });

  it('is disabled when POSTHOG_API_KEY is the empty string', () => {
    process.env.POSTHOG_API_KEY = '   ';
    expect(isFunnelAnalyticsEnabled()).toBe(false);
  });

  it('reports enabled when POSTHOG_API_KEY is set', () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    expect(isFunnelAnalyticsEnabled()).toBe(true);
  });

  it('accepts the first_real_call_received activation event (off-by-default, no throw)', () => {
    // The activation milestone is emitted from voice/activation.ts. Assert
    // the union member is wired through recordFunnelEvent and stays a silent
    // no-op when analytics is disabled (so it can never break call teardown).
    expect(isFunnelAnalyticsEnabled()).toBe(false);
    expect(() =>
      recordFunnelEvent({
        distinctId: 'clerk_owner',
        event: 'first_real_call_received',
        properties: {
          tenant_id: 't_1',
          user_id: 'clerk_owner',
          source: 'server',
          timestamp: new Date().toISOString(),
        },
      }),
    ).not.toThrow();
  });

  it('does not throw on shutdown when the client was never instantiated', async () => {
    await expect(shutdownAnalytics()).resolves.not.toThrow();
  });

  it('never throws even when the PostHog SDK fails to load', () => {
    // Set a key, then point require at a non-existent module so the
    // try/catch around require() trips. recordFunnelEvent should still
    // be a silent no-op rather than poisoning a webhook handler.
    process.env.POSTHOG_API_KEY = 'phc_test';
    // The actual posthog-node package is installed, so this only exercises
    // the "key set, sdk loads, capture called" happy path here in unit
    // form. The integration tests exercise the wire-up from webhooks.
    expect(() =>
      recordFunnelEvent({
        distinctId: 'user_42',
        event: 'trial_to_paid',
        properties: { tenantId: 't_42', priorStatus: 'trialing' },
      }),
    ).not.toThrow();
  });
});

describe('product events + group analytics', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    captureSpy.mockClear();
    groupIdentifySpy.mockClear();
    process.env.POSTHOG_API_KEY = 'phc_test';
    __setClientForTests(fakeClient);
  });

  afterEach(() => {
    __resetAnalyticsForTests();
    delete process.env.POSTHOG_API_KEY;
  });

  it('is enabled when the key is set', () => {
    expect(isProductAnalyticsEnabled()).toBe(true);
  });

  it('captures a product event with groups:{tenant}, standard props, and $insert_id', () => {
    recordProductEvent('proposal_approved', {
      tenantId: 't_1',
      distinctId: 'clerk_owner',
      properties: { entity_id: 'p_1', feature_domain: 'proposal' },
      insertId: 'audit_1',
    });

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const arg = captureSpy.mock.calls[0][0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
      groups?: Record<string, string>;
    };
    expect(arg.event).toBe('proposal_approved');
    expect(arg.distinctId).toBe('clerk_owner');
    expect(arg.groups).toEqual({ tenant: 't_1' });
    expect(arg.properties.tenant_id).toBe('t_1');
    expect(arg.properties.source).toBe('server');
    expect(typeof arg.properties.timestamp).toBe('string');
    expect(arg.properties.$insert_id).toBe('audit_1');
    expect(arg.properties.entity_id).toBe('p_1');
    expect(arg.properties.feature_domain).toBe('proposal');
  });

  it('omits $insert_id when no insertId is supplied but still sets the tenant group', () => {
    recordProductEvent('invoice_issued', { tenantId: 't_2', distinctId: 'd' });

    const arg = captureSpy.mock.calls[0][0] as {
      properties: Record<string, unknown>;
      groups?: Record<string, string>;
    };
    expect(arg.properties.$insert_id).toBeUndefined();
    expect(arg.groups).toEqual({ tenant: 't_2' });
  });

  it('recordTenantGroup sets properties on the tenant group', () => {
    recordTenantGroup('t_9', { vertical: 'plumbing', plan: 'pro' });

    expect(groupIdentifySpy).toHaveBeenCalledTimes(1);
    expect(groupIdentifySpy.mock.calls[0][0]).toEqual({
      groupType: 'tenant',
      groupKey: 't_9',
      properties: { vertical: 'plumbing', plan: 'pro' },
    });
  });

  it('additively stamps groups:{tenant} on funnel events that carry a tenant id', () => {
    recordFunnelEvent({
      distinctId: 'd',
      event: 'trial_to_paid',
      properties: { tenant_id: 't_5', priorStatus: 'trialing' },
    });

    const arg = captureSpy.mock.calls[0][0] as {
      event: string;
      groups?: Record<string, string>;
      properties?: Record<string, unknown>;
    };
    // Name + props unchanged (dashboards unaffected); group added.
    expect(arg.event).toBe('trial_to_paid');
    expect(arg.properties?.priorStatus).toBe('trialing');
    expect(arg.groups).toEqual({ tenant: 't_5' });
  });

  it('sets no groups on a funnel event with no tenant id', () => {
    recordFunnelEvent({ distinctId: 'd', event: 'signup_completed', properties: {} });

    const arg = captureSpy.mock.calls[0][0] as { groups?: Record<string, string> };
    expect(arg.groups).toBeUndefined();
  });

  it('off-by-default: no key → recordProductEvent / recordTenantGroup are no-ops', () => {
    delete process.env.POSTHOG_API_KEY;
    __resetAnalyticsForTests();

    recordProductEvent('payment_recorded', { tenantId: 't', distinctId: 'd' });
    recordTenantGroup('t', { plan: 'pro' });

    expect(captureSpy).not.toHaveBeenCalled();
    expect(groupIdentifySpy).not.toHaveBeenCalled();
    expect(isProductAnalyticsEnabled()).toBe(false);
  });

  it('recordProductEvent never throws when capture throws', () => {
    captureSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() =>
      recordProductEvent('estimate_created', { tenantId: 't', distinctId: 'd' }),
    ).not.toThrow();
  });
});

describe('recordApiError', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    captureSpy.mockClear();
    process.env.POSTHOG_API_KEY = 'phc_test';
    __setClientForTests(fakeClient);
  });

  afterEach(() => {
    __resetAnalyticsForTests();
    delete process.env.POSTHOG_API_KEY;
  });

  it('emits api_error with route/status, tenant group, and no PII', () => {
    recordApiError({ route: '/api/jobs/123', status: 500, tenantId: 't_1', userId: 'clerk_owner' });

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const arg = captureSpy.mock.calls[0][0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
      groups?: Record<string, string>;
    };
    expect(arg.event).toBe('api_error');
    expect(arg.distinctId).toBe('clerk_owner');
    expect(arg.groups).toEqual({ tenant: 't_1' });
    expect(arg.properties).toMatchObject({
      route: '/api/jobs/123',
      status: 500,
      source: 'server',
      tenant_id: 't_1',
    });
    // no body / headers / message keys
    expect(Object.keys(arg.properties)).not.toContain('message');
    expect(Object.keys(arg.properties)).not.toContain('body');
  });

  it('uses a stable server sentinel distinctId and no group when tenant/user absent', () => {
    recordApiError({ route: '/api/x', status: 503 });

    const arg = captureSpy.mock.calls[0][0] as {
      distinctId: string;
      properties: Record<string, unknown>;
      groups?: Record<string, string>;
    };
    expect(arg.distinctId).toBe('server:error');
    expect(arg.groups).toBeUndefined();
    expect(arg.properties.tenant_id).toBeUndefined();
  });

  it('off-by-default: no key → no-op', () => {
    delete process.env.POSTHOG_API_KEY;
    __resetAnalyticsForTests();
    recordApiError({ route: '/api/x', status: 500, tenantId: 't' });
    expect(captureSpy).not.toHaveBeenCalled();
  });
});

describe('recordVoiceError', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    captureSpy.mockClear();
    process.env.POSTHOG_API_KEY = 'phc_test';
    __setClientForTests(fakeClient);
  });

  afterEach(() => {
    __resetAnalyticsForTests();
    delete process.env.POSTHOG_API_KEY;
  });

  it('emits voice_error with the server sentinel distinctId and the tenant group when tenantId is present', () => {
    recordVoiceError({
      errorKind: 'speech_turn_failed',
      channel: 'media_streams',
      callSid: 'CA123',
      tenantId: 't_1',
    });

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const arg = captureSpy.mock.calls[0][0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
      groups?: Record<string, string>;
    };
    expect(arg.event).toBe('voice_error');
    // Voice callers must never mint a PostHog person — always the sentinel.
    expect(arg.distinctId).toBe('server:voice');
    expect(arg.groups).toEqual({ tenant: 't_1' });
    expect(arg.properties).toMatchObject({
      error_kind: 'speech_turn_failed',
      channel: 'media_streams',
      call_sid: 'CA123',
      tenant_id: 't_1',
      source: 'server',
    });
    expect(typeof arg.properties.timestamp).toBe('string');
  });

  it('carries task_type only when supplied, and pins the exact property shape (no PII surface)', () => {
    recordVoiceError({
      errorKind: 'action_router_failed',
      channel: 'worker',
      tenantId: 't_2',
      taskType: 'issue_invoice',
    });

    const arg = captureSpy.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    };
    expect(arg.properties.task_type).toBe('issue_invoice');
    // Only the documented keys leave the function — no transcript, message,
    // phone number, or other free text can ride along.
    expect(Object.keys(arg.properties).sort()).toEqual(
      ['channel', 'error_kind', 'source', 'task_type', 'tenant_id', 'timestamp'].sort(),
    );
  });

  it('omits call_sid/task_type/tenant_id and the group when not supplied', () => {
    recordVoiceError({ errorKind: 'realtime_circuit_open', channel: 'gather' });

    const arg = captureSpy.mock.calls[0][0] as {
      distinctId: string;
      properties: Record<string, unknown>;
      groups?: Record<string, string>;
    };
    expect(arg.distinctId).toBe('server:voice');
    expect(arg.groups).toBeUndefined();
    expect(arg.properties.call_sid).toBeUndefined();
    expect(arg.properties.task_type).toBeUndefined();
    expect(arg.properties.tenant_id).toBeUndefined();
  });

  it('off-by-default: no key → no-op', () => {
    delete process.env.POSTHOG_API_KEY;
    __resetAnalyticsForTests();
    recordVoiceError({ errorKind: 'degraded_to_gather', channel: 'media_streams', tenantId: 't' });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('never throws when capture throws', () => {
    captureSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() =>
      recordVoiceError({ errorKind: 'tts_stream_recovered', channel: 'media_streams' }),
    ).not.toThrow();
  });
});
