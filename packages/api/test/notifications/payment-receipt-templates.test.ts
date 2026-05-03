import { describe, it, expect } from 'vitest';
import {
  renderPaymentReceiptEmail,
  renderPaymentReceiptSms,
  PaymentReceiptContext,
} from '../../src/notifications/templates';

const baseCtx: PaymentReceiptContext = {
  customerName: 'Sandra',
  invoiceNumber: 'INV-0042',
  amountPaidCents: 100000,
  amountDueCents: 0,
  invoiceTotalCents: 100000,
  paymentMethodLabel: 'Credit card',
  paidAtIso: '2026-05-03T12:34:56.000Z',
  businessName: 'Ortega HVAC',
  invoiceUrl: 'https://pay.example.com/abc',
};

describe('payment receipt templates', () => {
  it('renders SMS with paid-in-full message when amountDue is 0', () => {
    const sms = renderPaymentReceiptSms(baseCtx);
    expect(sms.body).toContain('Sandra');
    expect(sms.body).toContain('INV-0042');
    expect(sms.body).toContain('$1000.00');
    expect(sms.body).toContain('Credit card');
    expect(sms.body).toContain('paid in full');
  });

  it('renders SMS with remaining balance when partial', () => {
    const sms = renderPaymentReceiptSms({
      ...baseCtx,
      amountPaidCents: 30000,
      amountDueCents: 70000,
    });
    expect(sms.body).toContain('Remaining balance: $700.00');
    expect(sms.body).not.toContain('paid in full');
  });

  it('email subject + body cover invoice number, totals, method', () => {
    const email = renderPaymentReceiptEmail(baseCtx);
    expect(email.subject).toContain('INV-0042');
    expect(email.text).toContain('$1000.00');
    expect(email.text).toContain('Credit card');
    expect(email.html).toContain('INV-0042');
    expect(email.html).toContain('Credit card');
  });

  it('email omits view-invoice link when not provided', () => {
    const email = renderPaymentReceiptEmail({ ...baseCtx, invoiceUrl: undefined });
    expect(email.text).not.toContain('View invoice');
    expect(email.html).not.toContain('View invoice');
  });
});
