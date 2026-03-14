import {
  handleStripeWebhook,
  parseStripeEvent,
  StripeWebhookConfig,
} from '../../src/payments/stripe-webhook-handler';
import {
  createWebhookSignature,
  InMemoryWebhookRepository,
} from '../../src/webhooks/webhook-handler';

describe('P5-010E: Stripe webhook ingestion', () => {
  let webhookRepo: InMemoryWebhookRepository;
  const secret = 'whsec_test_secret_key';
  const config: StripeWebhookConfig = {
    webhookSecret: secret,
    toleranceSeconds: 300,
  };

  function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'evt_test_123',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_abc123',
          amount: 5000,
          currency: 'usd',
          metadata: { invoiceId: 'inv-001' },
        },
      },
      ...overrides,
    };
  }

  function signPayload(payload: Record<string, unknown>): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    const signature = createWebhookSignature(rawBody, secret);
    return { rawBody, signature };
  }

  beforeEach(() => {
    webhookRepo = new InMemoryWebhookRepository();
  });

  describe('Happy path: valid webhook processed', () => {
    it('should process a valid payment_intent.succeeded webhook', async () => {
      const payload = makePayload();
      const { rawBody, signature } = signPayload(payload);

      const result = await handleStripeWebhook(rawBody, signature, config, webhookRepo);

      expect(result.eventType).toBe('payment_intent.succeeded');
      expect(result.invoiceId).toBe('inv-001');
      expect(result.amountCents).toBe(5000);
      expect(result.currency).toBe('usd');
      expect(result.paymentIntentId).toBe('pi_abc123');
      expect(result.duplicate).toBe(false);
    });

    it('should process a checkout.session.completed webhook', async () => {
      const payload = makePayload({
        id: 'evt_checkout_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            amount_total: 7500,
            currency: 'usd',
            payment_intent: 'pi_xyz789',
            metadata: { invoiceId: 'inv-002' },
          },
        },
      });
      const { rawBody, signature } = signPayload(payload);

      const result = await handleStripeWebhook(rawBody, signature, config, webhookRepo);

      expect(result.eventType).toBe('checkout.session.completed');
      expect(result.invoiceId).toBe('inv-002');
      expect(result.amountCents).toBe(7500);
      expect(result.paymentIntentId).toBe('pi_xyz789');
      expect(result.duplicate).toBe(false);
    });
  });

  describe('Signature verification: invalid signature rejected', () => {
    it('should reject webhook with invalid signature', async () => {
      const payload = makePayload();
      const rawBody = JSON.stringify(payload);
      const badSignature = 't=1234567890,v1=invalidsignaturehex';

      await expect(
        handleStripeWebhook(rawBody, badSignature, config, webhookRepo)
      ).rejects.toThrow('Invalid webhook signature');
    });

    it('should reject webhook with empty signature', async () => {
      const payload = makePayload();
      const rawBody = JSON.stringify(payload);

      await expect(
        handleStripeWebhook(rawBody, '', config, webhookRepo)
      ).rejects.toThrow('Invalid webhook signature');
    });
  });

  describe('Idempotency: duplicate event detected', () => {
    it('should detect duplicate events', async () => {
      const payload = makePayload();
      const { rawBody, signature } = signPayload(payload);

      const first = await handleStripeWebhook(rawBody, signature, config, webhookRepo);
      expect(first.duplicate).toBe(false);

      // Send the same event again (re-sign since timestamp changes)
      const { rawBody: rawBody2, signature: sig2 } = signPayload(payload);
      const second = await handleStripeWebhook(rawBody2, sig2, config, webhookRepo);
      expect(second.duplicate).toBe(true);
    });
  });

  describe('Event parsing: different event types parsed', () => {
    it('should parse payment_intent.succeeded', () => {
      const payload = makePayload();
      const parsed = parseStripeEvent(payload);

      expect(parsed.eventType).toBe('payment_intent.succeeded');
      expect(parsed.invoiceId).toBe('inv-001');
      expect(parsed.amountCents).toBe(5000);
      expect(parsed.paymentIntentId).toBe('pi_abc123');
    });

    it('should parse payment_intent.payment_failed', () => {
      const payload = makePayload({
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_failed',
            amount: 3000,
            currency: 'eur',
            metadata: { invoiceId: 'inv-003' },
          },
        },
      });
      const parsed = parseStripeEvent(payload);

      expect(parsed.eventType).toBe('payment_intent.payment_failed');
      expect(parsed.invoiceId).toBe('inv-003');
      expect(parsed.amountCents).toBe(3000);
      expect(parsed.currency).toBe('eur');
    });

    it('should parse checkout.session.completed with client_reference_id fallback', () => {
      const payload = makePayload({
        type: 'checkout.session.completed',
        data: {
          object: {
            amount_total: 2000,
            currency: 'usd',
            payment_intent: 'pi_ref',
            client_reference_id: 'inv-fallback',
            metadata: {},
          },
        },
      });
      const parsed = parseStripeEvent(payload);

      expect(parsed.eventType).toBe('checkout.session.completed');
      expect(parsed.invoiceId).toBe('inv-fallback');
    });
  });

  describe('Validation: malformed body rejected', () => {
    it('should reject non-JSON body', async () => {
      const rawBody = 'not-json';
      const signature = createWebhookSignature(rawBody, secret);

      await expect(
        handleStripeWebhook(rawBody, signature, config, webhookRepo)
      ).rejects.toThrow('Malformed webhook body');
    });

    it('should reject payload missing event type', () => {
      expect(() => parseStripeEvent({ data: { object: {} } })).toThrow('Missing event type');
    });

    it('should reject payload missing data.object', () => {
      expect(() => parseStripeEvent({ type: 'payment_intent.succeeded' })).toThrow('Missing data.object');
    });
  });
});
