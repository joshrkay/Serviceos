import type { Meta, StoryObj } from '@storybook/react';
import { InvoiceProposalActions } from './InvoiceProposalActions';

const meta: Meta<typeof InvoiceProposalActions> = {
  title: 'Invoices/InvoiceProposalActions',
  component: InvoiceProposalActions,
};
export default meta;

type Story = StoryObj<typeof InvoiceProposalActions>;

export const PendingOwner: Story = {
  args: {
    proposalId: 'inv-prop-1',
    userRole: 'owner',
    status: 'pending',
    onApprove: () => {},
    onReject: () => {},
  },
};

export const PendingDispatcher: Story = {
  args: {
    proposalId: 'inv-prop-1',
    userRole: 'dispatcher',
    status: 'pending',
    onApprove: () => {},
    onReject: () => {},
  },
};

export const PendingTechnician: Story = {
  name: 'Pending (Technician — no actions)',
  args: {
    proposalId: 'inv-prop-1',
    userRole: 'technician',
    status: 'pending',
    onApprove: () => {},
    onReject: () => {},
  },
};

export const AlreadyApproved: Story = {
  args: {
    proposalId: 'inv-prop-1',
    userRole: 'owner',
    status: 'approved',
    onApprove: () => {},
    onReject: () => {},
  },
};
