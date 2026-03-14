import type { Meta, StoryObj } from '@storybook/react';
import { PaymentRecordForm } from './PaymentRecordForm';

const meta: Meta<typeof PaymentRecordForm> = {
  title: 'Payments/PaymentRecordForm',
  component: PaymentRecordForm,
};
export default meta;

type Story = StoryObj<typeof PaymentRecordForm>;

export const FullBalance: Story = {
  args: {
    invoiceId: 'inv-1',
    amountDueCents: 56550,
    onSubmit: () => {},
    onCancel: () => {},
  },
};

export const PartialPayment: Story = {
  args: {
    invoiceId: 'inv-1',
    amountDueCents: 56550,
    onSubmit: () => {},
    onCancel: () => {},
  },
};
