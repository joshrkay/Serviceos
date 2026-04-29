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
 */

export interface EstimateMessageContext {
  customerName: string;
  estimateNumber: string;
  totalCents: number;
  businessName: string;
  viewUrl: string;
  customMessage?: string;
}

export interface InvoiceMessageContext {
  customerName: string;
  invoiceNumber: string;
  totalCents: number;
  businessName: string;
  viewUrl: string;
  dueDateIso?: string;
  customMessage?: string;
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
  const lines = [
    `Hi ${ctx.customerName} — your estimate from ${ctx.businessName} is ready.`,
    `Estimate ${ctx.estimateNumber}: ${formatMoney(ctx.totalCents)}`,
    `Review and approve: ${ctx.viewUrl}`,
  ];
  if (ctx.customMessage && ctx.customMessage.trim().length > 0) {
    lines.splice(2, 0, ctx.customMessage.trim());
  }
  return { body: lines.join('\n') };
}

export function renderEstimateEmail(ctx: EstimateMessageContext): RenderedEmail {
  const subject = `Estimate ${ctx.estimateNumber} from ${ctx.businessName}`;
  const intro = `Hi ${ctx.customerName},`;
  const body = `Your estimate from ${ctx.businessName} is ready for review.`;
  const total = `Total: ${formatMoney(ctx.totalCents)}`;
  const note = ctx.customMessage?.trim();

  const text = [
    intro,
    '',
    body,
    '',
    `Estimate number: ${ctx.estimateNumber}`,
    total,
    '',
    note ? `${note}\n` : '',
    `Review and approve here: ${ctx.viewUrl}`,
    '',
    `— ${ctx.businessName}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937;">
    <h2 style="margin: 0 0 16px 0; font-size: 20px;">Estimate ${escapeHtml(ctx.estimateNumber)}</h2>
    <p style="margin: 0 0 12px 0;">${escapeHtml(intro)}</p>
    <p style="margin: 0 0 16px 0;">${escapeHtml(body)}</p>
    ${note ? `<p style="margin: 0 0 16px 0; padding: 12px; background: #f3f4f6; border-radius: 6px;">${escapeHtml(note)}</p>` : ''}
    <p style="margin: 0 0 24px 0; font-size: 18px;"><strong>${escapeHtml(total)}</strong></p>
    <p style="margin: 0 0 24px 0;">
      <a href="${escapeHtml(ctx.viewUrl)}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">Review &amp; Approve Estimate</a>
    </p>
    <p style="margin: 0; color: #6b7280; font-size: 13px;">${escapeHtml(ctx.businessName)}</p>
  </body>
</html>`.trim();

  return { subject, text, html };
}

export function renderInvoiceSms(ctx: InvoiceMessageContext): RenderedSms {
  const lines = [
    `Hi ${ctx.customerName} — your invoice from ${ctx.businessName} is ready.`,
    `Invoice ${ctx.invoiceNumber}: ${formatMoney(ctx.totalCents)}`,
    ctx.dueDateIso ? `Due ${ctx.dueDateIso.slice(0, 10)}` : null,
    `Pay online: ${ctx.viewUrl}`,
  ].filter((line): line is string => line !== null);
  if (ctx.customMessage && ctx.customMessage.trim().length > 0) {
    lines.splice(2, 0, ctx.customMessage.trim());
  }
  return { body: lines.join('\n') };
}

export function renderInvoiceEmail(ctx: InvoiceMessageContext): RenderedEmail {
  const subject = `Invoice ${ctx.invoiceNumber} from ${ctx.businessName}`;
  const intro = `Hi ${ctx.customerName},`;
  const body = `Your invoice from ${ctx.businessName} is ready.`;
  const total = `Amount due: ${formatMoney(ctx.totalCents)}`;
  const due = ctx.dueDateIso ? `Due by ${ctx.dueDateIso.slice(0, 10)}` : '';
  const note = ctx.customMessage?.trim();

  const text = [
    intro,
    '',
    body,
    '',
    `Invoice number: ${ctx.invoiceNumber}`,
    total,
    due,
    '',
    note ? `${note}\n` : '',
    `Pay online here: ${ctx.viewUrl}`,
    '',
    `— ${ctx.businessName}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937;">
    <h2 style="margin: 0 0 16px 0; font-size: 20px;">Invoice ${escapeHtml(ctx.invoiceNumber)}</h2>
    <p style="margin: 0 0 12px 0;">${escapeHtml(intro)}</p>
    <p style="margin: 0 0 16px 0;">${escapeHtml(body)}</p>
    ${note ? `<p style="margin: 0 0 16px 0; padding: 12px; background: #f3f4f6; border-radius: 6px;">${escapeHtml(note)}</p>` : ''}
    <p style="margin: 0 0 4px 0; font-size: 18px;"><strong>${escapeHtml(total)}</strong></p>
    ${due ? `<p style="margin: 0 0 24px 0; color: #6b7280;">${escapeHtml(due)}</p>` : ''}
    <p style="margin: 0 0 24px 0;">
      <a href="${escapeHtml(ctx.viewUrl)}" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">Pay Invoice Online</a>
    </p>
    <p style="margin: 0; color: #6b7280; font-size: 13px;">${escapeHtml(ctx.businessName)}</p>
  </body>
</html>`.trim();

  return { subject, text, html };
}
