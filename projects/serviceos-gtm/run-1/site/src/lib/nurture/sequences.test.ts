import { describe, it, expect } from 'vitest';
import {
  NURTURE_SEQUENCES,
  TRIAL_DRIP_SEQUENCE,
  WIN_BACK_EMAIL,
  PAYMENT_FAILED_EMAIL,
  KNOWN_MERGE_FIELDS,
  renderMergeFields,
  getEmailById,
} from './sequences';

describe('nurture sequences catalog', () => {
  it('has exactly 8 emails', () => {
    expect(NURTURE_SEQUENCES).toHaveLength(8);
  });

  it('has the 6-email trial_started drip in order 1-6', () => {
    expect(TRIAL_DRIP_SEQUENCE.map((e) => e.id)).toEqual([
      'welcome',
      'activation-nudge',
      'mid-trial-value',
      'honesty',
      'trial-ending',
      'convert-last-day',
    ]);
    expect(TRIAL_DRIP_SEQUENCE.map((e) => e.delayDays)).toEqual([0, 1, 5, 8, 11, 13]);
  });

  it('win-back anchors on canceled_or_trial_expired at +7d', () => {
    expect(WIN_BACK_EMAIL.trigger).toBe('canceled_or_trial_expired');
    expect(WIN_BACK_EMAIL.delayDays).toBe(7);
  });

  it('payment-failed is immediate and transactional', () => {
    expect(PAYMENT_FAILED_EMAIL.trigger).toBe('payment_failed');
    expect(PAYMENT_FAILED_EMAIL.delayDays).toBe(0);
    expect(PAYMENT_FAILED_EMAIL.transactional).toBe(true);
  });

  it('welcome is transactional; marketing drip emails are not', () => {
    expect(getEmailById('welcome')?.transactional).toBe(true);
    expect(getEmailById('activation-nudge')?.transactional).toBe(false);
    expect(getEmailById('trial-ending')?.transactional).toBe(false);
  });

  it('renders every email body to non-empty HTML containing the expected tags', () => {
    for (const email of NURTURE_SEQUENCES) {
      expect(email.bodyHtml).toContain('<p>');
      expect(email.bodyHtml).toMatch(/<a href="\{\{\w+\}\}">/);
      expect(email.bodyText.length).toBeGreaterThan(0);
    }
  });

  it('welcome body has the 4-step onboarding ordered list', () => {
    const welcome = getEmailById('welcome')!;
    expect(welcome.bodyHtml).toContain('<ol>');
    expect(welcome.bodyHtml).toMatch(/<li>Business setup/);
    expect(welcome.bodyHtml).toMatch(/<li>Phone number/);
  });

  it('trial-ending body has the 3-plan unordered list', () => {
    const trialEnding = getEmailById('trial-ending')!;
    expect(trialEnding.bodyHtml).toContain('<ul>');
    expect(trialEnding.bodyHtml).toMatch(/<li>Solo/);
    expect(trialEnding.bodyHtml).toMatch(/<li>Pro/);
  });
});

describe('merge-field rendering', () => {
  it('lists the merge fields used across the sequences', () => {
    expect(KNOWN_MERGE_FIELDS).toEqual(
      expect.arrayContaining([
        'first_name',
        'onboarding_url',
        'app_url',
        'restart_url',
        'fix_payment_url',
        'calls_answered',
        'bookings_approved',
        'estimates_drafted',
        'invoices_sent',
      ]),
    );
  });

  it('substitutes known merge fields', () => {
    const result = renderMergeFields('Hey {{first_name}}, go to {{app_url}}', {
      first_name: 'Mike',
      app_url: 'https://app.example.com',
    });
    expect(result).toBe('Hey Mike, go to https://app.example.com');
  });

  it('leaves unknown/missing placeholders untouched rather than blanking them', () => {
    const result = renderMergeFields('Hi {{first_name}}, {{not_a_real_field}}', {});
    expect(result).toBe('Hi {{first_name}}, {{not_a_real_field}}');
  });

  it('renders the convert-last-day trial-summary merge fields end to end', () => {
    const email = getEmailById('convert-last-day')!;
    const rendered = renderMergeFields(email.bodyHtml, {
      first_name: 'Jenna',
      app_url: 'https://app.example.com',
      calls_answered: '42',
      bookings_approved: '19',
      estimates_drafted: '11',
      invoices_sent: '9',
    });
    expect(rendered).toContain('Calls answered: 42');
    expect(rendered).toContain('Bookings you approved: 19');
    expect(rendered).toContain('Estimates drafted: 11');
    expect(rendered).toContain('Invoices sent: 9');
    expect(rendered).not.toContain('{{');
  });
});
