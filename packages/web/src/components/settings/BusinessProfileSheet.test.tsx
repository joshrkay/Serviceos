import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

import { BusinessProfileSheet } from './BusinessProfileSheet';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('BusinessProfileSheet — Tier 4 settings stub closure', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('loads existing settings via GET /api/settings and populates the form', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        businessName: 'Ortega HVAC',
        businessPhone: '+15125550100',
        businessEmail: 'hello@ortega-hvac.com',
        timezone: 'America/Chicago',
      }),
    );
    const onClose = vi.fn();
    render(<BusinessProfileSheet onClose={onClose} />);

    const nameInput = (await screen.findByLabelText(/Business name/i)) as HTMLInputElement;
    expect(nameInput.value).toBe('Ortega HVAC');
    expect((screen.getByLabelText(/Phone/i) as HTMLInputElement).value).toBe('+15125550100');
    expect((screen.getByLabelText(/Email/i) as HTMLInputElement).value).toBe(
      'hello@ortega-hvac.com',
    );
    expect((screen.getByLabelText(/Timezone/i) as HTMLSelectElement).value).toBe('America/Chicago');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/settings');
  });

  it('saves edits via PUT /api/settings and closes on success', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Old Name' }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'New Name' }));
    const onClose = vi.fn();
    render(<BusinessProfileSheet onClose={onClose} />);

    const nameInput = (await screen.findByLabelText(/Business name/i)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PUT',
    }));
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.businessName).toBe('New Name');
    expect(toastSuccess).toHaveBeenCalledWith('Business profile saved');
  });

  it('refuses to save when business name is empty (required field)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: '' }));
    const onClose = vi.fn();
    render(<BusinessProfileSheet onClose={onClose} />);

    await screen.findByLabelText(/Business name/i);
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Business name is required/i);
    // No PUT was attempted.
    const putCalls = apiFetchMock.mock.calls.filter(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a toast + inline error when the PUT fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Existing' }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Validation failed' }, { ok: false, status: 400 }),
    );
    const onClose = vi.fn();
    render(<BusinessProfileSheet onClose={onClose} />);

    await screen.findByLabelText(/Business name/i);
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Validation failed/);
    expect(toastError).toHaveBeenCalledWith('Validation failed');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('omits empty optional fields from the PUT body', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Acme' }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Acme' }));
    const onClose = vi.fn();
    render(<BusinessProfileSheet onClose={onClose} />);

    await screen.findByLabelText(/Business name/i);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.businessName).toBe('Acme');
    // Codex P2 (PR #316): empty optional fields are sent as explicit
    // null so the backend can clear them. The previous behavior sent
    // undefined which JSON.stringify dropped, so previously-saved
    // values couldn't actually be deleted.
    expect(body.businessPhone).toBeNull();
    expect(body.businessEmail).toBeNull();
    expect(body.timezone).toBeNull();
  });
});
