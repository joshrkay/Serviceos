import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CustomerGroupsPanel,
  type CustomerGroupsPanelApi,
} from './CustomerGroupsPanel';
import type { CustomerGroup, CustomerGroupWithCount } from '../../api/customer-groups';

const group = (over: Partial<CustomerGroupWithCount> = {}): CustomerGroupWithCount => ({
  id: 'g1',
  tenantId: 'tn',
  name: 'VIP',
  description: null,
  color: '#3b82f6',
  isArchived: false,
  memberCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<CustomerGroupsPanelApi> = {}): CustomerGroupsPanelApi {
  return {
    listGroups: vi.fn().mockResolvedValue([]),
    forCustomer: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('CustomerGroupsPanel (U8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hints when no groups are defined', async () => {
    render(<CustomerGroupsPanel customerId="c1" api={mockApi()} />);
    expect(await screen.findByText(/No groups defined/)).toBeInTheDocument();
  });

  it('checks the groups the customer already belongs to', async () => {
    const api = mockApi({
      listGroups: vi.fn().mockResolvedValue([group({ id: 'g1', name: 'VIP' }), group({ id: 'g2', name: 'Commercial' })]),
      forCustomer: vi.fn().mockResolvedValue([{ ...group({ id: 'g1' }) } as CustomerGroup]),
    });
    render(<CustomerGroupsPanel customerId="c1" api={api} />);
    expect((await screen.findByLabelText('VIP')) as HTMLInputElement).toBeChecked();
    expect(screen.getByLabelText('Commercial')).not.toBeChecked();
  });

  it('adds the customer to a group on check', async () => {
    const api = mockApi({ listGroups: vi.fn().mockResolvedValue([group({ id: 'g1', name: 'VIP' })]) });
    render(<CustomerGroupsPanel customerId="c1" api={api} />);
    fireEvent.click(await screen.findByLabelText('VIP'));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('g1', 'c1'));
  });

  it('removes the customer from a group on uncheck', async () => {
    const api = mockApi({
      listGroups: vi.fn().mockResolvedValue([group({ id: 'g1', name: 'VIP' })]),
      forCustomer: vi.fn().mockResolvedValue([{ ...group({ id: 'g1' }) } as CustomerGroup]),
    });
    render(<CustomerGroupsPanel customerId="c1" api={api} />);
    fireEvent.click(await screen.findByLabelText('VIP'));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('g1', 'c1'));
  });
});
