import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getCustomerTimeline } from './customers';

vi.mock('../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../utils/api-fetch';

describe('getCustomerTimeline', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('treats an unmounted timeline endpoint as an empty feed', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as unknown as Response);

    await expect(getCustomerTimeline('cust-1')).resolves.toEqual({
      events: [],
      nextCursor: null,
    });
  });
});
