import type { Meta, StoryObj } from '@storybook/react';
import { VoiceRecorder } from './VoiceRecorder';

const meta: Meta<typeof VoiceRecorder> = {
  title: 'Voice/VoiceRecorder',
  component: VoiceRecorder,
};
export default meta;

type Story = StoryObj<typeof VoiceRecorder>;

const baseActions = {
  onStart: () => {},
  onStop: () => {},
  onCancel: () => {},
  onReRecord: () => {},
  onUpload: () => {},
};

export const Idle: Story = {
  args: { ...baseActions, state: 'idle', duration: 0 },
};

export const Recording: Story = {
  args: { ...baseActions, state: 'recording', duration: 47 },
};

export const Stopped: Story = {
  args: { ...baseActions, state: 'stopped', duration: 93 },
};

export const Uploading: Story = {
  args: { ...baseActions, state: 'uploading', duration: 93 },
};

export const Transcribing: Story = {
  args: { ...baseActions, state: 'transcribing', duration: 93 },
};
