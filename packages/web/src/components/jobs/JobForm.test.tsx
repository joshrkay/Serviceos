import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobForm } from './JobForm';

// Characterization tests pinned BEFORE the kit/Path A migration (U10f → U10g).
// JobForm POSTs /api/jobs and loads /api/locations off the picked customer;
// these tests fix that contract so the migration can only change styling.
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../utils/api-fetch';

const customer = { id: 'cust-1', firstName: 'Ada', lastName: 'Lovelace' };
const locations = [
  {
    id: 'loc-1',
    street1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    isPrimary: true,
  },
];

function jobsPostBody() {
  const call = vi.mocked(apiFetch).mock.calls.find(
    (c) => String(c[0]) === '/api/jobs' && (c[1] as RequestInit | undefined)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}

function postCount() {
  return vi.mocked(apiFetch).mock.calls.filter(
    (c) => String(c[0]) === '/api/jobs' && (c[1] as RequestInit | undefined)?.method === 'POST',
  ).length;
}

async function pickCustomer() {
  // Drive the CustomerPicker: type → debounced GET /api/customers → click result.
  fireEvent.change(screen.getByLabelText('customer-search'), { target: { value: 'Ada' } });
  fireEvent.click(await screen.findByTestId('customer-option-cust-1'));
  // The customer change kicks off GET /api/locations; wait for it to populate.
  await screen.findByRole('option', { name: /1 Main St/ });
}

describe('JobForm (characterization, pre-kit-migration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/customers')) {
        return { ok: true, status: 200, json: async () => ({ data: [customer] }) } as unknown as Response;
      }
      if (u.startsWith('/api/locations')) {
        return { ok: true, status: 200, json: async () => locations } as unknown as Response;
      }
      if (u === '/api/jobs' && opts?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'job-123' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
  });

  it('loads the customer locations and POSTs /api/jobs with the trimmed payload', async () => {
    const onCreated = vi.fn();
    render(<JobForm onCreated={onCreated} />);

    await pickCustomer();

    // The primary location auto-selects; fill the required summary.
    fireEvent.change(screen.getByLabelText(/Summary/), { target: { value: '  AC not cooling  ' } });
    fireEvent.change(screen.getByLabelText(/Problem description/), {
      target: { value: '  warm air from vents  ' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('job-123'));
    const body = jobsPostBody();
    expect(body).toEqual({
      customerId: 'cust-1',
      locationId: 'loc-1',
      summary: 'AC not cooling',
      problemDescription: 'warm air from vents',
      priority: 'normal',
    });
  });

  it('blocks submit and surfaces an error when no customer is selected', async () => {
    render(<JobForm />);

    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Customer is required.');
    expect(postCount()).toBe(0);
  });

  it('requires a summary even after a customer and location are chosen', async () => {
    render(<JobForm />);

    await pickCustomer();
    // Leave summary blank.
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Summary is required.');
    expect(postCount()).toBe(0);
  });
});
