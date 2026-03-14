import type { Meta, StoryObj } from '@storybook/react';
import { MessageBubble } from './MessageBubble';
import type { Message } from '../../types/conversation';

const meta: Meta<typeof MessageBubble> = {
  title: 'Conversations/MessageBubble',
  component: MessageBubble,
};
export default meta;

type Story = StoryObj<typeof MessageBubble>;

const baseMessage: Message = {
  id: 'msg-1',
  tenantId: 'tenant-1',
  conversationId: 'conv-1',
  messageType: 'text',
  content: 'The customer called in asking about their HVAC system. Unit is making a loud grinding noise.',
  senderId: 'user-dispatcher',
  senderRole: 'dispatcher',
  createdAt: '2026-03-14T14:30:00Z',
};

export const DispatcherMessage: Story = {
  args: { message: baseMessage, currentUserRole: 'dispatcher' },
};

export const OwnerMessage: Story = {
  args: {
    message: { ...baseMessage, senderId: 'user-owner', senderRole: 'owner', content: 'Please prioritize this — the customer is a long-term account.' },
    currentUserRole: 'owner',
  },
};

export const TechnicianMessage: Story = {
  args: {
    message: { ...baseMessage, senderId: 'tech-joe', senderRole: 'technician', content: 'On my way. ETA 20 minutes.' },
    currentUserRole: 'technician',
  },
};

export const LongMessage: Story = {
  args: {
    message: {
      ...baseMessage,
      content: 'I inspected the unit and found the blower motor bearings are worn out. This is causing the grinding noise. I also noticed the capacitor is reading low. I recommend replacing both the blower motor and capacitor to restore proper operation and prevent a full breakdown. Parts are available and I can complete the repair today if approved.',
    },
  },
};
