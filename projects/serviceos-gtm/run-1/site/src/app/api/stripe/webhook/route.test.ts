import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from './route';
import { signPayload } from '@/lib/stripe';
import { setNurtureEngine, stubNurtureEngine, type NurtureNotification } from '@/lib/nurture/trigger';

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'whsec_test_secret';
const received: NurtureNotification[] = [];

function webhookRequest(payload: string, signed = true): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signed) headers['stripe-signature'] = signPayload(payload, SECRET);
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers,
    body: payload,
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, STRIPE_WEBHOOK_SECRET: SECRET };
  received.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setNurtureEngine({
    notify(n) {
      received.push(n);
    },
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  setNurtureEngine(stubNurtureEngine);
  vi.restoreAllMocks();
});

function evt(obj: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, ...obj as object, ...extra });
}

describe('POST /api/stripe/webhook', () => {
  it('rejects an unsigned request (400)', async () => {
    const payload = evt({ type: 'checkout.session.completed', data: { object: {} } });
    const res = await POST(webhookRequest(payload, false));
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('rejects a tampered payload (400)', async () => {
    const payload = evt({ type: 'checkout.session.completed', data: { object: {} } });
    const req = webhookRequest(payload, true);
    // Re-create request with a different body but the old signature.
    const bad = new Request(req.url, {
      method: 'POST',
      headers: req.headers,
      body: payload + 'x',
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it('checkout.session.completed -> trial_started', async () => {
    const payload = evt({
      type: 'checkout.session.completed',
      data: {
        object: {
          object: 'checkout.session',
          id: 'cs_123',
          customer_email: 'op@example.com',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { plan: 'shop', vertical: 'HVAC', business_name: 'Acme' },
        },
      },
    });
    const res = await POST(webhookRequest(payload));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'trial_started',
      email: 'op@example.com',
      plan: 'shop',
      businessName: 'Acme',
    });
  });

  it('subscription.updated trialing->active -> trial_converted', async () => {
    const payload = evt({
      type: 'customer.subscription.updated',
      data: {
        object: { object: 'subscription', id: 'sub_1', status: 'active', customer: 'cus_1' },
        previous_attributes: { status: 'trialing' },
      },
    });
    const res = await POST(webhookRequest(payload));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('trial_converted');
  });

  it('subscription.updated -> past_due -> payment_past_due', async () => {
    const payload = evt({
      type: 'customer.subscription.updated',
      data: {
        object: { object: 'subscription', id: 'sub_1', status: 'past_due', customer: 'cus_1' },
        previous_attributes: { status: 'active' },
      },
    });
    await POST(webhookRequest(payload));
    expect(received[0].type).toBe('payment_past_due');
  });

  it('subscription.deleted -> canceled', async () => {
    const payload = evt({
      type: 'customer.subscription.deleted',
      data: { object: { object: 'subscription', id: 'sub_1', status: 'canceled', customer: 'cus_1' } },
    });
    await POST(webhookRequest(payload));
    expect(received[0].type).toBe('canceled');
  });

  it('invoice.payment_failed -> payment_failed', async () => {
    const payload = evt({
      type: 'invoice.payment_failed',
      data: { object: { object: 'invoice', id: 'in_1', customer: 'cus_1' } },
    });
    await POST(webhookRequest(payload));
    expect(received[0].type).toBe('payment_failed');
  });

  it('is idempotent by event id', async () => {
    const payload = JSON.stringify({
      id: 'evt_fixed_dup',
      type: 'checkout.session.completed',
      data: { object: { object: 'checkout.session', id: 'cs_9', customer_email: 'x@y.z', metadata: {} } },
    });
    const first = await POST(webhookRequest(payload));
    const second = await POST(webhookRequest(payload));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { duplicate?: boolean };
    expect(secondJson.duplicate).toBe(true);
    // Only the first invocation ran side effects.
    expect(received).toHaveLength(1);
  });

  it('ignores unhandled event types without side effects', async () => {
    const payload = evt({ type: 'customer.created', data: { object: { object: 'customer' } } });
    const res = await POST(webhookRequest(payload));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(0);
  });
});
