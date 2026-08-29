/**
 * #874 — Service area editor. Load/save/error triad plus the two traps
 * this sheet exists to avoid:
 * - it must write via PUT /api/onboarding/identity (updateSettingsSchema
 *   silently STRIPS serviceAreaText/serviceAreaRadius);
 * - it must echo the loaded identity fields (businessName, buffer, rate,
 *   stored businessHours) so the required-field route doesn't clobber them.
 */
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

import { ServiceAreaSheet } from './ServiceAreaSheet';

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

const LOADED_SETTINGS = {
  businessName: 'Rivet HVAC',
  businessHours: { mon: { open: '08:00', close: '17:00' }, sun: null },
  jobBufferMinutes: 45,
  hourlyRateCents: 15000,
  serviceAreaText: 'Phoenix, AZ',
  serviceAreaRadius: 25,
  serviceAreaZips: ['85001', '85002'],
};

function putCall() {
  return apiFetchMock.mock.calls.find((c) => c[1] && (c[1] as RequestInit).method === 'PUT');
}

function putBody(): Record<string, unknown> {
  const call = putCall();
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string);
}

describe('ServiceAreaSheet', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('hydrates all three fields from GET /api/settings', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    render(<ServiceAreaSheet onClose={vi.fn()} />);
    expect(((await screen.findByLabelText(/Where you work/i)) as HTMLInputElement).value).toBe(
      'Phoenix, AZ',
    );
    expect((screen.getByLabelText(/Radius/i) as HTMLInputElement).value).toBe('25');
    expect((screen.getByLabelText(/ZIP codes you serve/i) as HTMLInputElement).value).toBe(
      '85001, 85002',
    );
    expect(apiFetchMock).toHaveBeenCalledWith('/api/settings');
  });

  it('saves via PUT /api/onboarding/identity, echoing the required identity fields', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<ServiceAreaSheet onClose={onClose} onSaved={onSaved} />);

    const textInput = await screen.findByLabelText(/Where you work/i);
    fireEvent.change(textInput, { target: { value: 'Tempe, AZ' } });
    fireEvent.change(screen.getByLabelText(/Radius/i), { target: { value: '40' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putCall()![0]).toBe('/api/onboarding/identity');
    const body = putBody();
    // The edit:
    expect(body.serviceAreaText).toBe('Tempe, AZ');
    expect(body.serviceAreaRadius).toBe(40);
    expect(body.serviceAreaZips).toEqual(['85001', '85002']);
    // The echoes — required by the route, COALESCEd by the upsert:
    expect(body.businessName).toBe('Rivet HVAC');
    expect(body.jobBufferMinutes).toBe(45);
    expect(body.hourlyRateCents).toBe(15000);
    expect(body.businessHours).toEqual({ mon: { open: '08:00', close: '17:00' }, sun: null });
    expect(toastSuccess).toHaveBeenCalledWith('Service area saved');
    expect(onSaved).toHaveBeenCalledWith({
      serviceAreaText: 'Tempe, AZ',
      serviceAreaRadius: 40,
      serviceAreaZips: ['85001', '85002'],
    });
  });

  it('omits businessHours from the PUT when none are stored (never clobbers with {})', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ ...LOADED_SETTINGS, businessHours: null }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    render(<ServiceAreaSheet onClose={vi.fn()} />);
    await screen.findByLabelText(/Where you work/i);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(putCall()).toBeDefined());
    expect('businessHours' in putBody()).toBe(false);
  });

  // #874 review — an explicitly emptied radius must WRITE null, not be
  // omitted: the identity upsert keeps an omitted radius, which left the
  // Settings row claiming a stale "~N mi radius" forever.
  it('clearing every field sends "" text, [] zips, and an explicit null radius', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onSaved = vi.fn();
    render(<ServiceAreaSheet onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(await screen.findByLabelText(/Where you work/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Radius/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/ZIP codes you serve/i), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(putCall()).toBeDefined());
    const body = putBody();
    expect(body.serviceAreaText).toBe('');
    expect(body.serviceAreaZips).toEqual([]);
    expect('serviceAreaRadius' in body).toBe(true);
    expect(body.serviceAreaRadius).toBeNull();
    // The Settings row refresh sees the cleared radius too.
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({
        serviceAreaText: '',
        serviceAreaRadius: null,
        serviceAreaZips: [],
      }),
    );
  });

  it('rejects malformed ZIPs inline without attempting a PUT', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    render(<ServiceAreaSheet onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/ZIP codes you serve/i), {
      target: { value: '85001, ABCDE' },
    });
    fireEvent.click(screen.getByText('Save'));
    await screen.findByText(/ZIP codes must be 5 digits/i);
    expect(putCall()).toBeUndefined();
  });

  it('rejects an out-of-range radius inline without attempting a PUT', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    render(<ServiceAreaSheet onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/Radius/i), { target: { value: '900' } });
    fireEvent.click(screen.getByText('Save'));
    await screen.findByText(/between 1 and 500/i);
    expect(putCall()).toBeUndefined();
  });

  it('surfaces a toast + inline error when the PUT fails, staying open', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Validation failed' }, { ok: false, status: 400 }),
    );
    const onClose = vi.fn();
    render(<ServiceAreaSheet onClose={onClose} />);
    await screen.findByLabelText(/Where you work/i);
    fireEvent.click(screen.getByText('Save'));
    await screen.findByText(/Validation failed/);
    expect(toastError).toHaveBeenCalledWith('Validation failed');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('blocks saving with a setup hint when the tenant never finished setup', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ serviceAreaText: null, serviceAreaZips: null }),
    );
    render(<ServiceAreaSheet onClose={vi.fn()} />);
    expect(await screen.findByTestId('service-area-setup-hint')).toBeInTheDocument();
    const save = screen.getByText('Save').closest('button')!;
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(putCall()).toBeUndefined();
  });

  // Mirror ConfirmDialog's busy guard: a stray backdrop tap must not
  // dismiss the sheet while the PUT is in flight (the save's own success
  // path closes it), but an idle backdrop tap still closes.
  it('ignores backdrop clicks while saving, honors them when idle', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    let resolvePut: (r: Response) => void = () => {};
    apiFetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolvePut = resolve;
      }),
    );
    const onClose = vi.fn();
    render(<ServiceAreaSheet onClose={onClose} />);
    await screen.findByLabelText(/Where you work/i);

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByText('Saving…')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    resolvePut(jsonResponse({ ok: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // Idle: the backdrop still dismisses.
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    const onCloseIdle = vi.fn();
    render(<ServiceAreaSheet onClose={onCloseIdle} />);
    const dialogs = screen.getAllByRole('dialog');
    fireEvent.click(dialogs[dialogs.length - 1]);
    expect(onCloseIdle).toHaveBeenCalledTimes(1);
  });

  // Class-contract (CLAUDE.md): ≥44px tap targets on inputs and buttons.
  it('inputs and footer buttons clear the 44px tap-target floor', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(LOADED_SETTINGS));
    render(<ServiceAreaSheet onClose={vi.fn()} />);
    const textInput = await screen.findByLabelText(/Where you work/i);
    expect(textInput.className).toContain('min-h-11');
    expect(screen.getByText('Save').closest('button')!.className).toContain('min-h-11');
    expect(screen.getByText('Cancel').closest('button')!.className).toContain('min-h-11');
  });
});
