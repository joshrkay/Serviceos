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

describe('BusinessProfileSheet', () => {
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
    expect((screen.getByLabelText(/Business phone/i) as HTMLInputElement).value).toBe('+15125550100');
    expect((screen.getByLabelText(/Email/i) as HTMLInputElement).value).toBe(
      'hello@ortega-hvac.com',
    );
    expect((screen.getByLabelText(/Timezone/i) as HTMLSelectElement).value).toBe('America/Chicago');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/settings');
  });

  it('loads and formats a saved owner phone', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        businessName: 'Ortega HVAC',
        ownerPhone: '+15125550199',
      }),
    );
    render(<BusinessProfileSheet onClose={vi.fn()} />);
    await screen.findByLabelText(/Business name/i);
    expect((screen.getByLabelText(/Your cell phone/i) as HTMLInputElement).value).toBe(
      '(512) 555-0199',
    );
  });

  it('sends owner phone in the PUT body so it round-trips to the API', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Ortega HVAC' }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Ortega HVAC' }));
    render(<BusinessProfileSheet onClose={vi.fn()} />);
    const ownerInput = (await screen.findByLabelText(/Your cell phone/i)) as HTMLInputElement;
    fireEvent.change(ownerInput, { target: { value: '(512) 555-1234' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' })));
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.ownerPhone).toBe('(512) 555-1234');
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
    expect(body.ownerPhone).toBeNull();
    expect(body.timezone).toBeNull();
  });

  // #1408 — the API stores phones as E.164 (#1397); what the sheet reports
  // back must be what was STORED, not what was typed, or the caller shows
  // the typed form until a reload.
  it('reports the stored E.164 phones from the PUT response to onSaved', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Ortega HVAC' }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        businessName: 'Ortega HVAC',
        businessPhone: '+15125550100',
        ownerPhone: '+15125551234',
        timezone: 'America/Chicago',
      }),
    );
    const onSaved = vi.fn();
    render(<BusinessProfileSheet onClose={vi.fn()} onSaved={onSaved} />);

    await screen.findByLabelText(/Business name/i);
    fireEvent.change(screen.getByLabelText(/Business phone/i), { target: { value: '(512) 555-0100' } });
    fireEvent.change(screen.getByLabelText(/Your cell phone/i), { target: { value: '512.555.1234' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0][0]).toMatchObject({
      businessPhone: '+15125550100',
      ownerPhone: '+15125551234',
    });
  });

  it('#1402 §13 — loads, edits and saves the business address (multi-line)', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ businessName: 'Acme', businessAddress: '1 Old Rd\nMesa, AZ 85201' }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Acme' }));
    const onClose = vi.fn();
    render(<BusinessProfileSheet onClose={onClose} />);

    const address = (await screen.findByLabelText(/Business address/i)) as HTMLTextAreaElement;
    expect(address.value).toBe('1 Old Rd\nMesa, AZ 85201');
    fireEvent.change(address, { target: { value: '1200 W Main St\nMesa, AZ 85201' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.businessAddress).toBe('1200 W Main St\nMesa, AZ 85201');
  });

  it('#1402 §13 — a cleared address is sent as null so the API clears it', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Acme', businessAddress: '1 Old Rd' }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ businessName: 'Acme' }));
    render(<BusinessProfileSheet onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Business address/i), { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' })),
    );
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(JSON.parse((putCall![1] as RequestInit).body as string).businessAddress).toBeNull();
  });
});
