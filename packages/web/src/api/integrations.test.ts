import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { connectQuickBooks } from './integrations';

describe('connectQuickBooks', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it("surfaces the server's upgrade message when the plan does not include QuickBooks", async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'PLAN_UPGRADE_REQUIRED',
          message: 'QuickBooks sync is part of Growth. Upgrade to connect your Intuit account.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(connectQuickBooks('/settings')).rejects.toThrow(
      'QuickBooks sync is part of Growth. Upgrade to connect your Intuit account.',
    );
  });

  it('falls back to the status when the error body has no message', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response('oops', { status: 502 }));
    await expect(connectQuickBooks()).rejects.toThrow('connectQuickBooks failed: 502');
  });
});
