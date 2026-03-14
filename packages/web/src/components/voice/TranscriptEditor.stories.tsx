import type { Meta, StoryObj } from '@storybook/react';
import { TranscriptEditor } from './TranscriptEditor';

const meta: Meta<typeof TranscriptEditor> = {
  title: 'Voice/TranscriptEditor',
  component: TranscriptEditor,
};
export default meta;

type Story = StoryObj<typeof TranscriptEditor>;

const original = 'Replaced the blower motor and capacitor. Unit is running normally now. Customer confirmed everything is working.';

export const EditableDispatcher: Story = {
  args: {
    originalTranscript: original,
    userRole: 'dispatcher',
    onSave: () => {},
    onCancel: () => {},
  },
};

export const EditableOwner: Story = {
  args: {
    originalTranscript: original,
    userRole: 'owner',
    onSave: () => {},
    onCancel: () => {},
  },
};

export const ReadOnlyTechnician: Story = {
  args: {
    originalTranscript: original,
    userRole: 'technician',
    onSave: () => {},
    onCancel: () => {},
  },
};

export const WithPreviousCorrection: Story = {
  args: {
    originalTranscript: original,
    currentTranscript: 'Replaced the blower motor and capacitor. Unit is running normally. Customer confirmed it is working.',
    userRole: 'dispatcher',
    onSave: () => {},
    onCancel: () => {},
  },
};
