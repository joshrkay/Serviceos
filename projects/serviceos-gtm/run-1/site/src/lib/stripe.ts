/**
 * All Stripe calls live here. We talk to the Stripe REST API directly via fetch
 * (no SDK dependency) so the module is trivially mockable in tests and keeps the
 * deploy bundle small.
 *
 * HARD GUARDRAIL: this build is test-mode only. If a secret key is present and it
 * is NOT an `sk_test_` key, every call throws. Live keys must never be exercised
 * from this GTM preview build.
 */

import crypto from 'node:crypto';
import { TRIAL_PERIOD_DAYS } from './plans';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export const LIVE_KEY_BLOCKED_MESSAGE =
  'Live Stripe keys are blocked in this build (guardrail: test mode only)';

/** Returns the configured secret key, or null when unset (demo mode). */
export function getStripeSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key && key.length > 0 ? key : null;
}

export function hasStripeKey(): boolean {
  return getStripeSecretKey() !== null;
}

/**
 * Enforce the test-mode guardrail. Throws when a key is present but is not an
 * `sk_test_` key. Returns the validated key when it is safe to use.
 */
export function assertTestModeKey(): string {
  const key = getStripeSecretKey();
  if (!key) {
    throw new Error('Stripe secret key is not configured');
  }
  if (!key.startsWith('sk_test_')) {
    throw new Error(LIVE_KEY_BLOCKED_MESSAGE);
  }
  return key;
}

export interface CreateCheckoutSessionInput {
  priceId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/**
 * Encode a nested params object into application/x-www-form-urlencoded form,
 * matching Stripe's bracket convention (e.g. subscription_data[trial_period_days]).
 */
export function encodeStripeForm(
  input: Record<string, unknown>,
  parentKey = '',
): URLSearchParams {
  const params = new URLSearchParams();

  const append = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const arrayKey = `${key}[${index}]`;
        if (typeof item === 'object' && item !== null) {
          for (const [ik, iv] of encodeStripeForm(item as Record<string, unknown>, arrayKey)) {
            params.append(ik, iv);
          }
        } else {
          params.append(arrayKey, String(item));
        }
      });
    } else if (typeof value === 'object') {
      for (const [ik, iv] of encodeStripeForm(value as Record<string, unknown>, key)) {
        params.append(ik, iv);
      }
    } else {
      params.append(key, String(value));
    }
  };

  for (const [k, v] of Object.entries(input)) {
    const composedKey = parentKey ? `${parentKey}[${k}]` : k;
    append(composedKey, v);
  }
  return params;
}

/**
 * Create a Stripe Checkout Session (mode=subscription) with a 14-day trial.
 * Enforces the test-mode guardrail before making any network call.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSession> {
  const key = assertTestModeKey();

  const body = encodeStripeForm({
    mode: 'subscription',
    customer_email: input.customerEmail,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    line_items: [{ price: input.priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_PERIOD_DAYS,
      metadata: input.metadata,
    },
    metadata: input.metadata,
  });

  const res = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Stripe checkout session creation failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { id?: string; url?: string };
  if (!json.id || !json.url) {
    throw new Error('Stripe returned an incomplete checkout session');
  }
  return { id: json.id, url: json.url };
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header) using
 * HMAC-SHA256, implemented directly so we need no SDK. Mirrors Stripe's scheme:
 * signed_payload = `${timestamp}.${rawBody}`, compared against the v1 signatures.
 *
 * @param toleranceSeconds  Reject events whose timestamp is older than this many
 *                          seconds (replay protection). Set to 0 to disable.
 */
export function verifyWebhookSignature(params: {
  payload: string;
  signatureHeader: string | null;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): { valid: boolean; reason?: string } {
  const { payload, signatureHeader, secret } = params;
  const tolerance = params.toleranceSeconds ?? 300;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!signatureHeader) {
    return { valid: false, reason: 'missing signature header' };
  }

  let timestamp: string | null = null;
  const v1Signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [prefix, value] = part.split('=');
    if (prefix === 't') timestamp = value;
    else if (prefix === 'v1' && value) v1Signatures.push(value);
  }

  if (!timestamp || v1Signatures.length === 0) {
    return { valid: false, reason: 'malformed signature header' };
  }

  if (tolerance > 0) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) {
      return { valid: false, reason: 'timestamp outside tolerance' };
    }
  }

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');

  const matched = v1Signatures.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    return (
      candidateBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidateBuf, expectedBuf)
    );
  });

  return matched ? { valid: true } : { valid: false, reason: 'signature mismatch' };
}

/**
 * Test helper: produce a valid `Stripe-Signature` header for a payload+secret.
 * Exported so tests (and local tooling) can construct signed fixtures.
 */
export function signPayload(payload: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${ts},v1=${signature}`;
}
