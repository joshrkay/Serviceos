/**
 * #1281 — archiving a customer needs a confirm step, and an archived
 * customer needs a way back (restore).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { CustomerDetail } from './CustomerDetail';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../components/customers/CommunicationTimeline', () => ({ CommunicationTimeline: () => null }));
vi.mock('../../components/customers/CustomerProfitCard', () => ({ CustomerProfitCard: () => null }));
vi.mock('../../components/customers/ContactsPanel', () => ({ ContactsPanel: () => null }));
vi.mock('../../components/customers/TagsPanel', () => ({ TagsPanel: () => null }));
vi.mock('../../components/customers/CustomFieldsPanel', () => ({ CustomFieldsPanel: () => null }));
vi.mock('../../components/customers/RecurringJobsPanel', () => ({ RecurringJobsPanel: () => null }));
vi.mock('../../components/customers/CustomerGroupsPanel', () => ({ CustomerGroupsPanel: () => null }));
vi.mock('../../components/customers/CustomerRecordsPanel', () => ({ CustomerRecordsPanel: () => null }));
vi.mock('../../components/customers/MergeCustomerPanel', () => ({ MergeCustomerPanel: () => null }));
vi.mock('../../components/customers/PortalAccessPanel', () => ({ PortalAccessPanel: () => null }));

import { toast } from 'sonner';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { apiFetch } from '../../utils/api-fetch';

const refetch = vi.fn();

function mockCustomer(isArchived: boolean) {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: {
      id: '1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith',
      preferredChannel: 'phone', isArchived,
    },
    isLoading: false, error: null, refetch,
  });
}

function postsTo(path: string) {
  return vi
    .mocked(apiFetch)
    .mock.calls.filter(
      (c) => String(c[0]) === path && (c[1] as RequestInit | undefined)?.method === 'POST',
    );
}

function renderDetail(onArchived = vi.fn()) {
  render(
    <MemoryRouter>
      <CustomerDetail customerId="1" onArchived={onArchived} />
    </MemoryRouter>,
  );
  return onArchived;
}

describe('CustomerDetail — archive confirm + restore (#1281)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }) as unknown as Response);
    refetch.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('Archive asks for confirmation first and does nothing on Cancel', async () => {
    mockCustomer(false);
    const onArchived = renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Archive Alice Smith\?/);
    expect(postsTo('/api/customers/1/archive')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postsTo('/api/customers/1/archive')).toHaveLength(0);
    expect(onArchived).not.toHaveBeenCalled();
  });

  it('confirming archives the customer and leaves the page', async () => {
    mockCustomer(false);
    const onArchived = renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(1));
    expect(postsTo('/api/customers/1/archive')).toHaveLength(1);
  });

  it('a failed archive keeps the customer on screen and says so', async () => {
    mockCustomer(false);
    vi.mocked(apiFetch).mockImplementation(async (url) => ({
      ok: !String(url).endsWith('/archive'),
      status: String(url).endsWith('/archive') ? 500 : 200,
      json: async () => (String(url).endsWith('/archive') ? { message: 'boom' } : []),
    }) as unknown as Response);
    const onArchived = renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onArchived).not.toHaveBeenCalled();
  });

  it('an archived customer shows a banner with a 44px Restore control that restores and refreshes', async () => {
    mockCustomer(true);
    renderDetail();

    const banner = screen.getByTestId('customer-archived-banner');
    expect(banner).toHaveTextContent(/archived/i);
    const restore = screen.getByRole('button', { name: 'Restore customer' });
    expect(restore.className).toMatch(/min-h-11/);
    // The dead "Archived" (disabled) header button is gone.
    expect(screen.queryByRole('button', { name: 'Archived' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    fireEvent.click(restore);

    await waitFor(() => expect(postsTo('/api/customers/1/restore')).toHaveLength(1));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Customer restored');
  });
});
