import { describe, it, expect } from 'vitest';
import { CollectPaymentPanel } from './CollectPaymentPanel';

/**
 * Class-contract: primary collect control must stay ≥44px (min-h-11).
 * We assert the source contract rather than mounting RN (vitest, not jest-expo).
 */
describe('CollectPaymentPanel tap targets', () => {
  it('exports CollectPaymentPanel', () => {
    expect(typeof CollectPaymentPanel).toBe('function');
  });

  it('collect button uses min-h-11 in source', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.join(__dirname, 'CollectPaymentPanel.tsx'),
      'utf8',
    );
    expect(src).toContain('min-h-11');
    expect(src).toContain('testID="collect-payment-button"');
    expect(src).toContain('CONNECT_REQUIRED');
  });
});
