import { describe, it, expect } from 'vitest';
import { renderThankYouSms } from '../../src/notifications/templates';

describe('renderThankYouSms', () => {
  it('renders the English thank-you body without any URL or money', () => {
    const { body } = renderThankYouSms({ businessName: "Acme Plumbing" });
    expect(body).toContain('Acme Plumbing');
    // PRD §7.2: this beat is gratitude only — the asks live in the
    // feedback_send (immediate, with a link) and Google-review (24hr)
    // workers. A URL or money in this template would muddy the signal.
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/\$\d/);
  });

  it('renders Spanish when language is "es"', () => {
    const { body } = renderThankYouSms({ businessName: 'Plomería Acme', language: 'es' });
    expect(body).toContain('Plomería Acme');
    expect(body.toLowerCase()).toContain('gracias');
  });

  it('defaults language to English when omitted', () => {
    const { body } = renderThankYouSms({ businessName: 'Acme' });
    expect(body.toLowerCase()).toContain('thanks');
  });
});
