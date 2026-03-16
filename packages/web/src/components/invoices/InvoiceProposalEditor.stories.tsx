import type { Meta, StoryObj } from '@storybook/react';
import { InvoiceProposalEditor } from './InvoiceProposalEditor';
import type { InvoiceProposalData } from './InvoiceProposalReview';

const meta: Meta<typeof InvoiceProposalEditor> = {
  title: 'Invoices/InvoiceProposalEditor',
  component: InvoiceProposalEditor,
};
export default meta;

type Story = StoryObj<typeof InvoiceProposalEditor>;

const baseProposal: InvoiceProposalData = {
  id: 'inv-prop-1',
  customerId: 'cust-1',
  jobId: 'job-1042',
  lineItems: [
    { description: 'Blower motor replacement', quantity: 1, unitPrice: 28500, category: 'parts' },
    { description: 'Labor (2 hrs)', quantity: 2, unitPrice: 9500, category: 'labor' },
  ],
  discountCents: 0,
  taxRateBps: 875,
  subtotalCents: 47500,
  taxCents: 4156,
  totalCents: 51656,
  customerMessage: 'Thank you for your business!',
  status: 'pending',
};

export const Default: Story = {
  args: {
    proposal: baseProposal,
    onSave: () => {},
    onCancel: () => {},
  },
};

export const WithDiscount: Story = {
  args: {
    proposal: { ...baseProposal, discountCents: 5000, totalCents: 46656 },
    onSave: () => {},
    onCancel: () => {},
  },
};
