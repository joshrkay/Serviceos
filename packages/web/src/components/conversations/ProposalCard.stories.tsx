import type { Meta, StoryObj } from '@storybook/react';
import { ProposalCard } from './ProposalCard';
import type { Proposal } from '../../types/conversation';

const meta: Meta<typeof ProposalCard> = {
  title: 'Conversations/ProposalCard',
  component: ProposalCard,
};
export default meta;

type Story = StoryObj<typeof ProposalCard>;

const pendingProposal: Proposal = {
  id: 'prop-1',
  type: 'schedule_job',
  summary: 'Schedule HVAC repair for Alice Johnson on March 16, 2026 between 9am–12pm. Assign technician Joe.',
  status: 'pending',
  details: { customerId: 'cust-1', technicianId: 'tech-joe', date: '2026-03-16' },
  createdAt: '2026-03-14T14:35:00Z',
};

export const PendingOwner: Story = {
  args: {
    proposal: pendingProposal,
    userRole: 'owner',
    onApprove: () => {},
    onReject: () => {},
    onOpenDetail: () => {},
  },
};

export const PendingDispatcher: Story = {
  args: {
    proposal: pendingProposal,
    userRole: 'dispatcher',
    onApprove: () => {},
    onReject: () => {},
    onOpenDetail: () => {},
  },
};

export const PendingTechnician: Story = {
  name: 'Pending (Technician — read only)',
  args: {
    proposal: pendingProposal,
    userRole: 'technician',
    onOpenDetail: () => {},
  },
};

export const Approved: Story = {
  args: {
    proposal: { ...pendingProposal, status: 'approved' },
    userRole: 'owner',
    onOpenDetail: () => {},
  },
};

export const Rejected: Story = {
  args: {
    proposal: { ...pendingProposal, status: 'rejected' },
    userRole: 'owner',
    onOpenDetail: () => {},
  },
};
