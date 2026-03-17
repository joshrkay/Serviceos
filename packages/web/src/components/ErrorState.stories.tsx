import type { Meta, StoryObj } from '@storybook/react';
import { ErrorState } from './ErrorState';

const meta: Meta<typeof ErrorState> = {
  title: 'Core/ErrorState',
  component: ErrorState,
};
export default meta;

type Story = StoryObj<typeof ErrorState>;

export const WithRetry: Story = {
  args: {
    message: 'Failed to load customers. Please try again.',
    onRetry: () => {},
  },
};

export const WithoutRetry: Story = {
  args: {
    message: 'You do not have permission to view this resource.',
  },
};
