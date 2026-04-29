import { describe, it, expect } from 'vitest';
import {
  renderEstimateEmail,
  renderEstimateSms,
  renderInvoiceEmail,
  renderInvoiceSms,
} from '../../src/notifications/templates';

describe('estimate templates', () => {
  const ctx = {
    customerName: 'Sarah Johnson',
    estimateNumber: 'EST-1042',
    totalCents: 87500,
    businessName: 'Acme HVAC',
    viewUrl: 'https://app.example.com/e/abc123',
  };

  it('renders SMS with name, number, total and link', () => {
    const { body } = renderEstimateSms(ctx);
    expect(body).toContain('Sarah Johnson');
    expect(body).toContain('Acme HVAC');
    expect(body).toContain('EST-1042');
    expect(body).toContain('$875.00');
    expect(body).toContain('https://app.example.com/e/abc123');
  });

  it('inserts custom message into SMS when present', () => {
    const { body } = renderEstimateSms({
      ...ctx,
      customMessage: 'Quote is good for 30 days.',
    });
    expect(body).toContain('Quote is good for 30 days.');
  });

  it('renders email with subject and HTML escaped', () => {
    const { subject, text, html } = renderEstimateEmail({
      ...ctx,
      customerName: 'Tom <tags>',
    });
    expect(subject).toBe('Estimate EST-1042 from Acme HVAC');
    expect(text).toContain('Tom <tags>');
    expect(html).toContain('Tom &lt;tags&gt;');
    expect(html).not.toContain('Tom <tags>');
  });
});

describe('invoice templates', () => {
  const ctx = {
    customerName: 'Bob Rodriguez',
    invoiceNumber: 'INV-2042',
    totalCents: 125000,
    businessName: 'Acme HVAC',
    viewUrl: 'https://app.example.com/pay/xyz789',
    dueDateIso: '2026-05-15T00:00:00.000Z',
  };

  it('renders SMS with due date when present', () => {
    const { body } = renderInvoiceSms(ctx);
    expect(body).toContain('Bob Rodriguez');
    expect(body).toContain('INV-2042');
    expect(body).toContain('$1250.00');
    expect(body).toContain('Due 2026-05-15');
    expect(body).toContain('https://app.example.com/pay/xyz789');
  });

  it('omits due date line when not provided', () => {
    const { body } = renderInvoiceSms({ ...ctx, dueDateIso: undefined });
    expect(body).not.toContain('Due ');
  });

  it('renders email with HTML payment button link', () => {
    const { html } = renderInvoiceEmail(ctx);
    expect(html).toContain('href="https://app.example.com/pay/xyz789"');
    expect(html).toContain('Pay Invoice Online');
  });
});
