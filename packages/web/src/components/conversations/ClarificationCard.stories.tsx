import type { Meta, StoryObj } from '@storybook/react';
import { ClarificationCard } from './ClarificationCard';
import type { ClarificationRequest } from '../../types/conversation';

const meta: Meta<typeof ClarificationCard> = {
  title: 'Conversations/ClarificationCard',
  component: ClarificationCard,
};
export default meta;

type Story = StoryObj<typeof ClarificationCard>;

const baseClarification: ClarificationRequest = {
  id: 'clar-1',
  question: 'Which technician should be assigned to this job?',
  taskId: 'task-1',
  resolved: false,
};

export const WithOptions: Story = {
  args: {
    clarification: {
      ...baseClarification,
      options: ['Joe (HVAC)', 'Maria (Electrical)', 'Either is fine'],
    },
    onRespond: () => {},
  },
};

export const FreeText: Story = {
  args: {
    clarification: { ...baseClarification, question: 'What is the customer\'s preferred arrival window?' },
    onRespond: () => {},
  },
};

export const Resolved: Story = {
  args: {
    clarification: {
      ...baseClarification,
      resolved: true,
      response: 'Joe (HVAC)',
    },
    onRespond: () => {},
  },
};
