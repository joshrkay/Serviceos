import type { Meta, StoryObj } from '@storybook/react';
import { MobileTechView } from './MobileTechView';
import type { AssignedJob } from './MobileTechView';

const meta: Meta<typeof MobileTechView> = {
  title: 'Pages/MobileTechView',
  component: MobileTechView,
  parameters: {
    viewport: { defaultViewport: 'mobile' },
  },
};
export default meta;

type Story = StoryObj<typeof MobileTechView>;

const jobs: AssignedJob[] = [
  {
    id: 'job-1042',
    title: 'HVAC Repair — Alice Johnson',
    address: '123 Main St, Springfield',
    appointmentId: 'apt-1',
    appointmentTime: '9:00 AM – 12:00 PM',
  },
  {
    id: 'job-1043',
    title: 'Electrical Inspection — Bob Martinez',
    address: '456 Oak Ave, Springfield',
    appointmentTime: '1:00 PM – 3:00 PM',
  },
];

export const NoJobs: Story = {
  args: {
    assignedJobs: [],
    onSelectJob: () => {},
    onUploadRecording: async () => {},
  },
};

export const JobList: Story = {
  args: {
    assignedJobs: jobs,
    onSelectJob: () => {},
    onUploadRecording: async () => {},
  },
};

export const JobSelected: Story = {
  args: {
    assignedJobs: jobs,
    selectedJobId: 'job-1042',
    onSelectJob: () => {},
    onUploadRecording: async () => {},
  },
};

export const WithTranscript: Story = {
  args: {
    assignedJobs: jobs,
    selectedJobId: 'job-1042',
    onSelectJob: () => {},
    onUploadRecording: async () => {},
    transcriptionStatus: 'completed',
    transcript: 'Replaced the blower motor and capacitor. Unit is running normally. Customer confirmed.',
  },
};
