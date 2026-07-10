import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST } from './route';

const ORIGINAL_ENV = { ...process.env };

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  businessName: 'Acme HVAC',
  yourName: 'Dana Operator',
  email: 'dana@acme.example',
  vertical: 'HVAC',
  plan: 'shop',
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('POST /api/checkout', () => {
  it('demo mode (no key): returns a demo-checkout url', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string };
    expect(json.url.startsWith('/signup/demo-checkout?')).toBe(true);
    expect(json.url).toContain('plan=shop');
    expect(json.url).toContain('email=dana%40acme.example');
  });

  it('real mode: creates a Stripe session with the plan price id', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    process.env.STRIPE_PRICE_ID_SHOP = 'price_shop_live';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://site.example';

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      expect(body).toContain('line_items%5B0%5D%5Bprice%5D=price_shop_live');
      expect(body).toContain('subscription_data%5Btrial_period_days%5D=14');
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/pay' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string };
    expect(json.url).toBe('https://checkout.stripe.com/pay');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the correct price id per plan (pro)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    process.env.STRIPE_PRICE_ID_PRO = 'price_pro_xyz';

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(String(init.body)).toContain('line_items%5B0%5D%5Bprice%5D=price_pro_xyz');
      return new Response(JSON.stringify({ id: 'cs_2', url: 'https://checkout.stripe.com/pro' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(makeRequest({ ...validBody, plan: 'pro' }));
    expect(res.status).toBe(200);
  });

  it('blocks live keys with the guardrail (500)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_danger';
    process.env.STRIPE_PRICE_ID_SHOP = 'price_shop';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('Live Stripe keys are blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates input (400 on bad email)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await POST(makeRequest({ ...validBody, email: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('validates plan (400 on unknown plan)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await POST(makeRequest({ ...validBody, plan: 'enterprise' }));
    expect(res.status).toBe(400);
  });
});
