import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ListPage } from './ListPage';

type Customer = { id: string; name: string; email: string; phone: string; status: string };

const meta: Meta<typeof ListPage<Customer>> = {
  title: 'Core/ListPage',
  component: ListPage,
};
export default meta;

type Story = StoryObj<typeof ListPage<Customer>>;

const columns = [
  { key: 'name', header: 'Name', render: (c: Customer) => c.name },
  { key: 'email', header: 'Email', render: (c: Customer) => c.email },
  { key: 'phone', header: 'Phone', render: (c: Customer) => c.phone },
  { key: 'status', header: 'Status', render: (c: Customer) => c.status },
];

const sampleData: Customer[] = [
  { id: '1', name: 'Alice Johnson', email: 'alice@example.com', phone: '555-0101', status: 'Active' },
  { id: '2', name: 'Bob Martinez', email: 'bob@example.com', phone: '555-0102', status: 'Active' },
  { id: '3', name: 'Carol White', email: 'carol@example.com', phone: '555-0103', status: 'Archived' },
];

const baseProps = {
  title: 'Customers',
  columns,
  total: 3,
  page: 1,
  pageSize: 25,
  isLoading: false,
  error: null,
  searchPlaceholder: 'Search customers...',
  onSearch: () => {},
  onPageChange: () => {},
  onRetry: () => {},
  getRowKey: (c: Customer) => c.id,
};

export const Loaded: Story = {
  args: {
    ...baseProps,
    data: sampleData,
    onRowClick: () => {},
    onCreate: () => {},
    createLabel: 'Add Customer',
  },
};

export const Loading: Story = {
  args: { ...baseProps, isLoading: true, data: [] },
};

export const Empty: Story = {
  args: {
    ...baseProps,
    data: [],
    emptyTitle: 'No customers yet',
    emptyDescription: 'Add your first customer to get started.',
    createLabel: 'Add Customer',
    onCreate: () => {},
  },
};

export const Error: Story = {
  args: {
    ...baseProps,
    data: [],
    error: 'Failed to load customers. Check your connection and try again.',
  },
};

export const Paginated: Story = {
  args: {
    ...baseProps,
    data: sampleData,
    total: 75,
    page: 2,
    pageSize: 25,
    onPageChange: () => {},
  },
};
