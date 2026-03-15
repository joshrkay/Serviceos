import type { Meta, StoryObj } from '@storybook/react';
import { InvoiceProposalReview } from './InvoiceProposalReview';
import type { InvoiceProposalData } from './InvoiceProposalReview';

const meta: Meta<typeof InvoiceProposalReview> = {
  title: 'Invoices/InvoiceProposalReview',
  component: InvoiceProposalReview,
};
export default meta;

type Story = StoryObj<typeof InvoiceProposalReview>;

const baseProposal: InvoiceProposalData = {
  id: 'inv-prop-1',
  customerId: 'cust-1',
  jobId: 'job-1042',
  lineItems: [
    { description: 'Blower motor replacement', quantity: 1, unitPrice: 28500, category: 'parts' },
    { description: 'Capacitor replacement', quantity: 1, unitPrice: 4500, category: 'parts' },
    { description: 'Labor (2 hrs)', quantity: 2, unitPrice: 9500, category: 'labor' },
  ],
  discountCents: 0,
  taxRateBps: 875,
  subtotalCents: 52000,
  taxCents: 4550,
  totalCents: 56550,
  status: 'pending',
  confidenceScore: 0.92,
  explanation: 'Based on technician voice update: blower motor and capacitor replacement required.',
  customerMessage: 'Thank you for your business! Parts and labor for HVAC repair.',
};

export const Pending: Story = {
  args: {
    proposal: baseProposal,
    onEdit: () => {},
    onApprove: () => {},
    onReject: () => {},
  },
};

export const WithDiscount: Story = {
  args: {
    proposal: {
      ...baseProposal,
      discountCents: 5000,
      totalCents: 51550,
    },
    onApprove: () => {},
    onReject: () => {},
  },
};

export const WithEstimateRef: Story = {
  args: {
    proposal: { ...baseProposal, estimateId: 'est-221' },
    onApprove: () => {},
    onReject: () => {},
  },
};

export const Approved: Story = {
  args: {
    proposal: { ...baseProposal, status: 'approved' },
  },
};

export const LowConfidence: Story = {
  args: {
    proposal: { ...baseProposal, confidenceScore: 0.48 },
    onEdit: () => {},
    onApprove: () => {},
    onReject: () => {},
  },
};
