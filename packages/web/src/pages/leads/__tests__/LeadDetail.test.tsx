import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeadDetail } from '../LeadDetail';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

const baseLead = {
  id: 'lead-1',
  firstName: 'Alice',
  lastName: 'Wong',
  primaryPhone: '555-0100',
  email: 'alice@example.com',
  source: 'web_form',
  stage: 'qualified',
};

describe('Leads — LeadDetail (P9-001)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders lead fields and Convert button', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseLead,
    } as unknown as Response);

    render(<LeadDetail leadId="lead-1" />);

    expect(await screen.findByText('Alice Wong')).toBeInTheDocument();
    expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert to Customer' })).toBeInTheDocument();
  });

  it('links to the converted customer when the lead is already converted', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, stage: 'won', convertedCustomerId: 'cust-7' }),
    } as unknown as Response);

    render(<LeadDetail leadId="lead-1" />);

    const link = await screen.findByRole('link', { name: /View customer/i });
    expect(link).toHaveAttribute('href', '/customers/cust-7');
  });

  it('Convert button calls /convert with address and surfaces the new customer id', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ...baseLead,
        street1: '100 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      }),
    } as unknown as Response);
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        lead: { ...baseLead, stage: 'won', convertedCustomerId: 'cust-7' },
        customer: { id: 'cust-7' },
        location: { id: 'loc-1' },
      }),
    } as unknown as Response);

    const onConverted = vi.fn();
    render(<LeadDetail leadId="lead-1" onConverted={onConverted} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Convert to Customer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const convertCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => String(c[0]).endsWith('/convert'));
      expect(convertCall).toBeDefined();
      expect((convertCall![1] as RequestInit).method).toBe('POST');
      expect(JSON.parse((convertCall![1] as RequestInit).body as string)).toEqual({
        street1: '100 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      });
    });

    await waitFor(() => {
      expect(onConverted).toHaveBeenCalledWith('cust-7');
    });
  });

  it('blocks convert confirm when address fields are incomplete', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseLead,
    } as unknown as Response);

    render(<LeadDetail leadId="lead-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Convert to Customer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /street, city, state, and postal code are required/i,
    );
    expect(
      vi.mocked(apiFetch).mock.calls.find((c) => String(c[0]).endsWith('/convert')),
    ).toBeUndefined();
  });

  it('Mark as Lost requires a reason and POSTs /lose', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseLead,
    } as unknown as Response);

    render(<LeadDetail leadId="lead-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as Lost' }));

    // Click without reason — should show error, not POST.
    fireEvent.click(screen.getByRole('button', { name: 'Mark Lost' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/reason is required/i);

    // Provide reason and submit.
    fireEvent.change(screen.getByLabelText('Lost reason'), { target: { value: 'No budget' } });

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, stage: 'lost', lostReason: 'No budget' }),
    } as unknown as Response);
    // Refetch after lose
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, stage: 'lost', lostReason: 'No budget' }),
    } as unknown as Response);

    fireEvent.click(screen.getByRole('button', { name: 'Mark Lost' }));

    await waitFor(() => {
      const loseCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => String(c[0]).endsWith('/lose'));
      expect(loseCall).toBeDefined();
      expect(JSON.parse((loseCall![1] as RequestInit).body as string)).toEqual({
        reason: 'No budget',
      });
    });
  });

  it('updates lead notes with PATCH and shows the saved text', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, notes: '' }),
    } as unknown as Response);

    render(<LeadDetail leadId="lead-1" />);

    const notes = await screen.findByLabelText('Lead notes');
    fireEvent.change(notes, { target: { value: 'Called during heat wave, urgent.' } });

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, notes: 'Called during heat wave, urgent.' }),
    } as unknown as Response);

    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      const patchCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toBe('/api/leads/lead-1');
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
        notes: 'Called during heat wave, urgent.',
      });
    });
    await waitFor(() => {
      expect(screen.getAllByText('Called during heat wave, urgent.').length).toBeGreaterThan(0);
    });
  });

  it('sends an explicit empty string when clearing lead notes', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, notes: 'Called during heat wave, urgent.' }),
    } as unknown as Response);

    render(<LeadDetail leadId="lead-1" />);

    const notes = await screen.findByLabelText('Lead notes');
    fireEvent.change(notes, { target: { value: '' } });

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, notes: '' }),
    } as unknown as Response);

    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      const patchCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
        notes: '',
      });
    });
  });

  it('preserves an unsaved note draft when changing the language', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseLead,
    } as unknown as Response);

    render(<LeadDetail leadId="lead-1" />);

    // Type a note draft but do NOT click "Save note".
    const notes = await screen.findByLabelText('Lead notes');
    fireEvent.change(notes, { target: { value: 'call back after 5pm' } });

    // PATCH response for the language change (endpoint returns the updated lead).
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseLead, preferredLanguage: 'es' }),
    } as unknown as Response);
    // If the (removed) refetch ran, it would consume this GET and reset the
    // notes textarea from the server, discarding the draft.
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseLead,
    } as unknown as Response);

    fireEvent.change(screen.getByLabelText('Preferred language'), {
      target: { value: 'es' },
    });

    await waitFor(() => {
      const langPatch = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (c) =>
            (c[1] as RequestInit | undefined)?.method === 'PATCH' &&
            JSON.parse((c[1] as RequestInit).body as string).preferredLanguage !==
              undefined,
        );
      expect(langPatch).toBeDefined();
    });

    // The unsaved draft must survive the language change.
    expect((notes as HTMLTextAreaElement).value).toBe('call back after 5pm');
  });
});
