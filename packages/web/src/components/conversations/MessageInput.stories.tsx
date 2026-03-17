import type { Meta, StoryObj } from '@storybook/react';
import { MessageInput } from './MessageInput';

const meta: Meta<typeof MessageInput> = {
  title: 'Conversations/MessageInput',
  component: MessageInput,
};
export default meta;

type Story = StoryObj<typeof MessageInput>;

export const Default: Story = {
  args: { onSend: () => {} },
};

export const Disabled: Story = {
  args: { onSend: () => {}, disabled: true },
};

export const CustomPlaceholder: Story = {
  args: { onSend: () => {}, placeholder: 'Add a note or instruction...' },
};
