import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../utils/api-fetch';
import { useTechnicianRoster } from './useTechnicianRoster';

describe('useTechnicianRoster', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  // #1463 — the API refuses assigning a suspended (deactivated) member, so
  // every picker fed by this roster must not offer one.
  it('omits suspended technicians from the roster', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'tech-active', firstName: 'Ana', lastName: 'Active', status: 'active' },
          { id: 'tech-legacy', firstName: 'Lee', lastName: 'Legacy' },
          { id: 'tech-suspended', firstName: 'Sam', lastName: 'Suspended', status: 'suspended' },
        ],
      }),
    } as unknown as Response);

    const { result } = renderHook(() => useTechnicianRoster());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.technicians.map((t) => t.id)).toEqual(['tech-active', 'tech-legacy']);
  });
});
