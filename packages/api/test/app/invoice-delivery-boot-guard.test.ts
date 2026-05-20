/**
 * Production must refuse noop invoice delivery — send_invoice would succeed
 * without delivering bytes. Static source assertion (no full app boot).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('invoice delivery boot guard (source)', () => {
  const appSrc = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');
  const factorySrc = readFileSync(
    resolve(__dirname, '../../src/proposals/execution/invoice-delivery-factory.ts'),
    'utf8',
  );

  it('throws in prod/staging when SendService is not configured', () => {
    expect(appSrc).toMatch(/resolveInvoiceDeliveryProvider/);
    expect(appSrc).toMatch(/nodeEnv:\s*config\.NODE_ENV/);
    expect(factorySrc).toMatch(/opts\.nodeEnv === 'prod'/);
    expect(factorySrc).toMatch(/opts\.nodeEnv === 'staging'/);
    expect(factorySrc).toMatch(/SendService|delivery/i);
    expect(factorySrc).toMatch(/new NoopInvoiceDeliveryProvider\(\)/);
    expect(factorySrc).toMatch(/SendServiceInvoiceDeliveryProvider/);
    // messageDelivery must not fall back to InMemory in prod/staging without creds
    expect(appSrc).toMatch(
      /messageDelivery[\s\S]*config\.NODE_ENV === 'prod' \|\| config\.NODE_ENV === 'staging'[\s\S]*\? null/,
    );
  });
});
