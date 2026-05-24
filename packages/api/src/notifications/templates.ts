/**
 * Message templates for estimate and invoice delivery.
 *
 * Kept as pure functions returning the rendered subject/text/html so
 * tests can snapshot output and so a future i18n pass can swap the
 * functions without touching the routes that call them.
 *
 * Money is always rendered from integer cents — never trust the
 * caller to format. HTML is intentionally minimal: most service
 * customers open SMS first; the email is a backup with the same link.
 *
 * P11-002 — copy is localized via the notifications catalog (`tn`). Each
 * context carries an optional `language`; omitted → 'en' (back-compat).
 */
import { tn } from './i18n';
import type { Language } from '../ai/i18n/i18n';

export interface EstimateMessageContext {
  customerName: string;
  estimateNumber: string;
  totalCents: number;
  businessName: string;
  viewUrl: string;
  customMessage?: string;
  language?: Language;
}

export interface InvoiceMessageContext {
  customerName: string;
  invoiceNumber: string;
  totalCents: number;
  businessName: string;
  viewUrl: string;
  dueDateIso?: string;
  customMessage?: string;
  language?: Language;
}

export interface RenderedSms {
  body: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function formatMoney(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEstimateSms(ctx: EstimateMessageContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  const lines = [
    tn('sms.estimate.ready', lang, { name: ctx.customerName, business: ctx.businessName }),
    tn('sms.estimate.amount', lang, {
      number: ctx.estimateNumber,
      total: formatMoney(ctx.totalCents),
    }),
    tn('sms.estimate.cta', lang, { url: ctx.viewUrl }),
  ];
  if (ctx.customMessage && ctx.customMessage.trim().length > 0) {
    lines.splice(2, 0, ctx.customMessage.trim());
  }
  return { body: lines.join('\n') };
}

export function renderEstimateEmail(ctx: EstimateMessageContext): RenderedEmail {
  const lang = ctx.language ?? 'en';
  const subject = tn('email.estimate.subject', lang, {
    number: ctx.estimateNumber,
    business: ctx.businessName,
  });
  const heading = tn('email.estimate.heading', lang, { number: ctx.estimateNumber });
  const intro = tn('email.common.intro', lang, { name: ctx.customerName });
  const body = tn('email.estimate.body', lang, { business: ctx.businessName });
  const total = tn('email.estimate.total', lang, { total: formatMoney(ctx.totalCents) });
  const numberLine = tn('email.estimate.number', lang, { number: ctx.estimateNumber });
  const ctaText = tn('email.estimate.cta_text', lang, { url: ctx.viewUrl });
  const buttonLabel = tn('email.estimate.button', lang);
  const signature = tn('email.common.signature', lang, { business: ctx.businessName });
  const note = ctx.customMessage?.trim();

  const text = [
    intro,
    '',
    body,
    '',
    numberLine,
    total,
    '',
    note ? `${note}\n` : '',
    ctaText,
    '',
    signature,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937;">
    <h2 style="margin: 0 0 16px 0; font-size: 20px;">${escapeHtml(heading)}</h2>
    <p style="margin: 0 0 12px 0;">${escapeHtml(intro)}</p>
    <p style="margin: 0 0 16px 0;">${escapeHtml(body)}</p>
    ${note ? `<p style="margin: 0 0 16px 0; padding: 12px; background: #f3f4f6; border-radius: 6px;">${escapeHtml(note)}</p>` : ''}
    <p style="margin: 0 0 24px 0; font-size: 18px;"><strong>${escapeHtml(total)}</strong></p>
    <p style="margin: 0 0 24px 0;">
      <a href="${escapeHtml(ctx.viewUrl)}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">${escapeHtml(buttonLabel)}</a>
    </p>
    <p style="margin: 0; color: #6b7280; font-size: 13px;">${escapeHtml(ctx.businessName)}</p>
  </body>
</html>`.trim();

  return { subject, text, html };
}

export function renderInvoiceSms(ctx: InvoiceMessageContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  const lines = [
    tn('sms.invoice.ready', lang, { name: ctx.customerName, business: ctx.businessName }),
    tn('sms.invoice.amount', lang, {
      number: ctx.invoiceNumber,
      total: formatMoney(ctx.totalCents),
    }),
    ctx.dueDateIso ? tn('sms.invoice.due', lang, { date: ctx.dueDateIso.slice(0, 10) }) : null,
    tn('sms.invoice.cta', lang, { url: ctx.viewUrl }),
  ].filter((line): line is string => line !== null);
  if (ctx.customMessage && ctx.customMessage.trim().length > 0) {
    lines.splice(2, 0, ctx.customMessage.trim());
  }
  return { body: lines.join('\n') };
}

export function renderInvoiceEmail(ctx: InvoiceMessageContext): RenderedEmail {
  const lang = ctx.language ?? 'en';
  const subject = tn('email.invoice.subject', lang, {
    number: ctx.invoiceNumber,
    business: ctx.businessName,
  });
  const heading = tn('email.invoice.heading', lang, { number: ctx.invoiceNumber });
  const intro = tn('email.common.intro', lang, { name: ctx.customerName });
  const body = tn('email.invoice.body', lang, { business: ctx.businessName });
  const total = tn('email.invoice.total', lang, { total: formatMoney(ctx.totalCents) });
  const numberLine = tn('email.invoice.number', lang, { number: ctx.invoiceNumber });
  const due = ctx.dueDateIso ? tn('email.invoice.due', lang, { date: ctx.dueDateIso.slice(0, 10) }) : '';
  const ctaText = tn('email.invoice.cta_text', lang, { url: ctx.viewUrl });
  const buttonLabel = tn('email.invoice.button', lang);
  const signature = tn('email.common.signature', lang, { business: ctx.businessName });
  const note = ctx.customMessage?.trim();

  const text = [
    intro,
    '',
    body,
    '',
    numberLine,
    total,
    due,
    '',
    note ? `${note}\n` : '',
    ctaText,
    '',
    signature,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937;">
    <h2 style="margin: 0 0 16px 0; font-size: 20px;">${escapeHtml(heading)}</h2>
    <p style="margin: 0 0 12px 0;">${escapeHtml(intro)}</p>
    <p style="margin: 0 0 16px 0;">${escapeHtml(body)}</p>
    ${note ? `<p style="margin: 0 0 16px 0; padding: 12px; background: #f3f4f6; border-radius: 6px;">${escapeHtml(note)}</p>` : ''}
    <p style="margin: 0 0 4px 0; font-size: 18px;"><strong>${escapeHtml(total)}</strong></p>
    ${due ? `<p style="margin: 0 0 24px 0; color: #6b7280;">${escapeHtml(due)}</p>` : ''}
    <p style="margin: 0 0 24px 0;">
      <a href="${escapeHtml(ctx.viewUrl)}" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">${escapeHtml(buttonLabel)}</a>
    </p>
    <p style="margin: 0; color: #6b7280; font-size: 13px;">${escapeHtml(ctx.businessName)}</p>
  </body>
</html>`.trim();

  return { subject, text, html };
}

export interface AppointmentNoticeContext {
  customerName: string;
  businessName: string;
  dateTimeStr: string;
  language?: Language;
}

export function renderAppointmentConfirmationSms(ctx: AppointmentNoticeContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  return {
    body: [
      tn('sms.appointment.confirm.line1', lang, { name: ctx.customerName, business: ctx.businessName }),
      tn('sms.appointment.confirm.line2', lang, { when: ctx.dateTimeStr }),
    ].join('\n'),
  };
}

export function renderAppointmentRescheduleSms(
  ctx: AppointmentNoticeContext,
): RenderedSms {
  const lang = ctx.language ?? 'en';
  return {
    body: [
      tn('sms.appointment.reschedule.line1', lang, { name: ctx.customerName, business: ctx.businessName }),
      tn('sms.appointment.reschedule.line2', lang, { when: ctx.dateTimeStr }),
    ].join('\n'),
  };
}

export function renderAppointmentCancelSms(ctx: AppointmentNoticeContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  return {
    body: [
      tn('sms.appointment.cancel.line1', lang, { name: ctx.customerName, business: ctx.businessName }),
      tn('sms.appointment.cancel.line2', lang, { when: ctx.dateTimeStr }),
    ].join('\n'),
  };
}

export function renderAppointmentReminderSms(ctx: AppointmentNoticeContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  return {
    body: [
      tn('sms.appointment.reminder.line1', lang, { business: ctx.businessName }),
      tn('sms.appointment.reminder.line2', lang, { when: ctx.dateTimeStr }),
    ].join('\n'),
  };
}

export interface PaymentReceiptContext {
  customerName: string;
  businessName: string;
  invoiceNumber: string;
  amountCents: number;
  language?: Language;
}

export function renderPaymentReceiptSms(ctx: PaymentReceiptContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  return {
    body: [
      tn('sms.payment_receipt.line1', lang, { name: ctx.customerName, business: ctx.businessName }),
      tn('sms.payment_receipt.line2', lang, {
        number: ctx.invoiceNumber,
        amount: formatMoney(ctx.amountCents),
      }),
    ].join('\n'),
  };
}

export interface InvoiceOverdueContext {
  customerName: string;
  businessName: string;
  invoiceNumber: string;
  amountDueCents: number;
  dueDateIso?: string;
  language?: Language;
}

export function renderInvoiceOverdueSms(ctx: InvoiceOverdueContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  const due = ctx.dueDateIso ? tn('sms.invoice_overdue.due_suffix', lang, { date: ctx.dueDateIso.slice(0, 10) }) : '';
  return {
    body: [
      tn('sms.invoice_overdue.line1', lang, { name: ctx.customerName, business: ctx.businessName }),
      tn('sms.invoice_overdue.line2', lang, {
        number: ctx.invoiceNumber,
        amount: formatMoney(ctx.amountDueCents),
        due,
      }),
      tn('sms.invoice_overdue.line3', lang),
    ].join('\n'),
  };
}
