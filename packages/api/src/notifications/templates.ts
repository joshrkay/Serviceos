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

export interface ThankYouMessageContext {
  businessName: string;
  language?: Language;
}

/**
 * Post-job thank-you SMS rendered by the thank-you-sms sweep worker
 * (~2hr after job.completed). Intentionally no URL / no ask — the
 * Google-review proposal at +24hr and the feedback-request link sent
 * via the feedback_send worker on completion carry the asks.
 */
export function renderThankYouSms(ctx: ThankYouMessageContext): RenderedSms {
  const lang = ctx.language ?? 'en';
  return {
    body: tn('sms.thank_you.line1', lang, { business: ctx.businessName }),
  };
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

// ── Onboarding lifecycle emails ────────────────────────────────────────
//
// These differ from the templates above in audience: they go to the SHOP
// OWNER (operator), not the end customer. The owner is the Rivet account
// holder and the product UI is English-only for the V1 ICP, so this copy is
// intentionally self-contained English rather than routed through the
// per-customer `tn()` catalog (which exists to resolve the *customer's*
// language). They share the same RenderedEmail shape, the inline-CSS HTML
// shell, and escapeHtml so a future i18n pass can swap them in uniformly.

/** Renders a primary CTA button + matching plain-text line. */
function renderCtaButton(url: string, label: string): { html: string; text: string } {
  return {
    html: `<p style="margin: 0 0 24px 0;"><a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 24px; background: #030213; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 500;">${escapeHtml(label)}</a></p>`,
    text: `${label}: ${url}`,
  };
}

/** Wraps body fragments in the shared Rivet email shell. `heading` is the H2. */
function renderEmailShell(heading: string, bodyHtml: string): string {
  return `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937;">
    <p style="margin: 0 0 20px 0; font-size: 18px; font-weight: 600; color: #030213;">Rivet</p>
    <h2 style="margin: 0 0 16px 0; font-size: 20px;">${escapeHtml(heading)}</h2>
    ${bodyHtml}
    <p style="margin: 24px 0 0 0; color: #6b7280; font-size: 13px;">You learned the trade. We&rsquo;ll run the business.</p>
  </body>
</html>`.trim();
}

export interface WelcomeEmailContext {
  /** Owner's business name when known; the welcome fires at signup before the
   * identity step, so this is usually absent — copy must read well without it. */
  businessName?: string;
  /** Absolute web origin, e.g. https://app.rivet.ai (no trailing slash). */
  appBaseUrl: string;
  /** Support address surfaced in the footer ask. */
  supportEmail: string;
}

export function renderWelcomeEmail(ctx: WelcomeEmailContext): RenderedEmail {
  const subject = 'Welcome to Rivet — let’s get your AI dispatcher live';
  const setupUrl = `${ctx.appBaseUrl}/onboarding`;
  const cta = renderCtaButton(setupUrl, 'Finish setup');
  const intro =
    'Welcome to Rivet. You’re a few minutes away from an AI dispatcher that ' +
    'answers your phone, books jobs, drafts quotes, and chases invoices — so ' +
    'you can stay on the tools.';
  const doesList = [
    'Answers every call in your shop’s voice and books the job',
    'Drafts quotes from the call and your price book',
    'Sends invoices and chases payment automatically',
    'Texts you one end-of-day digest — approve what matters in 30 seconds',
  ];
  const closing = 'Most owners are live in about 15 minutes. Pick up where you left off:';

  const text = [
    intro,
    '',
    'What Rivet does:',
    ...doesList.map((d) => `• ${d}`),
    '',
    closing,
    cta.text,
    '',
    `Questions? Just reply, or email ${ctx.supportEmail}.`,
  ].join('\n');

  const bodyHtml = [
    `<p style="margin: 0 0 16px 0;">${escapeHtml(intro)}</p>`,
    '<p style="margin: 0 0 8px 0; font-weight: 600;">What Rivet does</p>',
    `<ul style="margin: 0 0 16px 0; padding-left: 20px; color: #374151;">${doesList
      .map((d) => `<li style="margin: 0 0 6px 0;">${escapeHtml(d)}</li>`)
      .join('')}</ul>`,
    `<p style="margin: 0 0 20px 0;">${escapeHtml(closing)}</p>`,
    cta.html,
    `<p style="margin: 0; color: #6b7280; font-size: 13px;">Questions? Just reply, or email ${escapeHtml(
      ctx.supportEmail,
    )}.</p>`,
  ].join('\n    ');

  return { subject, text, html: renderEmailShell('Welcome to Rivet', bodyHtml) };
}

export interface SetupReminderEmailContext {
  businessName?: string;
  appBaseUrl: string;
  supportEmail: string;
  /** Human-readable labels of the steps still outstanding (e.g. "Forward your
   * phone line"). Drives the checklist; never empty when this email is sent. */
  remainingSteps: string[];
}

export function renderSetupReminderEmail(ctx: SetupReminderEmailContext): RenderedEmail {
  const subject = 'Finish setting up Rivet (you’re almost there)';
  const setupUrl = `${ctx.appBaseUrl}/onboarding`;
  const cta = renderCtaButton(setupUrl, 'Finish setup');
  const greetingName = ctx.businessName ? ` for ${ctx.businessName}` : '';
  const intro =
    `Your Rivet setup${greetingName} is almost done. A few steps are left before ` +
    'your AI can start answering calls and booking jobs:';
  const closing = 'It takes just a few more minutes:';

  const text = [
    intro,
    '',
    ...ctx.remainingSteps.map((s) => `• ${s}`),
    '',
    closing,
    cta.text,
    '',
    `Need a hand? Email ${ctx.supportEmail} and we’ll walk you through it.`,
  ].join('\n');

  const bodyHtml = [
    `<p style="margin: 0 0 16px 0;">${escapeHtml(intro)}</p>`,
    `<ul style="margin: 0 0 16px 0; padding-left: 20px; color: #374151;">${ctx.remainingSteps
      .map((s) => `<li style="margin: 0 0 6px 0;">${escapeHtml(s)}</li>`)
      .join('')}</ul>`,
    `<p style="margin: 0 0 20px 0;">${escapeHtml(closing)}</p>`,
    cta.html,
    `<p style="margin: 0; color: #6b7280; font-size: 13px;">Need a hand? Email ${escapeHtml(
      ctx.supportEmail,
    )} and we’ll walk you through it.</p>`,
  ].join('\n    ');

  return { subject, text, html: renderEmailShell('You’re almost set up', bodyHtml) };
}

export interface TrialEndingEmailContext {
  businessName?: string;
  appBaseUrl: string;
  supportEmail: string;
  /** Whole days remaining in the trial: 3, 1, or 0 (day-of). Drives the copy. */
  daysLeft: 0 | 1 | 3;
}

export function renderTrialEndingEmail(ctx: TrialEndingEmailContext): RenderedEmail {
  const billingUrl = `${ctx.appBaseUrl}/settings`;
  const cta = renderCtaButton(billingUrl, 'Review your plan');

  const when =
    ctx.daysLeft === 0 ? 'today' : ctx.daysLeft === 1 ? 'tomorrow' : `in ${ctx.daysLeft} days`;
  const subject =
    ctx.daysLeft === 0
      ? 'Your Rivet trial ends today'
      : `Your Rivet trial ends ${when}`;
  const heading = ctx.daysLeft === 0 ? 'Your trial ends today' : `Your trial ends ${when}`;
  const intro =
    `Your 14-day Rivet trial ends ${when}. To keep your AI dispatcher answering ` +
    'calls and chasing invoices without interruption, no action is needed — your ' +
    'plan ($297/month) starts automatically when the trial ends.';
  const reassure =
    'Not ready? You can cancel anytime before then and you won’t be charged. ' +
    'Either way, your data stays yours.';

  const text = [
    intro,
    '',
    reassure,
    '',
    cta.text,
    '',
    `Questions about billing? Email ${ctx.supportEmail}.`,
  ].join('\n');

  const bodyHtml = [
    `<p style="margin: 0 0 16px 0;">${escapeHtml(intro)}</p>`,
    `<p style="margin: 0 0 20px 0; color: #374151;">${escapeHtml(reassure)}</p>`,
    cta.html,
    `<p style="margin: 0; color: #6b7280; font-size: 13px;">Questions about billing? Email ${escapeHtml(
      ctx.supportEmail,
    )}.</p>`,
  ].join('\n    ');

  return { subject, text, html: renderEmailShell(heading, bodyHtml) };
}
