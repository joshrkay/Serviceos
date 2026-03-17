import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DetailPage } from './DetailPage';

const meta: Meta<typeof DetailPage> = {
  title: 'Core/DetailPage',
  component: DetailPage,
};
export default meta;

type Story = StoryObj<typeof DetailPage>;

const sections = [
  {
    title: 'Contact Information',
    content: (
      <dl>
        <dt>Email</dt><dd>alice@example.com</dd>
        <dt>Phone</dt><dd>555-0101</dd>
        <dt>Preferred Channel</dt><dd>Email</dd>
      </dl>
    ),
  },
];

const actions = [
  { label: 'Edit', onClick: () => {}, variant: 'primary' as const },
  { label: 'Archive', onClick: () => {}, variant: 'danger' as const },
];

export const Loaded: Story = {
  args: {
    title: 'Alice Johnson',
    subtitle: 'Acme Corp',
    sections,
    actions,
    isLoading: false,
    error: null,
    onBack: () => {},
    onRetry: () => {},
  },
};

export const Loading: Story = {
  args: {
    title: '',
    sections: [],
    isLoading: true,
    error: null,
    onRetry: () => {},
  },
};

export const Error: Story = {
  args: {
    title: '',
    sections: [],
    isLoading: false,
    error: 'Customer not found.',
    onRetry: () => {},
  },
};
