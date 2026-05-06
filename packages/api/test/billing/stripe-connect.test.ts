import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StripeConnectService,
  deriveConnectStatus,
} from '../../src/billing/stripe-connect';

const TENANT = '22222222-2222-4222-8222-222222222222';

function makePool(initial: Record<string, unknown> = {}) {
  const state = {
    accountId: (initial.stripe_connect_account_id as string | null) ?? null,
    chargesEnabled: Boolean(initial.stripe_connect_charges_enabled),
    payoutsEnabled: Boolean(initial.stripe_connect_payouts_enabled),
    status: (initial.stripe_connect_status as string) ?? 'pending',
  };
  const queryMock = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT stripe_connect_account_id')) {
      return {
        rows: [
          {
            stripe_connect_account_id: state.accountId,
            stripe_connect_charges_enabled: state.chargesEnabled,
            stripe_connect_payouts_enabled: state.payoutsEnabled,
            stripe_connect_status: state.status,
          },
        ],
      };
    }
    // Order matters — the disconnect UPDATE sets BOTH
    // stripe_connect_status = 'disconnected' AND
    // stripe_connect_charges_enabled = false, so we check the
    // disconnect-specific marker first.
    if (sql.includes("stripe_connect_status = 'disconnected'") && sql.includes('!= ')) {
      if (!state.accountId || state.status === 'disconnected') {
        return { rows: [], rowCount: 0 };
      }
      state.status = 'disconnected';
      state.chargesEnabled = false;
      state.payoutsEnabled = false;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE tenants') && sql.includes('stripe_connect_account_id = $1')) {
      // create-account path persists the new id.
      state.accountId = params?.[0] as string;
      state.status = 'pending';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE tenants') && sql.includes('stripe_connect_charges_enabled = $1')) {
      // applyAccountUpdated. The $1/$2/$3 binding distinguishes it
      // from the disconnect UPDATE (which uses literals).
      state.chargesEnabled = params?.[0] as boolean;
      state.payoutsEnabled = params?.[1] as boolean;
      state.status = params?.[2] as string;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  });
  return { pool: { query: queryMock } as never, state, queryMock };
}

function jsonOk(body: unknown): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => body, text: async () => JSON.stringify(body),
  } as unknown as Response;
}
function jsonErr(status: number, body: unknown): Response {
  return {
    ok: false, status, statusText: 'Error',
    json: async () => body, text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('deriveConnectStatus (PR 1)', () => {
  it('returns pending when no account id', () => {
    expect(deriveConnectStatus(null, true, true)).toBe('pending');
  });
  it('returns active when both flags true', () => {
    expect(deriveConnectStatus('acct_x', true, true)).toBe('active');
  });
  it('returns pending when only charges enabled (KYC partial)', () => {
    expect(deriveConnectStatus('acct_x', true, false)).toBe('pending');
  });
  it('returns pending when both flags false but account exists', () => {
    expect(deriveConnectStatus('acct_x', false, false)).toBe('pending');
  });
});

describe('StripeConnectService (PR 1)', () => {
  it('getAccount returns null/false fields for a fresh tenant', async () => {
    const { pool } = makePool({});
    const svc = new StripeConnectService({ pool });
    const view = await svc.getAccount(TENANT);
    expect(view.accountId).toBeNull();
    expect(view.chargesEnabled).toBe(false);
    expect(view.payoutsEnabled).toBe(false);
    expect(view.status).toBe('pending');
  });

  it('getAccount mirrors persisted state when an account exists', async () => {
    const { pool } = makePool({
      stripe_connect_account_id: 'acct_existing',
      stripe_connect_charges_enabled: true,
      stripe_connect_payouts_enabled: true,
      stripe_connect_status: 'active',
    });
    const svc = new StripeConnectService({ pool });
    const view = await svc.getAccount(TENANT);
    expect(view.accountId).toBe('acct_existing');
    expect(view.status).toBe('active');
  });

  it('createOnboardingLink throws when not configured', async () => {
    const { pool } = makePool({});
    const svc = new StripeConnectService({ pool });
    await expect(
      svc.createOnboardingLink({
        tenantId: TENANT,
        ownerEmail: 'o@example.com',
        returnUrl: 'https://app.example.com/settings',
        refreshUrl: 'https://app.example.com/settings',
      }),
    ).rejects.toThrow(/not configured/i);
  });

  it('createOnboardingLink lazily creates the Account on first call', async () => {
    const { pool, state } = makePool({});
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/accounts') && !url.includes('/account_links')) {
        return jsonOk({ id: 'acct_new123' });
      }
      if (url.includes('/v1/account_links')) {
        return jsonOk({ url: 'https://connect.stripe.com/setup/acct_new123' });
      }
      return jsonErr(404, {});
    });
    const svc = new StripeConnectService({
      pool,
      config: { apiKey: 'sk_test' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const result = await svc.createOnboardingLink({
      tenantId: TENANT,
      ownerEmail: 'o@example.com',
      returnUrl: 'https://app.example.com/settings',
      refreshUrl: 'https://app.example.com/settings',
    });
    expect(result.accountId).toBe('acct_new123');
    expect(result.url).toContain('connect.stripe.com');
    expect(state.accountId).toBe('acct_new123'); // persisted
    // Two fetches: account create + account link.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('createOnboardingLink reuses an existing Account on subsequent calls', async () => {
    const { pool } = makePool({
      stripe_connect_account_id: 'acct_existing',
      stripe_connect_status: 'pending',
    });
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/account_links')) {
        return jsonOk({ url: 'https://connect.stripe.com/setup/acct_existing' });
      }
      return jsonErr(404, {});
    });
    const svc = new StripeConnectService({
      pool,
      config: { apiKey: 'sk_test' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const result = await svc.createOnboardingLink({
      tenantId: TENANT,
      ownerEmail: 'o@example.com',
      returnUrl: 'https://app.example.com/settings',
      refreshUrl: 'https://app.example.com/settings',
    });
    expect(result.accountId).toBe('acct_existing');
    // Only one fetch — the Account create call was skipped.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('applyAccountUpdated mirrors charges + payouts flags onto the tenant row', async () => {
    const { pool, state } = makePool({
      stripe_connect_account_id: 'acct_x',
      stripe_connect_status: 'pending',
    });
    const svc = new StripeConnectService({ pool });
    const result = await svc.applyAccountUpdated({
      accountId: 'acct_x',
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    expect(result.updatedTenants).toBe(1);
    expect(state.chargesEnabled).toBe(true);
    expect(state.payoutsEnabled).toBe(true);
    expect(state.status).toBe('active');
  });

  it('applyAccountUpdated for partial KYC stays pending', async () => {
    const { pool, state } = makePool({
      stripe_connect_account_id: 'acct_x',
    });
    const svc = new StripeConnectService({ pool });
    await svc.applyAccountUpdated({
      accountId: 'acct_x',
      chargesEnabled: true,
      payoutsEnabled: false,
    });
    expect(state.status).toBe('pending');
  });

  it('disconnect flips status when account exists', async () => {
    const { pool, state } = makePool({
      stripe_connect_account_id: 'acct_x',
      stripe_connect_charges_enabled: true,
      stripe_connect_status: 'active',
    });
    const svc = new StripeConnectService({ pool });
    const ok = await svc.disconnect(TENANT);
    expect(ok).toBe(true);
    expect(state.status).toBe('disconnected');
    expect(state.chargesEnabled).toBe(false);
  });

  it('disconnect is a no-op when no account / already disconnected', async () => {
    const { pool } = makePool({});
    const svc = new StripeConnectService({ pool });
    expect(await svc.disconnect(TENANT)).toBe(false);
  });
});
