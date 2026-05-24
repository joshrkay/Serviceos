/**
 * P11-002 — English notifications catalog (SMS + email copy). Source of
 * truth for the notifications `TranslationKey` union; every key here MUST
 * also exist in `es.ts` (enforced by `Record<keyof EnglishNotifications,
 * string>` + the completeness test).
 *
 * Money/number values are pre-formatted by the caller and passed as
 * `{{total}}` / `{{amount}}` vars — never format inside the catalog.
 */
export const en = {
  // ── Estimate SMS ─────────────────────────────────────────────────────
  'sms.estimate.ready': 'Hi {{name}} — your estimate from {{business}} is ready.',
  'sms.estimate.amount': 'Estimate {{number}}: {{total}}',
  'sms.estimate.cta': 'Review and approve: {{url}}',

  // ── Invoice SMS ──────────────────────────────────────────────────────
  'sms.invoice.ready': 'Hi {{name}} — your invoice from {{business}} is ready.',
  'sms.invoice.amount': 'Invoice {{number}}: {{total}}',
  'sms.invoice.due': 'Due {{date}}',
  'sms.invoice.cta': 'Pay online: {{url}}',

  // ── Appointment SMS ──────────────────────────────────────────────────
  'sms.appointment.confirm.line1':
    'Hi {{name}}, your appointment with {{business}} is confirmed.',
  'sms.appointment.confirm.line2': 'Date & time: {{when}}',
  'sms.appointment.reschedule.line1':
    'Hi {{name}}, your appointment with {{business}} has been rescheduled.',
  'sms.appointment.reschedule.line2': 'New date & time: {{when}}',
  'sms.appointment.cancel.line1':
    'Hi {{name}}, your appointment with {{business}} has been canceled.',
  'sms.appointment.cancel.line2': 'Previously scheduled: {{when}}',
  'sms.appointment.reminder.line1':
    'Reminder: you have an appointment with {{business}} tomorrow.',
  'sms.appointment.reminder.line2': 'Date & time: {{when}}',

  // ── Payment receipt SMS ──────────────────────────────────────────────
  'sms.payment_receipt.line1':
    'Hi {{name}}, we received your payment to {{business}}.',
  'sms.payment_receipt.line2': 'Invoice {{number}}: {{amount}}. Thank you!',

  // ── Invoice overdue SMS ──────────────────────────────────────────────
  'sms.invoice_overdue.line1':
    'Hi {{name}}, your invoice from {{business}} is past due.',
  'sms.invoice_overdue.line2': 'Invoice {{number}}: {{amount}}{{due}}.',
  'sms.invoice_overdue.line3': 'Please pay at your earliest convenience.',
  'sms.invoice_overdue.due_suffix': ' (due {{date}})',

  // ── Feedback request SMS ─────────────────────────────────────────────
  'sms.feedback.request':
    "Thanks for choosing {{business}}. We'd love your feedback: {{url}}",

  // ── Shared email fragments ───────────────────────────────────────────
  'email.common.intro': 'Hi {{name}},',
  'email.common.signature': '— {{business}}',

  // ── Estimate email ───────────────────────────────────────────────────
  'email.estimate.subject': 'Estimate {{number}} from {{business}}',
  'email.estimate.heading': 'Estimate {{number}}',
  'email.estimate.body': 'Your estimate from {{business}} is ready for review.',
  'email.estimate.total': 'Total: {{total}}',
  'email.estimate.number': 'Estimate number: {{number}}',
  'email.estimate.cta_text': 'Review and approve here: {{url}}',
  'email.estimate.button': 'Review & Approve Estimate',

  // ── Invoice email ────────────────────────────────────────────────────
  'email.invoice.subject': 'Invoice {{number}} from {{business}}',
  'email.invoice.heading': 'Invoice {{number}}',
  'email.invoice.body': 'Your invoice from {{business}} is ready.',
  'email.invoice.total': 'Amount due: {{total}}',
  'email.invoice.due': 'Due by {{date}}',
  'email.invoice.number': 'Invoice number: {{number}}',
  'email.invoice.cta_text': 'Pay online here: {{url}}',
  'email.invoice.button': 'Pay Invoice Online',
} as const;

export type EnglishNotifications = typeof en;
