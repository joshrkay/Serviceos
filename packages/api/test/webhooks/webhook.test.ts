import {
  verifyWebhookSignature,
  createWebhookSignature,
  handleWebhookEvent,
  InMemoryWebhookRepository,
} from '../../src/webhooks/webhook-handler';

describe('P0-014 — Webhook security and idempotency foundation', () => {
  const secret = 'whsec_test_secret_key';

  it('happy path — verifies valid signature', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createWebhookSignature(payload, secret, timestamp);

    const valid = verifyWebhookSignature(payload, signature, secret);
    expect(valid).toBe(true);
  });

  it('validation — rejects invalid signature', () => {
    const payload = JSON.stringify({ event: 'test' });
    const valid = verifyWebhookSignature(payload, 't=123,v1=invalid', secret);
    expect(valid).toBe(false);
  });

  it('validation — rejects expired timestamp', () => {
    const payload = JSON.stringify({ event: 'test' });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const signature = createWebhookSignature(payload, secret, oldTimestamp);

    const valid = verifyWebhookSignature(payload, signature, secret, 300);
    expect(valid).toBe(false);
  });

  it('validation — rejects empty inputs', () => {
    expect(verifyWebhookSignature('', 'sig', secret)).toBe(false);
    expect(verifyWebhookSignature('payload', '', secret)).toBe(false);
    expect(verifyWebhookSignature('payload', 'sig', '')).toBe(false);
  });

  it('happy path — handleWebhookEvent creates new event', async () => {
    const repo = new InMemoryWebhookRepository();
    const { event, duplicate } = await handleWebhookEvent(
      'stripe',
      'payment.completed',
      { amount: 100 },
      'evt_123',
      repo
    );

    expect(duplicate).toBe(false);
    expect(event.source).toBe('stripe');
    expect(event.eventType).toBe('payment.completed');
    expect(event.status).toBe('received');
  });

  it('happy path — handleWebhookEvent detects duplicate', async () => {
    const repo = new InMemoryWebhookRepository();
    await handleWebhookEvent('stripe', 'payment.completed', { amount: 100 }, 'evt_123', repo);
    const { duplicate } = await handleWebhookEvent(
      'stripe',
      'payment.completed',
      { amount: 100 },
      'evt_123',
      repo
    );

    expect(duplicate).toBe(true);
  });

  it('validation — malformed signature format rejected', () => {
    const valid = verifyWebhookSignature('payload', 'no-format', secret);
    expect(valid).toBe(false);
  });
});
