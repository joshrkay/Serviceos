import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
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
    toastSuccess.mockReset();
    toastError.mockReset();
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

describe('TeamMembersSheet — Tier 4 Team members (PR 2: role editing)', () => {
  const baseUsers = [
    {
      id: 'u1',
      email: 'jane@example.com',
      role: 'owner',
      firstName: 'Jane',
      canFieldServe: true,
    },
    {
      id: 'u2',
      email: 'tech@example.com',
      role: 'technician',
      canFieldServe: false,
    },
  ];

  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('hides edit affordances when canEditRoles is false', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: baseUsers }));
    render(<TeamMembersSheet onClose={() => {}} canEditRoles={false} />);
    await screen.findByTestId('team-members-list');
    expect(screen.queryByTestId('team-member-edit-u1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('team-member-edit-u2')).not.toBeInTheDocument();
  });

  it('shows the pencil button for owners and reveals a role select on click', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: baseUsers }));
    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);

    const editBtn = await screen.findByTestId('team-member-edit-u2');
    fireEvent.click(editBtn);

    const select = (await screen.findByTestId(
      'team-member-role-select-u2',
    )) as HTMLSelectElement;
    expect(select.value).toBe('technician');
  });

  it('PATCHes the new role and updates the row on success', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: baseUsers }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'u2',
        email: 'tech@example.com',
        role: 'dispatcher',
        canFieldServe: false,
      }),
    );

    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    fireEvent.click(await screen.findByTestId('team-member-edit-u2'));

    const select = (await screen.findByTestId(
      'team-member-role-select-u2',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dispatcher' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.queryByTestId('team-member-role-select-u2')).not.toBeInTheDocument();
    });
    const row = screen.getByTestId('team-member-row-u2');
    expect(row).toHaveTextContent('Dispatcher');

    const patchCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PATCH',
    );
    expect(patchCall![0]).toBe('/api/users/u2');
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body).toEqual({ role: 'dispatcher' });
    expect(toastSuccess).toHaveBeenCalledWith('Role updated');
  });

  it('surfaces server errors and keeps the row in edit mode', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: baseUsers }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(
        { message: 'Cannot demote the only owner' },
        { ok: false, status: 400 },
      ),
    );

    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    fireEvent.click(await screen.findByTestId('team-member-edit-u1'));

    const select = (await screen.findByTestId(
      'team-member-role-select-u1',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dispatcher' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Cannot demote the only owner');
    });
    // Row is still in edit mode for retry.
    expect(screen.getByTestId('team-member-role-select-u1')).toBeInTheDocument();
  });
});
