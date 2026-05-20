/**
 * Production must refuse noop invoice delivery — send_invoice would succeed
 * without delivering bytes. Static source assertion (no full app boot).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('invoice delivery boot guard (source)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

  it('throws in prod/staging when SendService is not configured', () => {
    expect(src).toMatch(/config\.NODE_ENV === 'prod' \|\| config\.NODE_ENV === 'staging'/);
    expect(src).toMatch(/invoice delivery provider configured/i);
    expect(src).toMatch(/new NoopInvoiceDeliveryProvider\(\)/);
    expect(src).toMatch(
      /SendServiceInvoiceDeliveryProvider[\s\S]*config\.NODE_ENV === 'prod'[\s\S]*throw new Error/,
    );
    // messageDelivery must not fall back to InMemory in prod/staging without creds
    expect(src).toMatch(
      /messageDelivery[\s\S]*config\.NODE_ENV === 'prod' \|\| config\.NODE_ENV === 'staging'[\s\S]*\? null/,
    );
  });
});
