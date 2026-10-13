/**
 * Money-data #12 — "Connect Stripe" pressed twice (or by two admins) used to
 * create two Express accounts and persist whichever UPDATE ran last, so the
 * owner could finish KYC on an account no tenant row points at
 * (`account.updated` then matches nothing and charges never enable).
 *
 * Real Postgres: the account claim is `... WHERE stripe_connect_account_id IS
 * NULL RETURNING`, and the request that loses the claim continues with the
 * account that won. Stripe is a fake that hands out a distinct account per
 * create (the worst case: different owner emails, so no shared key).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { StripeConnectService } from '../../src/billing/stripe-connect';

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('Postgres integration — Connect account claim keeps the first persisted account', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('two racing onboarding requests persist one account and both link to it', async () => {
    const { tenantId } = await createTestTenant(pool);
    let creates = 0;
    let release: () => void = () => {};
    const bothCreating = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/accounts')) {
        creates += 1;
        const id = `acct_claim_${creates}_${tenantId.slice(0, 8)}`;
        if (creates === 2) release();
        await bothCreating; // both requests have read "no account" by now
        return json({ id });
      }
      const account = new URLSearchParams(String(init?.body)).get('account');
      return json({ url: `https://connect.stripe.com/setup/${account}` });
    };
    const svc = new StripeConnectService({
      pool,
      config: { apiKey: 'sk_test_claim_never_dialled' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const input = {
      tenantId,
      returnUrl: 'https://app.example.com/settings',
      refreshUrl: 'https://app.example.com/settings',
    };

    const [a, b] = await Promise.all([
      svc.createOnboardingLink({ ...input, ownerEmail: 'owner@example.com' }),
      svc.createOnboardingLink({ ...input, ownerEmail: 'admin@example.com' }),
    ]);

    const { rows } = await pool.query<{ stripe_connect_account_id: string; stripe_connect_status: string }>(
      `SELECT stripe_connect_account_id, stripe_connect_status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(creates).toBe(2);
    expect(a.accountId).toBe(b.accountId);
    expect(rows[0].stripe_connect_account_id).toBe(a.accountId);
    expect(rows[0].stripe_connect_status).toBe('pending');
    expect(a.url).toContain(a.accountId);
    expect(b.url).toContain(a.accountId);
  });
});
