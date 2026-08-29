/**
 * #873 — extract the actionable reason from a failed
 * POST /api/billing/portal-session response.
 *
 * The API's error envelope is `{ error, message, details? }`;
 * billingPortalStripeFailure (api/src/billing/subscription.ts) returns
 * BILLING_PORTAL_FAILED with `details.stripeCode` (e.g.
 * 'resource_missing' when the saved Stripe customer no longer exists)
 * and a message that already carries the re-link guidance. Older or
 * partial emissions may carry only a message string — or no JSON at
 * all — so every field is optional and there is always a usable
 * fallback, letting web and api halves of #873 land independently.
 */
export interface BillingPortalFailure {
  /** Human-readable, actionable reason — always non-empty. */
  message: string;
  /** Stripe error code when the server surfaced one. */
  stripeCode?: string;
}

export async function parsePortalFailure(res: Response): Promise<BillingPortalFailure> {
  let message = '';
  let stripeCode: string | undefined;
  try {
    const body = (await res.json()) as {
      message?: unknown;
      details?: { stripeCode?: unknown } | null;
      stripeCode?: unknown;
    } | null;
    if (typeof body?.message === 'string' && body.message.trim()) {
      message = body.message.trim();
    }
    // Canonical location is details.stripeCode; tolerate a flattened
    // top-level stripeCode too.
    const code = body?.details?.stripeCode ?? body?.stripeCode;
    if (typeof code === 'string' && code.trim()) {
      stripeCode = code.trim();
    }
  } catch {
    /* non-JSON body */
  }
  if (!message) {
    message =
      stripeCode === 'resource_missing'
        ? 'The saved Stripe billing account for this tenant no longer exists — contact support to re-link billing.'
        : `Couldn't open the billing portal (HTTP ${res.status}). Try again in a moment.`;
  }
  return { message, stripeCode };
}
