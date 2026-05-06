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

/**
 * Helper: routes apiFetch calls by URL. PR 3 added a parallel
 * /api/users/invitations fetch on mount, so tests that previously
 * mocked a single response now need to handle both URLs.
 */
function mockUsersAndInvitations(opts: {
  users?: { ok?: boolean; status?: number; body: unknown };
  invitations?: { ok?: boolean; status?: number; body: unknown };
}) {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/users' && (!init || init.method === undefined)) {
      const u = opts.users ?? { body: { data: [] } };
      return jsonResponse(u.body, { ok: u.ok, status: u.status });
    }
    if (url === '/api/users/invitations' && (!init || init.method === undefined)) {
      const i = opts.invitations ?? { body: { data: [] } };
      return jsonResponse(i.body, { ok: i.ok, status: i.status });
    }
    return jsonResponse({});
  });
}

describe('TeamMembersSheet — Tier 4 Team members (PR 1: read-only list)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('renders each user with role badge', async () => {
    mockUsersAndInvitations({
      users: {
        body: {
          data: [
            { id: 'u1', email: 'jane@example.com', role: 'owner', firstName: 'Jane', lastName: 'Doe', canFieldServe: true },
            { id: 'u2', email: 'alex@example.com', role: 'technician', canFieldServe: false },
          ],
        },
      },
    });
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
    mockUsersAndInvitations({ users: { body: { data: [] } } });
    render(<TeamMembersSheet onClose={() => {}} />);
    await screen.findByTestId('team-members-empty');
    expect(screen.queryByTestId('team-members-list')).not.toBeInTheDocument();
  });

  it('surfaces a friendly error when the API call fails', async () => {
    mockUsersAndInvitations({ users: { body: {}, ok: false, status: 500 } });
    render(<TeamMembersSheet onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Load failed/i);
    });
  });

  it('accepts a bare-array response shape (legacy compatibility)', async () => {
    mockUsersAndInvitations({
      users: {
        body: [
          { id: 'u3', email: 'kim@example.com', role: 'dispatcher', canFieldServe: true },
        ],
      },
    });
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
    mockUsersAndInvitations({ users: { body: { data: baseUsers } } });
    render(<TeamMembersSheet onClose={() => {}} canEditRoles={false} />);
    await screen.findByTestId('team-members-list');
    expect(screen.queryByTestId('team-member-edit-u1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('team-member-edit-u2')).not.toBeInTheDocument();
  });

  it('shows the pencil button for owners and reveals a role select on click', async () => {
    mockUsersAndInvitations({ users: { body: { data: baseUsers } } });
    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);

    const editBtn = await screen.findByTestId('team-member-edit-u2');
    fireEvent.click(editBtn);

    const select = (await screen.findByTestId(
      'team-member-role-select-u2',
    )) as HTMLSelectElement;
    expect(select.value).toBe('technician');
  });

  it('PATCHes the new role and updates the row on success', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users' && (!init || init.method === undefined)) {
        return jsonResponse({ data: baseUsers });
      }
      if (url === '/api/users/invitations' && (!init || init.method === undefined)) {
        return jsonResponse({ data: [] });
      }
      if (init?.method === 'PATCH') {
        return jsonResponse({
          id: 'u2', email: 'tech@example.com', role: 'dispatcher', canFieldServe: false,
        });
      }
      return jsonResponse({});
    });

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
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users' && (!init || init.method === undefined)) {
        return jsonResponse({ data: baseUsers });
      }
      if (url === '/api/users/invitations' && (!init || init.method === undefined)) {
        return jsonResponse({ data: [] });
      }
      if (init?.method === 'PATCH') {
        return jsonResponse(
          { message: 'Cannot demote the only owner' },
          { ok: false, status: 400 },
        );
      }
      return jsonResponse({});
    });

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

describe('TeamMembersSheet — Tier 4 Team members (PR 3: invite flow)', () => {
  const baseUsers = [
    { id: 'u1', email: 'jane@example.com', role: 'owner', firstName: 'Jane', canFieldServe: true },
  ];

  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('renders pending invitations alongside members', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/users') return jsonResponse({ data: baseUsers });
      if (url === '/api/users/invitations') {
        return jsonResponse({
          data: [
            {
              id: 'inv-1',
              email: 'invited@example.com',
              role: 'technician',
              invitedBy: 'user-owner',
              createdAt: '2026-05-06T10:00:00Z',
              expiresAt: '2026-05-20T10:00:00Z',
            },
          ],
        });
      }
      return jsonResponse({});
    });

    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    await screen.findByTestId('pending-invitations-section');
    const row = screen.getByTestId('pending-invitation-row-inv-1');
    expect(row).toHaveTextContent('invited@example.com');
    expect(row).toHaveTextContent('Awaiting acceptance');
    expect(row).toHaveTextContent('Technician');
  });

  it('hides the Invite button when canEditRoles is false', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: baseUsers }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    render(<TeamMembersSheet onClose={() => {}} canEditRoles={false} />);
    await screen.findByTestId('team-members-list');
    expect(screen.queryByTestId('team-members-invite-button')).not.toBeInTheDocument();
  });

  it('opens the invite dialog and POSTs the new invitation', async () => {
    apiFetchMock.mockImplementationOnce(async () => jsonResponse({ data: baseUsers }));
    apiFetchMock.mockImplementationOnce(async () => jsonResponse({ data: [] }));
    apiFetchMock.mockImplementationOnce(async () =>
      jsonResponse({
        id: 'inv-new',
        email: 'newhire@example.com',
        role: 'technician',
        invitedBy: 'user-owner',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      }),
    );

    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    await screen.findByTestId('team-members-list');

    fireEvent.click(screen.getByTestId('team-members-invite-button'));
    await screen.findByTestId('invite-dialog');

    fireEvent.change(screen.getByTestId('invite-email-input'), {
      target: { value: 'newhire@example.com' },
    });
    fireEvent.change(screen.getByTestId('invite-role-select'), {
      target: { value: 'technician' },
    });
    fireEvent.click(screen.getByTestId('invite-send-button'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Invited newhire@example.com');
    });

    const postCall = apiFetchMock.mock.calls.find(
      (c) => c[0] === '/api/users/invitations' && c[1] && (c[1] as RequestInit).method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toEqual({ email: 'newhire@example.com', role: 'technician' });

    // The freshly-minted invitation appears in the pending list.
    const row = await screen.findByTestId('pending-invitation-row-inv-new');
    expect(row).toHaveTextContent('newhire@example.com');
  });

  it('surfaces invite-side server errors inline + via toast', async () => {
    apiFetchMock.mockImplementationOnce(async () => jsonResponse({ data: baseUsers }));
    apiFetchMock.mockImplementationOnce(async () => jsonResponse({ data: [] }));
    apiFetchMock.mockImplementationOnce(async () =>
      jsonResponse(
        { message: 'A pending invitation already exists for this email' },
        { ok: false, status: 400 },
      ),
    );

    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    await screen.findByTestId('team-members-list');

    fireEvent.click(screen.getByTestId('team-members-invite-button'));
    fireEvent.change(screen.getByTestId('invite-email-input'), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.click(screen.getByTestId('invite-send-button'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'A pending invitation already exists for this email',
      );
    });
    // Dialog stays open so the operator can fix the email.
    expect(screen.getByTestId('invite-dialog')).toBeInTheDocument();
  });
});
