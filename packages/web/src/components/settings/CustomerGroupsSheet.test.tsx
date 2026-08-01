import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CustomerGroupsSheet,
  type CustomerGroupsSheetApi,
} from './CustomerGroupsSheet';
import type { CustomerGroupWithCount } from '../../api/customer-groups';

const group = (over: Partial<CustomerGroupWithCount> = {}): CustomerGroupWithCount => ({
  id: 'g1',
  tenantId: 'tn',
  name: 'VIP',
  description: null,
  color: '#3b82f6',
  isArchived: false,
  memberCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<CustomerGroupsSheetApi> = {}): CustomerGroupsSheetApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(group()),
    archive: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('CustomerGroupsSheet (U8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists groups with member counts', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([group()]) });
    render(<CustomerGroupsSheet onClose={() => {}} api={api} />);
    expect(await screen.findByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
  });

  it('creates a group with a name + color', async () => {
    const api = mockApi();
    render(<CustomerGroupsSheet onClose={() => {}} api={api} />);
    fireEvent.change(await screen.findByLabelText('New group name'), {
      target: { value: 'Commercial' },
    });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ name: 'Commercial', color: '#3b82f6' }),
    );
  });

  it('blocks creating without a name', async () => {
    const api = mockApi();
    render(<CustomerGroupsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByText('Add'));
    expect(await screen.findByText(/Give the group a name/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('archives a group', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([group()]) });
    render(<CustomerGroupsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByLabelText('Remove VIP'));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith('g1'));
  });
});
