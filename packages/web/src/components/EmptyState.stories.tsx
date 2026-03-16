import type { Meta, StoryObj } from '@storybook/react';
import { EmptyState } from './EmptyState';

const meta: Meta<typeof EmptyState> = {
  title: 'Core/EmptyState',
  component: EmptyState,
};
export default meta;

type Story = StoryObj<typeof EmptyState>;

export const WithAction: Story = {
  args: {
    title: 'No customers yet',
    description: 'Add your first customer to get started.',
    actionLabel: 'Add Customer',
    onAction: () => {},
  },
};

export const WithoutAction: Story = {
  args: {
    title: 'No results found',
    description: 'Try adjusting your search or filters.',
  },
};
