import { describe, it, expect } from 'vitest';
import {
  renderEstimateEmail,
  renderEstimateSms,
  renderInvoiceEmail,
  renderInvoiceSms,
  renderWelcomeEmail,
  renderSetupReminderEmail,
  renderTrialEndingEmail,
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

  it('renders Spanish SMS when language is es (money/number unchanged)', () => {
    const { body } = renderEstimateSms({ ...ctx, language: 'es' });
    expect(body).toContain('su presupuesto de Acme HVAC está listo');
    expect(body).toContain('EST-1042');
    expect(body).toContain('$875.00');
    expect(body).toContain('https://app.example.com/e/abc123');
  });

  it('omitting language is byte-identical to language: en (regression)', () => {
    expect(renderEstimateSms(ctx).body).toBe(renderEstimateSms({ ...ctx, language: 'en' }).body);
  });

  it('renders Spanish email subject when language is es', () => {
    const { subject } = renderEstimateEmail({ ...ctx, language: 'es' });
    expect(subject).toBe('Presupuesto EST-1042 de Acme HVAC');
  });
});

describe('onboarding lifecycle emails', () => {
  const base = { appBaseUrl: 'https://app.rivet.ai', supportEmail: 'support@rivet.ai' };

  it('welcome email links to /onboarding and lists what Rivet does', () => {
    const { subject, text, html } = renderWelcomeEmail(base);
    expect(subject).toMatch(/welcome to rivet/i);
    expect(text).toContain('https://app.rivet.ai/onboarding');
    expect(html).toContain('https://app.rivet.ai/onboarding');
    expect(text).toContain('Answers every call');
    expect(html).toContain('support@rivet.ai');
  });

  it('setup reminder lists the outstanding steps and escapes them', () => {
    const { subject, text, html } = renderSetupReminderEmail({
      ...base,
      businessName: 'M&R Mechanical',
      remainingSteps: ['Forward your phone line', 'Start your free trial'],
    });
    expect(subject).toMatch(/finish setting up/i);
    expect(text).toContain('Forward your phone line');
    expect(text).toContain('Start your free trial');
    expect(html).toContain('Forward your phone line');
    // Business name is HTML-escaped in the body.
    expect(html).toContain('M&amp;R Mechanical');
    expect(html).not.toContain('M&R Mechanical');
  });

  it('trial-ending copy varies by daysLeft', () => {
    expect(renderTrialEndingEmail({ ...base, daysLeft: 3 }).subject).toMatch(/in 3 days/i);
    expect(renderTrialEndingEmail({ ...base, daysLeft: 1 }).subject).toMatch(/tomorrow/i);
    const today = renderTrialEndingEmail({ ...base, daysLeft: 0 });
    expect(today.subject).toMatch(/today/i);
    expect(today.text).toContain('https://app.rivet.ai/settings');
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
