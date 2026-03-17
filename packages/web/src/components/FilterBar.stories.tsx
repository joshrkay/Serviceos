import type { Meta, StoryObj } from '@storybook/react';
import { FilterBar } from './FilterBar';

const meta: Meta<typeof FilterBar> = {
  title: 'Core/FilterBar',
  component: FilterBar,
};
export default meta;

type Story = StoryObj<typeof FilterBar>;

const statusFilter = {
  key: 'status',
  label: 'Status',
  options: [
    { label: 'Active', value: 'active' },
    { label: 'Archived', value: 'archived' },
  ],
};

const priorityFilter = {
  key: 'priority',
  label: 'Priority',
  options: [
    { label: 'Low', value: 'low' },
    { label: 'Normal', value: 'normal' },
    { label: 'High', value: 'high' },
    { label: 'Emergency', value: 'emergency' },
  ],
};

export const NoActiveFilters: Story = {
  args: {
    filters: [statusFilter, priorityFilter],
    activeFilters: {},
    onFilterChange: () => {},
    onClearFilters: () => {},
  },
};

export const WithActiveFilters: Story = {
  args: {
    filters: [statusFilter, priorityFilter],
    activeFilters: { status: 'active', priority: 'high' },
    onFilterChange: () => {},
    onClearFilters: () => {},
  },
};
