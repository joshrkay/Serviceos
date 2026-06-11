import type { Pool } from 'pg';
import { ValidationError, NotFoundError } from '../shared/errors';

/**
 * Tier 4 (Payment methods — PR 1). Stripe Connect onboarding service.
 * Distinct from BillingService (the Rivet subscription portal):
 *   - BillingService bills the TENANT for the Rivet SaaS subscription.
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
 * Stripe `account.requirements.disabled_reason` values that mean
 * "Stripe has paused this account — the operator cannot self-resolve
 * by completing KYC". For any of these we surface 'restricted' so the
 * UI can show a "contact support" prompt rather than "finish
 * onboarding". All OTHER disabled_reasons (`requirements.past_due`,
 * `requirements.pending_verification`, etc.) are user-resolvable and
 * stay 'pending'.
 *
 * Source: https://stripe.com/docs/api/accounts/object#account_object-requirements-disabled_reason
 *   - rejected.fraud           — Stripe rejected the account for fraud
 *   - rejected.terms_of_service — Stripe rejected for ToS violation
 *   - rejected.listed          — Stripe rejected because the account
 *                                was on a prohibited / blocked list
 *   - rejected.other           — Stripe rejected for an unspecified
 *                                reason (still operator-unrecoverable)
 *   - listed                   — Account appeared on a third-party
 *                                prohibited list (under investigation)
 *   - under_review             — Stripe Risk is reviewing the account
 *                                and has paused charges/payouts
 */
export const RESTRICTED_DISABLED_REASONS: ReadonlySet<string> = new Set([
  'rejected.fraud',
  'rejected.terms_of_service',
  'rejected.listed',
  'rejected.other',
  'listed',
  'under_review',
]);

/**
 * Subset of the Stripe `Account` object we read for status derivation.
 * Matches the shape Stripe sends on `account.updated` webhooks; all
 * fields are optional because Stripe omits absent ones.
 */
export interface StripeAccountSnapshot {
  id?: string | null;
  /** Stripe sets this on the event object when the account was deleted. */
  deleted?: boolean;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: {
    disabled_reason?: string | null;
    currently_due?: string[] | null;
  } | null;
}

/**
 * Maps a Stripe Account snapshot to the cached ConnectStatus.
 *
 * Order matters:
 *   1. `deleted` flag → 'disconnected' (account removed from Stripe)
 *   2. fully enabled (charges + payouts) → 'active'
 *   3. `requirements.disabled_reason` in RESTRICTED_DISABLED_REASONS
 *      → 'restricted' (Stripe paused them — operator can't self-fix)
 *   4. anything else → 'pending' (KYC incomplete or user-resolvable
 *      requirements outstanding)
 *
 * Note: a `disabled_reason` of `requirements.pending_verification` or
 * `requirements.past_due` is the operator's to fix (upload docs,
 * update info), so we stay 'pending' rather than scaring them with
 * "contact support".
 */
export function mapAccountToStatus(account: StripeAccountSnapshot): ConnectStatus {
  if (account.deleted) return 'disconnected';
  if (!account.id) return 'pending';
  if (account.charges_enabled === true && account.payouts_enabled === true) {
    return 'active';
  }
  const reason = account.requirements?.disabled_reason ?? null;
  if (reason && RESTRICTED_DISABLED_REASONS.has(reason)) {
    return 'restricted';
  }
  return 'pending';
}

/**
 * Backwards-compatible derivation that works from just the cached
 * boolean flags (no requirements payload). Used by callers that only
 * have the persisted columns to work from. New code should prefer
 * `mapAccountToStatus` which can also emit 'restricted'.
 */
export function deriveConnectStatus(
  accountId: string | null,
  chargesEnabled: boolean,
  payoutsEnabled: boolean,
  options: { disabledReason?: string | null } = {},
): ConnectStatus {
  return mapAccountToStatus({
    id: accountId ?? undefined,
    charges_enabled: chargesEnabled,
    payouts_enabled: payoutsEnabled,
    requirements: options.disabledReason
      ? { disabled_reason: options.disabledReason }
      : null,
  });
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
   *
   * `disabledReason` is the raw `requirements.disabled_reason` from
   * the Stripe Account; we use it to distinguish 'restricted'
   * (Stripe paused us — operator must contact support) from 'pending'
   * (operator can self-resolve by finishing KYC). `deleted` flips the
   * status to 'disconnected' when Stripe sent an account.deleted-style
   * payload (or the account otherwise no longer exists upstream).
   */
  async applyAccountUpdated(input: {
    accountId: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    disabledReason?: string | null;
    detailsSubmitted?: boolean;
    deleted?: boolean;
  }): Promise<{ updatedTenants: number }> {
    const status = mapAccountToStatus({
      id: input.accountId,
      deleted: input.deleted,
      charges_enabled: input.chargesEnabled,
      payouts_enabled: input.payoutsEnabled,
      details_submitted: input.detailsSubmitted,
      requirements: { disabled_reason: input.disabledReason ?? null },
    });
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
