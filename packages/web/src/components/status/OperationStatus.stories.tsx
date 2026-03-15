import type { Meta, StoryObj } from '@storybook/react';
import { OperationStatus } from './OperationStatus';
import type { OperationInfo } from '../../types/conversation';

const meta: Meta<typeof OperationStatus> = {
  title: 'Status/OperationStatus',
  component: OperationStatus,
};
export default meta;

type Story = StoryObj<typeof OperationStatus>;

const baseOp: OperationInfo = {
  id: 'op-1',
  type: 'schedule_job',
  state: 'pending',
  retryable: false,
};

export const Pending: Story = {
  args: { operation: baseOp },
};

export const InProgress: Story = {
  args: { operation: { ...baseOp, state: 'in_progress' } },
};

export const Success: Story = {
  args: { operation: { ...baseOp, state: 'success' } },
};

export const FailureRetryable: Story = {
  args: {
    operation: {
      ...baseOp,
      state: 'failure',
      errorMessage: 'Unable to reach the scheduling service.',
      retryable: true,
    },
    onRetry: () => {},
  },
};

export const FailureNoRetry: Story = {
  args: {
    operation: {
      ...baseOp,
      state: 'failure',
      errorMessage: 'Conflict: technician is already booked at this time.',
      retryable: false,
    },
  },
};
