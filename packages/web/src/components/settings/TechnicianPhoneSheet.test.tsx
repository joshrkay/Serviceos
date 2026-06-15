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

import { TechnicianPhoneSheet } from './TechnicianPhoneSheet';

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

describe('TechnicianPhoneSheet', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('loads the current number via GET /api/users/me/phone and formats it', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ mobileNumber: '+15125550199' }));
    render(<TechnicianPhoneSheet onClose={vi.fn()} />);

    const input = (await screen.findByLabelText(/Your cell phone/i)) as HTMLInputElement;
    expect(input.value).toBe('(512) 555-0199');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/users/me/phone');
  });

  it('sends the entered number on save via PUT and closes', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ mobileNumber: null })); // GET (empty)
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ mobileNumber: '+15125551234' })); // PUT
    const onClose = vi.fn();
    render(<TechnicianPhoneSheet onClose={onClose} />);

    const input = (await screen.findByLabelText(/Your cell phone/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '(512) 555-1234' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/users/me/phone',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.mobileNumber).toBe('(512) 555-1234');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('surfaces a server error (invalid number) without closing', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ mobileNumber: null })); // GET
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Invalid mobile number' }, { ok: false, status: 400 }),
    ); // PUT 400
    const onClose = vi.fn();
    render(<TechnicianPhoneSheet onClose={onClose} />);

    const input = (await screen.findByLabelText(/Your cell phone/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText(/Invalid mobile number/i)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('class contract — input + Save + Cancel meet the ≥44px tap target (min-h-11)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ mobileNumber: null }));
    render(<TechnicianPhoneSheet onClose={vi.fn()} />);

    const input = (await screen.findByLabelText(/Your cell phone/i)) as HTMLInputElement;
    expect(input.className).toContain('min-h-11');
    expect(screen.getByText('Save').className).toContain('min-h-11');
    expect(screen.getByText('Cancel').className).toContain('min-h-11');
  });
});
