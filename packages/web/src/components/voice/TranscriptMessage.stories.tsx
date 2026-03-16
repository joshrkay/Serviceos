import type { Meta, StoryObj } from '@storybook/react';
import { TranscriptMessage } from './TranscriptMessage';

const meta: Meta<typeof TranscriptMessage> = {
  title: 'Voice/TranscriptMessage',
  component: TranscriptMessage,
};
export default meta;

type Story = StoryObj<typeof TranscriptMessage>;

const sender = {
  senderId: 'tech-joe',
  senderRole: 'technician',
  createdAt: '2026-03-14T15:00:00Z',
};

export const Pending: Story = {
  args: { ...sender, status: 'pending' },
};

export const Processing: Story = {
  args: { ...sender, status: 'processing' },
};

export const Completed: Story = {
  args: {
    ...sender,
    status: 'completed',
    transcript: 'Replaced the blower motor and capacitor. Unit is running normally now. Customer confirmed everything is working.',
  },
};

export const Failed: Story = {
  args: {
    ...sender,
    status: 'failed',
    errorMessage: 'Audio quality too low for transcription.',
    onRetry: () => {},
  },
};

export const FailedNoRetry: Story = {
  args: {
    ...sender,
    status: 'failed',
    errorMessage: 'File format not supported.',
  },
};
