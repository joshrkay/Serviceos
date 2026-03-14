import type { Meta, StoryObj } from '@storybook/react';
import { ContextPanel } from './context-panel';
import type { ContextEntity } from '../../types/conversation';

const meta: Meta<typeof ContextPanel> = {
  title: 'Conversations/ContextPanel',
  component: ContextPanel,
};
export default meta;

type Story = StoryObj<typeof ContextPanel>;

const customerEntity: ContextEntity = {
  type: 'customer',
  id: 'cust-1',
  label: 'Alice Johnson',
  details: { email: 'alice@example.com', phone: '555-0101', status: 'active' },
};

const jobEntity: ContextEntity = {
  type: 'job',
  id: 'job-1042',
  label: 'Job #1042',
  details: { summary: 'HVAC grinding noise', status: 'in_progress', priority: 'high' },
};

export const WithCustomer: Story = {
  args: {
    entities: [customerEntity],
    conversationTitle: 'HVAC Repair — Alice Johnson',
  },
};

export const WithJob: Story = {
  args: {
    entities: [jobEntity],
  },
};

export const MultipleEntities: Story = {
  args: {
    entities: [customerEntity, jobEntity],
    conversationTitle: 'HVAC Repair — Alice Johnson',
  },
};

export const Empty: Story = {
  args: { entities: [] },
};
