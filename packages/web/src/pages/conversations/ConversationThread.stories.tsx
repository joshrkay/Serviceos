import type { Meta, StoryObj } from '@storybook/react';
import { ConversationThread } from './ConversationThread';
import type { Message } from '../../types/conversation';

const meta: Meta<typeof ConversationThread> = {
  title: 'Pages/ConversationThread',
  component: ConversationThread,
};
export default meta;

type Story = StoryObj<typeof ConversationThread>;

const messages: Message[] = [
  {
    id: 'msg-1',
    tenantId: 't1',
    conversationId: 'c1',
    messageType: 'text',
    content: 'Customer called in — HVAC unit making a grinding noise.',
    senderId: 'dispatcher-sarah',
    senderRole: 'dispatcher',
    createdAt: '2026-03-14T14:00:00Z',
  },
  {
    id: 'msg-2',
    tenantId: 't1',
    conversationId: 'c1',
    messageType: 'system_event',
    content: 'Job #1042 created and assigned to Joe.',
    senderId: 'system',
    senderRole: 'system',
    createdAt: '2026-03-14T14:01:00Z',
  },
  {
    id: 'msg-3',
    tenantId: 't1',
    conversationId: 'c1',
    messageType: 'text',
    content: 'On my way. ETA 20 minutes.',
    senderId: 'tech-joe',
    senderRole: 'technician',
    createdAt: '2026-03-14T14:30:00Z',
  },
];

export const Empty: Story = {
  args: {
    messages: [],
    currentUserRole: 'dispatcher',
    onSendMessage: () => {},
  },
};

export const WithMessages: Story = {
  args: {
    messages,
    currentUserRole: 'dispatcher',
    onSendMessage: () => {},
  },
};

export const Disabled: Story = {
  args: {
    messages,
    currentUserRole: 'technician',
    onSendMessage: () => {},
    disabled: true,
  },
};
