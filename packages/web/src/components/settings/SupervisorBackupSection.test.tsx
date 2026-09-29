import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SupervisorBackupSection } from './SupervisorBackupSection';

describe('SupervisorBackupSection', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // #1463 — the API refuses a suspended (deactivated) member as backup
  // supervisor, so the picker must not offer one.
  it('offers only active supervise-capable members', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'u-owner', email: 'owner@example.com', role: 'owner', status: 'active' },
          { id: 'u-disp-off', email: 'gone@example.com', role: 'dispatcher', status: 'suspended' },
          { id: 'u-tech', email: 'tech@example.com', role: 'technician', status: 'active' },
        ],
      }),
    });

    render(<SupervisorBackupSection initialBackupUserId={null} initialRouting="queue_and_sms" />);

    const select = (await screen.findByTestId('backup-supervisor-select')) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toContain('u-owner');
    });
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'u-owner']);
  });
});
