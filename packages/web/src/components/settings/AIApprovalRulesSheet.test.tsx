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

import { AIApprovalRulesSheet } from './AIApprovalRulesSheet';

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

describe('AIApprovalRulesSheet', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('prefills with the Balanced preset when no override exists yet', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<AIApprovalRulesSheet onClose={() => {}} />);

    // Balanced is auto-selected because thresholds match the defaults.
    await waitFor(() => {
      const balancedButton = screen.getByText('Balanced').closest('button');
      expect(balancedButton?.className).toContain('border-indigo-500');
    });
  });

  it('hydrates from existing autoApproveThreshold and matches it to a preset', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        autoApproveThreshold: { supervisor: 0.95, both: 0.97, tech: 0.99 },
      }),
    );
    render(<AIApprovalRulesSheet onClose={() => {}} />);

    await waitFor(() => {
      const strictButton = screen.getByText('Strict').closest('button');
      expect(strictButton?.className).toContain('border-indigo-500');
    });
  });

  it('marks the picker as Custom when stored thresholds match no preset', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        autoApproveThreshold: { supervisor: 0.91, both: 0.93, tech: 0.94 },
      }),
    );
    render(<AIApprovalRulesSheet onClose={() => {}} />);

    await waitFor(() => screen.getByText(/Custom thresholds/i));
  });

  it('saves the preset thresholds via PUT /api/settings when Save is clicked', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({})); // initial load
    apiFetchMock.mockResolvedValueOnce(jsonResponse({})); // PUT response
    const onClose = vi.fn();
    render(<AIApprovalRulesSheet onClose={onClose} />);

    // Pick Strict.
    await screen.findByText('Strict');
    fireEvent.click(screen.getByText('Strict'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.autoApproveThreshold).toEqual({
      supervisor: 0.95,
      both: 0.97,
      tech: 0.99,
    });
    expect(toastSuccess).toHaveBeenCalledWith('Approval rules saved');
  });

  it('exposes per-mode number inputs under Advanced and saves edits', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<AIApprovalRulesSheet onClose={onClose} />);

    await screen.findByText('Balanced');
    fireEvent.click(screen.getByText('Advanced'));

    const supervisorInput = (await screen.findByLabelText(/Supervisor present/i)) as HTMLInputElement;
    fireEvent.change(supervisorInput, { target: { value: '0.85' } });

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.autoApproveThreshold.supervisor).toBe(0.85);
  });

  it('rejects out-of-range threshold values inline', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<AIApprovalRulesSheet onClose={() => {}} />);

    await screen.findByText('Balanced');
    fireEvent.click(screen.getByText('Advanced'));

    const supervisorInput = (await screen.findByLabelText(/Supervisor present/i)) as HTMLInputElement;
    fireEvent.change(supervisorInput, { target: { value: '1.5' } });
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/threshold must be between 0 and 1/i);
    // No PUT was attempted.
    const putCalls = apiFetchMock.mock.calls.filter(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  // UB-D / D-015 — autonomous booking lane toggle.
  it('renders the autonomous booking switch OFF by default with the consequence copy', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<AIApprovalRulesSheet onClose={() => {}} />);

    const toggle = await screen.findByRole('switch', {
      name: /Autonomous booking \(no supervisor\)/i,
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // ≥44px tap target (mobile UI rule) — class contract.
    expect(toggle.className).toContain('min-h-11');
    expect(
      screen.getByText(/confirm instantly with no one watching/i),
    ).toBeTruthy();
    expect(screen.getByText(/one-tap UNDO/i)).toBeTruthy();
    // Threshold input only appears once the lane is enabled.
    expect(screen.queryByLabelText(/Confidence threshold/i)).toBeNull();
  });

  it('hydrates the switch + threshold from GET /api/settings', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ autonomousBookingEnabled: true, autonomousBookingThreshold: 0.97 }),
    );
    render(<AIApprovalRulesSheet onClose={() => {}} />);

    const toggle = await screen.findByRole('switch', {
      name: /Autonomous booking \(no supervisor\)/i,
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const input = (await screen.findByLabelText(/Confidence threshold/i)) as HTMLInputElement;
    expect(input.value).toBe('0.97');
  });

  it('saves the lane opt-in + threshold via PUT /api/settings', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<AIApprovalRulesSheet onClose={onClose} />);

    const toggle = await screen.findByRole('switch', {
      name: /Autonomous booking \(no supervisor\)/i,
    });
    fireEvent.click(toggle);
    const input = (await screen.findByLabelText(/Confidence threshold/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.96' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.autonomousBookingEnabled).toBe(true);
    expect(body.autonomousBookingThreshold).toBe(0.96);
  });

  it('rejects an out-of-bounds autonomous threshold inline (0.90–0.99)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<AIApprovalRulesSheet onClose={() => {}} />);

    const toggle = await screen.findByRole('switch', {
      name: /Autonomous booking \(no supervisor\)/i,
    });
    fireEvent.click(toggle);
    const input = (await screen.findByLabelText(/Confidence threshold/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.85' } });
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Autonomous booking threshold must be between 0.9 and 0.99/i);
    const putCalls = apiFetchMock.mock.calls.filter(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('surfaces a toast + inline error when the PUT fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Validation failed' }, { ok: false, status: 400 }),
    );
    const onClose = vi.fn();
    render(<AIApprovalRulesSheet onClose={onClose} />);

    await screen.findByText('Balanced');
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Validation failed/);
    expect(toastError).toHaveBeenCalledWith('Validation failed');
    expect(onClose).not.toHaveBeenCalled();
  });
});
