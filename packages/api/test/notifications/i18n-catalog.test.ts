import { describe, it, expect } from 'vitest';
import { en } from '../../src/notifications/i18n/en';
import { es } from '../../src/notifications/i18n/es';
import { tn } from '../../src/notifications/i18n';

describe('notifications i18n catalog', () => {
  it('ES defines every EN key (runtime completeness)', () => {
    const enKeys = Object.keys(en).sort();
    const esKeys = Object.keys(es).sort();
    expect(esKeys).toEqual(enKeys);
  });

  it('no ES value is left as the English source string', () => {
    // Keys whose copy is legitimately identical across languages
    // (cognates / pure-variable lines).
    const identicalByDesign = new Set<keyof typeof en>([
      'email.common.signature', // "— {{business}}"
      'email.estimate.total', // "Total: {{total}}" — "Total" is identical in es
    ]);
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      if (identicalByDesign.has(key)) continue;
      expect(es[key], `ES translation missing for ${key}`).not.toBe(en[key]);
    }
  });

  it('tn interpolates vars and localizes', () => {
    expect(tn('sms.feedback.request', 'en', { business: 'Acme', url: 'u' })).toBe(
      "Thanks for choosing Acme. We'd love your feedback: u",
    );
    expect(tn('sms.feedback.request', 'es', { business: 'Acme', url: 'u' })).toContain(
      'Gracias por elegir a Acme',
    );
  });

  it('localizes transactional email subjects (P11-002 review fix #3)', () => {
    expect(tn('email.payment_receipt.subject', 'en', { business: 'Acme' })).toBe(
      'Payment received — Acme',
    );
    expect(tn('email.payment_receipt.subject', 'es', { business: 'Acme' })).toBe(
      'Pago recibido — Acme',
    );
    expect(tn('email.invoice_overdue.subject', 'es', { business: 'Acme' })).toBe(
      'Factura vencida — Acme',
    );
    expect(tn('email.appointment.subject', 'es', { business: 'Acme' })).toBe(
      'Acme — actualización de cita',
    );
  });
});
