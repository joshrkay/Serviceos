/**
 * AnalyticsIdentityBridge — verifies auth state is mirrored into the analytics
 * layer: on sign-in, identify() carries person traits and groupTenant() binds
 * the tenant group; on sign-out, resetIdentity() clears. PostHog itself is not
 * exercised here (the wrapper module is mocked) — this pins the wiring.
 */
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MeResponse } from '@ai-service-os/shared';

const authState = {
  isLoaded: true,
  isSignedIn: true as boolean,
  userId: 'user_clerk_1' as string | null,
};
const userState = {
  user: {
    primaryEmailAddress: { emailAddress: 'owner@acme.com' },
    firstName: 'Ada',
    lastName: 'Lovelace',
  } as unknown,
};
const meState = { me: null as MeResponse | null };

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({
    isLoaded: authState.isLoaded,
    isSignedIn: authState.isSignedIn,
    userId: authState.userId,
  }),
  useUser: () => ({ user: userState.user }),
}));

vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({
    me: meState.me,
    isLoading: false,
    error: null,
    switchMode: vi.fn(),
    refetch: vi.fn(),
  }),
}));

const identifySpy = vi.fn();
const groupTenantSpy = vi.fn();
const resetIdentitySpy = vi.fn();
vi.mock('../../lib/analytics', () => ({
  identify: (...args: unknown[]) => identifySpy(...args),
  groupTenant: (...args: unknown[]) => groupTenantSpy(...args),
  resetIdentity: (...args: unknown[]) => resetIdentitySpy(...args),
}));

import { AnalyticsIdentityBridge } from './AnalyticsIdentityBridge';

const fakeMe = (over: Partial<MeResponse> = {}): MeResponse =>
  ({
    user_id: 'user_clerk_1',
    tenant_id: 'tenant_42',
    role: 'owner',
    can_field_serve: true,
    current_mode: 'supervisor',
    mode_changed_at: null,
    permissions: [],
    backup_supervisor_user_id: null,
    timezone: 'America/New_York',
    unsupervised_proposal_routing: 'queue_and_sms',
    ...over,
  }) as MeResponse;

describe('AnalyticsIdentityBridge', () => {
  beforeEach(() => {
    identifySpy.mockClear();
    groupTenantSpy.mockClear();
    resetIdentitySpy.mockClear();
    authState.isLoaded = true;
    authState.isSignedIn = true;
    authState.userId = 'user_clerk_1';
    meState.me = null;
  });

  it('identifies with person traits and binds the tenant group when me is loaded', () => {
    meState.me = fakeMe();
    render(<AnalyticsIdentityBridge />);

    expect(identifySpy).toHaveBeenCalledWith('user_clerk_1', {
      emailDomain: 'acme.com',
      role: 'owner',
      current_mode: 'supervisor',
      can_field_serve: true,
    });
    expect(groupTenantSpy).toHaveBeenCalledWith('tenant_42', {
      timezone: 'America/New_York',
    });
    expect(resetIdentitySpy).not.toHaveBeenCalled();
  });

  it('identifies with only emailDomain (no person traits, no group) before me resolves', () => {
    meState.me = null;
    render(<AnalyticsIdentityBridge />);

    expect(identifySpy).toHaveBeenCalledWith('user_clerk_1', { emailDomain: 'acme.com' });
    expect(groupTenantSpy).not.toHaveBeenCalled();
  });

  it('omits timezone traits when the tenant has none but still groups', () => {
    meState.me = fakeMe({ timezone: undefined });
    render(<AnalyticsIdentityBridge />);

    expect(groupTenantSpy).toHaveBeenCalledWith('tenant_42', undefined);
  });

  it('resets identity and does not group when signed out', () => {
    authState.isSignedIn = false;
    authState.userId = null;
    render(<AnalyticsIdentityBridge />);

    expect(resetIdentitySpy).toHaveBeenCalledTimes(1);
    expect(identifySpy).not.toHaveBeenCalled();
    expect(groupTenantSpy).not.toHaveBeenCalled();
  });
});
