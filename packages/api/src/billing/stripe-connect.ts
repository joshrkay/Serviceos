import type { Pool } from 'pg';
import { ValidationError, NotFoundError } from '../shared/errors';

/**
 * Tier 4 (Payment methods — PR 1). Stripe Connect onboarding service.
 * Distinct from BillingService (the Fieldly subscription portal):
 *   - BillingService bills the TENANT for the Fieldly SaaS subscription.
 *   - StripeConnectService onboards the tenant as a CONNECTED ACCOUNT
 *     so we can route their customer-facing payments through Stripe
 *     directly into their bank.
 *
 * Three responsibilities:
 *   1. Create the Stripe Connect Account on first connect + persist
 *      its id on the tenant row.
 *   2. Mint Account Links (the hosted onboarding URL) so the operator
 *      can complete KYC. Account Links expire after a short window
 *      so we mint fresh ones each time.
 *   3. Apply account.updated webhook events to the tenant's cached
 *      charges_enabled / payouts_enabled / status columns so the UI
 *      doesn't have to round-trip Stripe on every render.
 */

export type ConnectStatus = 'pending' | 'active' | 'restricted' | 'disconnected';

export interface ConnectConfig {
  apiKey: string;
}

export type ConnectFetch = typeof fetch;

export interface ConnectAccountView {
  /** Stripe account.id when one exists, else null. */
  accountId: string | null;
  status: ConnectStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

export interface StripeConnectServiceDeps {
  pool: Pool;
  config?: ConnectConfig | null;
  fetchFn?: ConnectFetch;
}

export interface CreateOnboardingLinkInput {
  tenantId: string;
  ownerEmail: string;
  /** Where Stripe sends the operator after they finish or abandon
   *  the onboarding flow. Both relative and absolute URLs are
   *  passed through to Stripe; Stripe rejects invalid ones itself. */
  returnUrl: string;
  refreshUrl: string;
  /** ISO country code (e.g. "US"). Defaults to US if not supplied. */
  country?: string;
}

/**
 * Derives the UI-friendly status from charges/payouts flags.
 * Connect onboarding can land in one of three real states:
 *   - charges_enabled === true → 'active'
 *   - charges_enabled === false but account exists → 'pending'
 *     (KYC incomplete) or 'restricted' (Stripe paused them).
 *
 * TODO(connect-restricted): we can't distinguish pending from
 * restricted without inspecting `requirements.disabled_reason` on
 * the Stripe Account object, which a future PR can pull from the
 * account.updated webhook payload (`event.data.object.requirements`).
 * Until then, both collapse to 'pending'. The 'restricted' enum
 * value, DB CHECK, and PaymentMethodsSheet branch are kept in
 * place so the refinement is a pure logic change with no schema
 * or UI churn.
 */
export function deriveConnectStatus(
  accountId: string | null,
  chargesEnabled: boolean,
  payoutsEnabled: boolean,
): ConnectStatus {
  if (!accountId) return 'pending';
  if (chargesEnabled && payoutsEnabled) return 'active';
  return 'pending';
}

export class StripeConnectService {
  constructor(private deps: StripeConnectServiceDeps) {}

  async getAccount(tenantId: string): Promise<ConnectAccountView> {
    const { rows } = await this.deps.pool.query(
      `SELECT stripe_connect_account_id,
              stripe_connect_charges_enabled,
              stripe_connect_payouts_enabled,
              stripe_connect_status
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) throw new NotFoundError('Tenant', tenantId);
    const row = rows[0] as Record<string, unknown>;
    return {
      accountId: (row.stripe_connect_account_id as string | null) ?? null,
      chargesEnabled: Boolean(row.stripe_connect_charges_enabled),
      payoutsEnabled: Boolean(row.stripe_connect_payouts_enabled),
      status: (row.stripe_connect_status as ConnectStatus) ?? 'pending',
    };
  }

  /**
   * Mints (and lazily creates the underlying Account on first call)
   * an onboarding URL. Operator goes there, completes Stripe's hosted
   * KYC, returns to `returnUrl` (which the page can poll the
   * webhook-fed status from). Account Links expire ~5 minutes from
   * issuance so we never persist them.
   */
  async createOnboardingLink(
    input: CreateOnboardingLinkInput,
  ): Promise<{ url: string; accountId: string }> {
    if (!this.deps.config?.apiKey) {
      throw new ValidationError('Stripe Connect is not configured');
    }
    if (!input.returnUrl || !input.refreshUrl) {
      throw new ValidationError('returnUrl and refreshUrl are required');
    }

    const fetchFn = this.deps.fetchFn ?? fetch;
    const apiKey = this.deps.config.apiKey;

    // Lazily create the Account if we don't already have one.
    const view = await this.getAccount(input.tenantId);
    let accountId = view.accountId;
    if (!accountId) {
      const accountRes = await fetchFn('https://api.stripe.com/v1/accounts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          type: 'express',
          email: input.ownerEmail,
          country: input.country ?? 'US',
          'capabilities[card_payments][requested]': 'true',
          'capabilities[transfers][requested]': 'true',
          'metadata[tenant_id]': input.tenantId,
        }),
      });
      if (!accountRes.ok) {
        const body = await accountRes.text();
        throw new Error(`Stripe Connect account create failed (${accountRes.status}): ${body}`);
      }
      const account = (await accountRes.json()) as { id?: string };
      if (!account.id) throw new Error('Stripe Connect returned no account id');
      accountId = account.id;
      await this.deps.pool.query(
        `UPDATE tenants
         SET stripe_connect_account_id = $1,
             stripe_connect_status = 'pending',
             updated_at = NOW()
         WHERE id = $2`,
        [accountId, input.tenantId],
      );
    }

    // Mint the Account Link.
    const linkRes = await fetchFn('https://api.stripe.com/v1/account_links', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        account: accountId,
        type: 'account_onboarding',
        return_url: input.returnUrl,
        refresh_url: input.refreshUrl,
      }),
    });
    if (!linkRes.ok) {
      const body = await linkRes.text();
      throw new Error(`Stripe Account Link create failed (${linkRes.status}): ${body}`);
    }
    const link = (await linkRes.json()) as { url?: string };
    if (!link.url) throw new Error('Stripe Account Link returned no url');
    return { url: link.url, accountId };
  }

  /**
   * Webhook entrypoint for `account.updated`. Mirrors
   * charges_enabled / payouts_enabled and recomputes the status
   * shorthand. Idempotent: writes the current snapshot, no merge.
   */
  async applyAccountUpdated(input: {
    accountId: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
  }): Promise<{ updatedTenants: number }> {
    const status = deriveConnectStatus(
      input.accountId,
      input.chargesEnabled,
      input.payoutsEnabled,
    );
    const result = await this.deps.pool.query(
      `UPDATE tenants
       SET stripe_connect_charges_enabled = $1,
           stripe_connect_payouts_enabled = $2,
           stripe_connect_status = $3,
           updated_at = NOW()
       WHERE stripe_connect_account_id = $4`,
      [input.chargesEnabled, input.payoutsEnabled, status, input.accountId],
    );
    return { updatedTenants: result.rowCount ?? 0 };
  }

  /**
   * Soft disconnect — flips status to 'disconnected' and clears the
   * enabled flags. Keeps the account_id so a re-onboard with the
   * same tenant resumes the existing Stripe Account (which Stripe
   * preserves indefinitely). Returns false when there was nothing
   * to disconnect.
   */
  async disconnect(tenantId: string): Promise<boolean> {
    const result = await this.deps.pool.query(
      `UPDATE tenants
       SET stripe_connect_status = 'disconnected',
           stripe_connect_charges_enabled = false,
           stripe_connect_payouts_enabled = false,
           updated_at = NOW()
       WHERE id = $1 AND stripe_connect_account_id IS NOT NULL
         AND stripe_connect_status != 'disconnected'`,
      [tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
