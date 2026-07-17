import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { VoiceApprovalPinPanel } from './VoiceApprovalPinPanel';

/** GET /api/settings/ preload + a 204 PUT for the enrollment call. */
function mockApi({ enrolled = false, putOk = true, putStatus = 204 } = {}) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/settings/' && (!init || !init.method)) {
      return {
        ok: true,
        json: async () => ({ voiceApprovalPinEnrolled: enrolled }),
      };
    }
    if (path === '/api/settings/voice-approval-pin' && init?.method === 'PUT') {
      return putOk
        ? { ok: true, status: putStatus, json: async () => ({}) }
        : { ok: false, status: 400, json: async () => ({ message: 'PIN must be 4–6 digits' }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

const pinInput = () => screen.getByLabelText(/^PIN \(4–6 digits\)$/) as HTMLInputElement;
const confirmInput = () => screen.getByLabelText(/confirm pin/i) as HTMLInputElement;
const setBtn = () => screen.getByRole('button', { name: /set pin/i });

describe('VoiceApprovalPinPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enrolls: PUTs the digits to /api/settings/voice-approval-pin and never renders them back', async () => {
    mockApi();
    render(<VoiceApprovalPinPanel />);

    fireEvent.change(pinInput(), { target: { value: '4271' } });
    fireEvent.change(confirmInput(), { target: { value: '4271' } });
    fireEvent.click(setBtn());

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/settings/voice-approval-pin',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[0] === '/api/settings/voice-approval-pin',
    );
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({ pin: '4271' });

    // Enrolled state replaces the form; the digits are cleared from the DOM
    // (inputs are gone and the raw value appears nowhere in markup).
    await waitFor(() => expect(screen.getByText(/pin enrolled/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/^PIN \(4–6 digits\)$/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('4271');
  });

  it('masks the digits while typing (password inputs, digits-only, capped at 6)', () => {
    mockApi();
    render(<VoiceApprovalPinPanel />);

    expect(pinInput().type).toBe('password');
    expect(confirmInput().type).toBe('password');

    fireEvent.change(pinInput(), { target: { value: '12ab3456789' } });
    expect(pinInput().value).toBe('123456'); // non-digits stripped, max 6
  });

  it('validates confirm mismatch locally without calling the route', async () => {
    mockApi();
    render(<VoiceApprovalPinPanel />);

    fireEvent.change(pinInput(), { target: { value: '4271' } });
    fireEvent.change(confirmInput(), { target: { value: '4272' } });
    fireEvent.click(setBtn());

    await waitFor(() => expect(screen.getByText(/don't match/i)).toBeInTheDocument());
    expect(
      apiFetchMock.mock.calls.find((c) => c[0] === '/api/settings/voice-approval-pin'),
    ).toBeUndefined();
  });

  it('surfaces the route error message on a failed PUT', async () => {
    mockApi({ putOk: false });
    render(<VoiceApprovalPinPanel />);

    fireEvent.change(pinInput(), { target: { value: '4271' } });
    fireEvent.change(confirmInput(), { target: { value: '4271' } });
    fireEvent.click(setBtn());

    await waitFor(() =>
      expect(screen.getByText(/PIN must be 4–6 digits/)).toBeInTheDocument(),
    );
    // Still un-enrolled: the form stays up for another attempt.
    expect(screen.queryByText(/pin enrolled/i)).not.toBeInTheDocument();
  });

  it('skip path: collapses the panel without any PUT', async () => {
    mockApi();
    render(<VoiceApprovalPinPanel />);

    fireEvent.change(pinInput(), { target: { value: '4271' } });
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await waitFor(() =>
      expect(screen.queryByText(/voice approval pin/i)).not.toBeInTheDocument(),
    );
    expect(
      apiFetchMock.mock.calls.find((c) => c[0] === '/api/settings/voice-approval-pin'),
    ).toBeUndefined();
  });

  it('shows the enrolled state from voiceApprovalPinEnrolled and offers Change PIN', async () => {
    mockApi({ enrolled: true });
    render(<VoiceApprovalPinPanel />);

    await waitFor(() => expect(screen.getByText(/pin enrolled/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/^PIN \(4–6 digits\)$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /change pin/i }));
    expect(pinInput()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update pin/i })).toBeInTheDocument();

    // Cancel returns to the enrolled state without a PUT.
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.getByText(/pin enrolled/i)).toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.find((c) => c[0] === '/api/settings/voice-approval-pin'),
    ).toBeUndefined();
  });

  it('meets the 44px tap-target class contract on inputs and buttons', () => {
    mockApi();
    render(<VoiceApprovalPinPanel />);

    expect(pinInput().className).toContain('min-h-11');
    expect(confirmInput().className).toContain('min-h-11');
    expect(setBtn().className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /skip for now/i }).className).toContain('min-h-11');
    // Full-width inputs inside the panel grid — no fixed widths that could
    // force horizontal overflow at 320px.
    expect(pinInput().className).toContain('w-full');
    expect(confirmInput().className).toContain('w-full');
  });
});
