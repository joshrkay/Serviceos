import { afterEach, describe, expect, it, vi } from 'vitest';
import { portalApi } from './portal';

// Regression: ISSUE-005 / QA-087 — garbage portal tokens exposed status codes
// and serialized API JSON to customers.
// Found by /qa on 2026-07-25
// Report: .gstack/qa-reports/qa-report-app-therivetapp-com-2026-07-25.md
describe('portal error privacy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns customer-safe copy for an invalid token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":"UNAUTHORIZED","internal":"secret detail"}',
    } as Response));

    await expect(portalApi.customer('garbage-token')).rejects.toThrow(
      'Portal request failed. This link is invalid or expired.',
    );

    try {
      await portalApi.customer('garbage-token');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('401');
      expect(message).not.toContain('UNAUTHORIZED');
      expect(message).not.toContain('{');
    }
  });
});
