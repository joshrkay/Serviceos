/**
 * #1402 §13 — an owner deactivates a teammate from the Team members sheet.
 * Seam: the rendered sheet, with the API mocked at apiFetch.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const TECH = { id: 'u2', email: 'alex@example.com', role: 'technician', canFieldServe: false };

function mockApi(deactivate: { ok?: boolean; status?: number; body: unknown }) {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/users' && !init?.method) {
      return jsonResponse({
        data: [{ id: 'u1', email: 'owner@example.com', role: 'owner', canFieldServe: true }, TECH],
      });
    }
    if (url === '/api/users/invitations') return jsonResponse({ data: [] });
    if (url === '/api/users/u2/deactivate' && init?.method === 'POST') {
      return jsonResponse(deactivate.body, { ok: deactivate.ok, status: deactivate.status });
    }
    return jsonResponse({});
  });
}

function deactivateCalls() {
  return apiFetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/deactivate'));
}

describe('TeamMembersSheet — deactivate a member (#1402 §13)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('asks for confirmation, then deactivates and marks the row Deactivated', async () => {
    mockApi({ body: { ...TECH, status: 'suspended' } });
    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    await screen.findByTestId('team-members-list');

    fireEvent.click(screen.getByRole('button', { name: /Deactivate alex@example.com/i }));
    expect(deactivateCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Yes, deactivate/i }));

    const row = screen.getByTestId('team-member-row-u2');
    await waitFor(() => expect(within(row).getByText('Deactivated')).toBeInTheDocument());
    expect(deactivateCalls()).toHaveLength(1);
    expect(deactivateCalls()[0][1]).toMatchObject({ method: 'POST' });
  });

  it('shows the server refusal (e.g. deactivating yourself) and keeps the member active', async () => {
    mockApi({
      ok: false,
      status: 409,
      body: { error: 'CANNOT_DEACTIVATE_SELF', message: 'You cannot deactivate your own account.' },
    });
    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    await screen.findByTestId('team-members-list');

    fireEvent.click(screen.getByRole('button', { name: /Deactivate alex@example.com/i }));
    fireEvent.click(screen.getByRole('button', { name: /Yes, deactivate/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot deactivate your own account.');
    expect(within(screen.getByTestId('team-member-row-u2')).queryByText('Deactivated')).toBeNull();
  });

  it('marks an already-deactivated member and offers no deactivate or edit control', async () => {
    apiFetchMock.mockImplementation(async (url: string) =>
      url === '/api/users'
        ? jsonResponse({ data: [{ ...TECH, status: 'suspended' }] })
        : jsonResponse({ data: [] }),
    );
    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);

    const row = await screen.findByTestId('team-member-row-u2');
    expect(within(row).getByText('Deactivated')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Deactivate/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /Edit role/i })).toBeNull();
  });

  it('hides the control from non-owners', async () => {
    mockApi({ body: {} });
    render(<TeamMembersSheet onClose={() => {}} />);
    await screen.findByTestId('team-members-list');

    expect(screen.queryByRole('button', { name: /Deactivate/i })).toBeNull();
  });

  it('meets the 44px tap-target contract on every deactivation control', async () => {
    mockApi({ body: {} });
    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    await screen.findByTestId('team-members-list');

    const start = screen.getByRole('button', { name: /Deactivate alex@example.com/i });
    expect(start.className).toContain('min-h-11');
    fireEvent.click(start);
    expect(screen.getByRole('button', { name: /Yes, deactivate/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /^Keep$/i }).className).toContain('min-h-11');
  });
});

