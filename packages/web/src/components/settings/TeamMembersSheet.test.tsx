import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { TeamMembersSheet } from './TeamMembersSheet';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('TeamMembersSheet — Tier 4 Team members (PR 1: read-only list)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders each user with role badge', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'u1',
            email: 'jane@example.com',
            role: 'owner',
            firstName: 'Jane',
            lastName: 'Doe',
            canFieldServe: true,
          },
          {
            id: 'u2',
            email: 'alex@example.com',
            role: 'technician',
            canFieldServe: false,
          },
        ],
      }),
    );
    render(<TeamMembersSheet onClose={() => {}} />);
    await screen.findByTestId('team-members-list');

    const row1 = screen.getByTestId('team-member-row-u1');
    expect(row1).toHaveTextContent('Jane Doe');
    expect(row1).toHaveTextContent('jane@example.com');
    expect(row1).toHaveTextContent('Owner');

    const row2 = screen.getByTestId('team-member-row-u2');
    // Display falls back to email when first/last name absent.
    expect(row2).toHaveTextContent('alex@example.com');
    expect(row2).toHaveTextContent('Technician');
  });

  it('shows the empty state when the tenant has no users yet', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    render(<TeamMembersSheet onClose={() => {}} />);
    await screen.findByTestId('team-members-empty');
    expect(screen.queryByTestId('team-members-list')).not.toBeInTheDocument();
  });

  it('surfaces a friendly error when the API call fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));
    render(<TeamMembersSheet onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Load failed/i);
    });
  });

  it('accepts a bare-array response shape (legacy compatibility)', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'u3', email: 'kim@example.com', role: 'dispatcher', canFieldServe: true },
      ]),
    );
    render(<TeamMembersSheet onClose={() => {}} />);
    const row = await screen.findByTestId('team-member-row-u3');
    expect(row).toHaveTextContent('Dispatcher');
  });
});
