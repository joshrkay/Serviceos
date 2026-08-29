import { describe, it, expect } from 'vitest';
import { parsePortalFailure } from './billing-error';

function response(body: unknown, status = 502, json = true): Response {
  return {
    ok: false,
    status,
    json: async () => {
      if (!json) throw new SyntaxError('Unexpected token');
      return body;
    },
  } as unknown as Response;
}

describe('parsePortalFailure (#873)', () => {
  it('surfaces the structured message and details.stripeCode', async () => {
    const failure = await parsePortalFailure(
      response({
        error: 'BILLING_PORTAL_FAILED',
        message:
          "Stripe couldn't open the billing portal: No such customer: 'cus_UswJPdKUh7f1eg' The saved Stripe customer for this account no longer exists — contact support to re-link billing.",
        details: { stripeStatus: 404, stripeCode: 'resource_missing' },
      }),
    );
    expect(failure.message).toContain('contact support to re-link billing');
    expect(failure.stripeCode).toBe('resource_missing');
  });

  it('tolerates a flattened top-level stripeCode', async () => {
    const failure = await parsePortalFailure(
      response({ message: 'Stripe failure', stripeCode: 'resource_missing' }),
    );
    expect(failure.message).toBe('Stripe failure');
    expect(failure.stripeCode).toBe('resource_missing');
  });

  it('falls back to the old message-only shape', async () => {
    const failure = await parsePortalFailure(
      response({ error: 'BILLING_PORTAL_FAILED', message: 'Stripe rejected the request' }),
    );
    expect(failure.message).toBe('Stripe rejected the request');
    expect(failure.stripeCode).toBeUndefined();
  });

  it('crafts the re-link message when resource_missing arrives without a message', async () => {
    const failure = await parsePortalFailure(
      response({ details: { stripeCode: 'resource_missing' } }),
    );
    expect(failure.message).toContain('no longer exists');
    expect(failure.message).toContain('contact support');
  });

  it('falls back to an HTTP-status message for a non-JSON body', async () => {
    const failure = await parsePortalFailure(response(null, 502, false));
    expect(failure.message).toBe("Couldn't open the billing portal (HTTP 502). Try again in a moment.");
    expect(failure.stripeCode).toBeUndefined();
  });

  it('ignores blank / non-string fields', async () => {
    const failure = await parsePortalFailure(
      response({ message: '   ', details: { stripeCode: 42 } }, 500),
    );
    expect(failure.message).toBe("Couldn't open the billing portal (HTTP 500). Try again in a moment.");
    expect(failure.stripeCode).toBeUndefined();
  });
});
