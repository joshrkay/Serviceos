import type { Meta, StoryObj } from '@storybook/react';
import { SystemEvent } from './SystemEvent';
import type { Message } from '../../types/conversation';

const meta: Meta<typeof SystemEvent> = {
  title: 'Conversations/SystemEvent',
  component: SystemEvent,
};
export default meta;

type Story = StoryObj<typeof SystemEvent>;

const systemMessage: Message = {
  id: 'sys-1',
  tenantId: 'tenant-1',
  conversationId: 'conv-1',
  messageType: 'system_event',
  content: 'Job #1042 was created and assigned to Joe.',
  senderId: 'system',
  senderRole: 'system',
  createdAt: '2026-03-14T14:36:00Z',
};

export const Default: Story = {
  args: { message: systemMessage },
};

export const ProposalApproved: Story = {
  args: {
    message: { ...systemMessage, content: 'Proposal approved by dispatcher Sarah.' },
  },
};
