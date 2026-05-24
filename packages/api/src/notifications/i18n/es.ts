/**
 * P11-002 — Spanish notifications catalog. Must define every key in the
 * EN catalog (compile-time enforced via `Record<keyof EnglishNotifications,
 * string>`).
 */
import type { EnglishNotifications } from './en';

export const es: Record<keyof EnglishNotifications, string> = {
  // ── Estimate SMS ─────────────────────────────────────────────────────
  'sms.estimate.ready': 'Hola {{name}} — su presupuesto de {{business}} está listo.',
  'sms.estimate.amount': 'Presupuesto {{number}}: {{total}}',
  'sms.estimate.cta': 'Revise y apruebe: {{url}}',

  // ── Invoice SMS ──────────────────────────────────────────────────────
  'sms.invoice.ready': 'Hola {{name}} — su factura de {{business}} está lista.',
  'sms.invoice.amount': 'Factura {{number}}: {{total}}',
  'sms.invoice.due': 'Vence {{date}}',
  'sms.invoice.cta': 'Pague en línea: {{url}}',

  // ── Appointment SMS ──────────────────────────────────────────────────
  'sms.appointment.confirm.line1':
    'Hola {{name}}, su cita con {{business}} está confirmada.',
  'sms.appointment.confirm.line2': 'Fecha y hora: {{when}}',
  'sms.appointment.reschedule.line1':
    'Hola {{name}}, su cita con {{business}} ha sido reprogramada.',
  'sms.appointment.reschedule.line2': 'Nueva fecha y hora: {{when}}',
  'sms.appointment.cancel.line1':
    'Hola {{name}}, su cita con {{business}} ha sido cancelada.',
  'sms.appointment.cancel.line2': 'Programada anteriormente: {{when}}',
  'sms.appointment.reminder.line1':
    'Recordatorio: tiene una cita con {{business}} mañana.',
  'sms.appointment.reminder.line2': 'Fecha y hora: {{when}}',

  // ── Payment receipt SMS ──────────────────────────────────────────────
  'sms.payment_receipt.line1':
    'Hola {{name}}, hemos recibido su pago a {{business}}.',
  'sms.payment_receipt.line2': 'Factura {{number}}: {{amount}}. ¡Gracias!',

  // ── Invoice overdue SMS ──────────────────────────────────────────────
  'sms.invoice_overdue.line1':
    'Hola {{name}}, su factura de {{business}} está vencida.',
  'sms.invoice_overdue.line2': 'Factura {{number}}: {{amount}}{{due}}.',
  'sms.invoice_overdue.line3': 'Por favor pague a la brevedad posible.',
  'sms.invoice_overdue.due_suffix': ' (vence {{date}})',

  // ── Feedback request SMS ─────────────────────────────────────────────
  'sms.feedback.request':
    'Gracias por elegir a {{business}}. Nos encantaría conocer su opinión: {{url}}',

  // ── Shared email fragments ───────────────────────────────────────────
  'email.common.intro': 'Hola {{name}}:',
  'email.common.signature': '— {{business}}',

  // ── Estimate email ───────────────────────────────────────────────────
  'email.estimate.subject': 'Presupuesto {{number}} de {{business}}',
  'email.estimate.heading': 'Presupuesto {{number}}',
  'email.estimate.body': 'Su presupuesto de {{business}} está listo para revisión.',
  'email.estimate.total': 'Total: {{total}}',
  'email.estimate.number': 'Número de presupuesto: {{number}}',
  'email.estimate.cta_text': 'Revise y apruebe aquí: {{url}}',
  'email.estimate.button': 'Revisar y aprobar presupuesto',

  // ── Invoice email ────────────────────────────────────────────────────
  'email.invoice.subject': 'Factura {{number}} de {{business}}',
  'email.invoice.heading': 'Factura {{number}}',
  'email.invoice.body': 'Su factura de {{business}} está lista.',
  'email.invoice.total': 'Monto adeudado: {{total}}',
  'email.invoice.due': 'Vence el {{date}}',
  'email.invoice.number': 'Número de factura: {{number}}',
  'email.invoice.cta_text': 'Pague en línea aquí: {{url}}',
  'email.invoice.button': 'Pagar factura en línea',

  // ── Transactional email subjects ─────────────────────────────────────
  'email.payment_receipt.subject': 'Pago recibido — {{business}}',
  'email.invoice_overdue.subject': 'Factura vencida — {{business}}',
  'email.appointment.subject': '{{business}} — actualización de cita',
};
