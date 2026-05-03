import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { JobCreate } from '../JobCreate';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

describe('JobCreate (P11-006)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders the form with a required customer picker', () => {
    render(
      <MemoryRouter>
        <JobCreate />
      </MemoryRouter>
    );
    expect(screen.getByText('New Job')).toBeInTheDocument();
    expect(screen.getByTestId('customer-picker')).toBeInTheDocument();
    expect(screen.getByText('Customer *')).toBeInTheDocument();
  });

  it('blocks submission and shows an error when no customer is selected', async () => {
    render(
      <MemoryRouter>
        <JobCreate />
      </MemoryRouter>
    );
    const submit = screen.getByRole('button', { name: /create job/i });
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Customer is required/i);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('POSTs to /api/jobs with customerId from picker selection', async () => {
    // First call: customer search.
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'cust-1', firstName: 'Carol' }] }),
    } as unknown as Response);
    // Second call: POST /api/jobs.
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'job-99' }),
    } as unknown as Response);

    render(
      <MemoryRouter>
        <JobCreate />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('customer-search'), {
      target: { value: 'carol' },
    });
    await waitFor(
      () => {
        expect(screen.getByTestId('customer-option-cust-1')).toBeInTheDocument();
      },
      { timeout: 1500 }
    );
    fireEvent.click(screen.getByTestId('customer-option-cust-1'));

    fireEvent.change(screen.getByLabelText(/Service location ID/i), {
      target: { value: 'loc-1' },
    });
    fireEvent.change(screen.getByLabelText(/Summary/i), {
      target: { value: 'Fix the sink' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => {
      const postCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(postCall![0]).toBe('/api/jobs');
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.customerId).toBe('cust-1');
      expect(body.locationId).toBe('loc-1');
      expect(body.summary).toBe('Fix the sink');
      expect(body.priority).toBe('normal');
    });
  });
});
