/**
 * Inbox — service-address completion on a `create_customer` row.
 *
 * The live incident was approved from this surface: the card showed
 * "New customer from inbound call: Ashia Aksuna, 1207 Riverbell Drive", the
 * approver approved, and `service_locations` got zero rows because the
 * utterance had no city/state/ZIP. The inbox row now offers those boxes and
 * PUTs them through the existing edit endpoint before approving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { InboxPage } from './InboxPage';

const apiFetch = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetch,
}));

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function inboxWith(payload: Record<string, unknown>, proposalType = 'create_customer') {
  return jsonResponse({
    data: [
      {
        proposal: {
          id: 'p-cust',
          proposalType,
          summary: 'New customer from inbound call: Ashia Aksuna, 1207 Riverbell Drive',
          status: 'ready_for_review',
          createdAt: new Date().toISOString(),
          payload,
        },
        urgency: 'normal',
        reason: 'Awaiting review',
      },
    ],
    summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
  });
}

describe('InboxPage — service-address completion', () => {
  beforeEach(() => apiFetch.mockReset());

  it('offers the address boxes, prefilled from the spoken words', async () => {
    apiFetch.mockResolvedValueOnce(
      inboxWith({ name: 'Ashia Aksuna', address: '1207 Riverbell Drive' }),
    );
    render(<InboxPage />);

    await waitFor(() => expect(screen.getByTestId('address-completion')).toBeInTheDocument());
    expect(screen.getByTestId('address-input-street1')).toHaveValue('1207 Riverbell Drive');
    expect(screen.getByTestId('address-input-city')).toHaveValue('');
    expect(screen.getByTestId('address-consequence')).toHaveTextContent(
      'saved as a note, not a service location',
    );
  });

  it('offers nothing when the spoken address is already complete', async () => {
    apiFetch.mockResolvedValueOnce(
      inboxWith({ name: 'Mario Delingo', address: '412 Oak Street, Scottsdale, AZ 85254' }),
    );
    render(<InboxPage />);
    await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
    expect(screen.queryByTestId('address-completion')).toBeNull();
  });

  it('offers nothing on a proposal type that is not create_customer', async () => {
    // `add_service_location` carries an address too, and has its own
    // completeness handling — this control is create_customer's.
    apiFetch.mockResolvedValueOnce(
      inboxWith({ address: '1207 Riverbell Drive' }, 'add_service_location'),
    );
    render(<InboxPage />);
    await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
    expect(screen.queryByTestId('address-completion')).toBeNull();
  });

  it('PUTs the completed fields before POSTing the approval', async () => {
    apiFetch
      .mockResolvedValueOnce(inboxWith({ name: 'Ashia Aksuna', address: '1207 Riverbell Drive' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // PUT edit
      .mockResolvedValue(jsonResponse({ id: 'p-cust', status: 'approved' }));

    render(<InboxPage />);
    await waitFor(() => expect(screen.getByTestId('address-completion')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('address-input-city'), { target: { value: 'Scottsdale' } });
    fireEvent.change(screen.getByTestId('address-input-state'), { target: { value: 'AZ' } });
    fireEvent.change(screen.getByTestId('address-input-postalCode'), { target: { value: '85254' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(apiFetch.mock.calls.some((c) => c[0] === '/api/proposals/p-cust/approve')).toBe(true),
    );

    const editIndex = apiFetch.mock.calls.findIndex(
      (c) => c[0] === '/api/proposals/p-cust' && c[1]?.method === 'PUT',
    );
    const approveIndex = apiFetch.mock.calls.findIndex(
      (c) => c[0] === '/api/proposals/p-cust/approve',
    );
    // The edit must precede the approval — the approve endpoint applies the
    // proposal AS STORED, so an edit sent afterwards would change nothing.
    expect(editIndex).toBeGreaterThanOrEqual(0);
    expect(editIndex).toBeLessThan(approveIndex);

    // Payload keys verbatim — the executor reads exactly these.
    expect(JSON.parse(apiFetch.mock.calls[editIndex][1].body as string)).toEqual({
      edits: {
        street1: '1207 Riverbell Drive',
        city: 'Scottsdale',
        state: 'AZ',
        postalCode: '85254',
      },
    });
    expect(apiFetch.mock.calls[approveIndex][1].method).toBe('POST');
  });

  it('still approves when the approver leaves the boxes blank', async () => {
    // The approver may genuinely not know the ZIP. Approve must not be a
    // dead button — the API preserves the address as a note instead.
    // `street1` is already on the payload here, so nothing changed and no
    // edit should be sent at all.
    apiFetch
      .mockResolvedValueOnce(
        inboxWith({
          name: 'Ashia Aksuna',
          address: '1207 Riverbell Drive',
          street1: '1207 Riverbell Drive',
        }),
      )
      .mockResolvedValue(jsonResponse({ id: 'p-cust', status: 'approved' }));

    render(<InboxPage />);
    await waitFor(() => expect(screen.getByTestId('address-completion')).toBeInTheDocument());

    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);

    await waitFor(() =>
      expect(apiFetch.mock.calls.some((c) => c[0] === '/api/proposals/p-cust/approve')).toBe(true),
    );
    // No edit call at all — straight to approve.
    expect(apiFetch.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);
  });

  it('restores the row and does not approve when saving the edits fails', async () => {
    apiFetch
      .mockResolvedValueOnce(inboxWith({ name: 'Ashia Aksuna', address: '1207 Riverbell Drive' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, { status: 400 }));

    render(<InboxPage />);
    await waitFor(() => expect(screen.getByTestId('address-completion')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('address-input-city'), { target: { value: 'Scottsdale' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    // The approve POST never happened, and the row came back.
    expect(apiFetch.mock.calls.some((c) => String(c[0]).endsWith('/approve'))).toBe(false);
    await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
  });
});
