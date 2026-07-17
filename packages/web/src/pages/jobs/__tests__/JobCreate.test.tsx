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
    // The form never POSTs a job when validation blocks submission. (A GET
    // /api/users fires on mount to load the technician roster — that's not a
    // submission.)
    const postCall = vi
      .mocked(apiFetch)
      .mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('POSTs to /api/jobs with customerId from picker selection', async () => {
    // URL-aware so it's robust to the mount-time GET /api/users (technician
    // roster) the form fires alongside the customer search / location load.
    const locations = [
      { id: 'loc-1', label: 'Home', street1: '100 Main St', city: 'Austin', state: 'TX', postalCode: '78701', isPrimary: true },
      { id: 'loc-2', label: 'Rental', street1: '200 Rental Rd', city: 'Austin', state: 'TX', postalCode: '78702', isPrimary: false },
    ];
    vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/customers')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'cust-1', firstName: 'Carol' }] }) } as unknown as Response;
      }
      if (u.startsWith('/api/locations')) {
        return { ok: true, status: 200, json: async () => locations } as unknown as Response;
      }
      if (u.startsWith('/api/users')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
      }
      if (u === '/api/jobs' && opts?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'job-99' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });

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

    await waitFor(() => {
      expect(screen.getByLabelText(/Service location/i)).toHaveValue('loc-1');
      expect(screen.getByText(/Home \(Primary\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Rental/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/Service location/i), {
      target: { value: 'loc-2' },
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
      expect(body.locationId).toBe('loc-2');
      expect(body.summary).toBe('Fix the sink');
      expect(body.priority).toBe('normal');
    });
  });
});
