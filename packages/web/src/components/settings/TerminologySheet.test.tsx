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

import { TerminologySheet } from './TerminologySheet';

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

describe('TerminologySheet', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('hydrates fields from existing terminologyPreferences on /api/settings', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        terminologyPreferences: {
          estimateTerm: 'Quote',
          jobTerm: 'Project',
        },
      }),
    );
    render(<TerminologySheet onClose={() => {}} />);
    await waitFor(() => {
      const estimateInput = screen.getByLabelText(/Estimate/i, {
        selector: 'input',
      }) as HTMLInputElement;
      expect(estimateInput.value).toBe('Quote');
    });
    const jobInput = screen.getByLabelText(/Job/i, { selector: 'input' }) as HTMLInputElement;
    expect(jobInput.value).toBe('Project');
    // Fields without overrides start blank.
    const customerInput = screen.getByLabelText(/Customer/i, { selector: 'input' }) as HTMLInputElement;
    expect(customerInput.value).toBe('');
  });

  it('saves only the non-empty fields via PUT /api/settings', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ terminologyPreferences: {} }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<TerminologySheet onClose={onClose} />);

    const estimate = (await screen.findByLabelText(/Estimate/i, {
      selector: 'input',
    })) as HTMLInputElement;
    fireEvent.change(estimate, { target: { value: 'Quote' } });
    const job = screen.getByLabelText(/Job/i, { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(job, { target: { value: 'Project' } });

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.terminologyPreferences).toEqual({
      estimateTerm: 'Quote',
      jobTerm: 'Project',
    });
    expect(body.terminologyPreferences.customerTerm).toBeUndefined();
    expect(toastSuccess).toHaveBeenCalledWith('Terminology saved');
  });

  it('strips whitespace-only values rather than treating them as overrides', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ terminologyPreferences: {} }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<TerminologySheet onClose={() => {}} />);

    const estimate = (await screen.findByLabelText(/Estimate/i, {
      selector: 'input',
    })) as HTMLInputElement;
    fireEvent.change(estimate, { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(
        (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.terminologyPreferences).toEqual({});
    });
  });

  it('surfaces server validation messages on PUT failure', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ terminologyPreferences: {} }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Invalid terminologyPreferences payload' }, { ok: false, status: 400 }),
    );
    const onClose = vi.fn();
    render(<TerminologySheet onClose={onClose} />);

    const estimate = (await screen.findByLabelText(/Estimate/i, {
      selector: 'input',
    })) as HTMLInputElement;
    fireEvent.change(estimate, { target: { value: 'Quote' } });
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Invalid terminologyPreferences/);
    expect(toastError).toHaveBeenCalledWith('Invalid terminologyPreferences payload');
    expect(onClose).not.toHaveBeenCalled();
  });
});
