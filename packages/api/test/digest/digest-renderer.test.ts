/**
 * P5-020 — DigestRenderer unit tests.
 */
import { describe, it, expect } from 'vitest';
import { renderDigest, DIGEST_SMS_SPLIT_CHARS } from '../../src/digest/digest-renderer';
import type { DigestSection } from '../../src/digest/digest-types';

const SIGN_OFF = 'Acme Plumbing';

describe('DigestRenderer — renderDigest', () => {
  it('renders all 7 sections when all data present', () => {
    const sections: DigestSection[] = [
      { label: 'Jobs wrapped up today', lines: ['3 jobs completed.'] },
      { label: 'Estimates sent today', lines: ['2 estimates sent — $500 total.'] },
      { label: 'Invoices out for payment', lines: ['1 invoice sent — $300 outstanding.'] },
      { label: "Tomorrow's schedule", lines: ['2 visits on the calendar.'] },
      { label: "What I wasn't sure about", lines: ['1 proposal needs your review — confidence was low.'] },
      { label: 'What I learned today', lines: ['1 correction applied to my knowledge base.'] },
    ];

    const messages = renderDigest(sections, SIGN_OFF);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const combined = messages.join('\n');
    expect(combined).toContain('Jobs wrapped up today');
    expect(combined).toContain('Estimates sent today');
    expect(combined).toContain("What I wasn't sure about");
    expect(combined).toContain('What I learned today');
    expect(combined).toContain('Reply LOOKS GOOD or tell me what to fix.');
    expect(combined).toContain(SIGN_OFF);
  });

  it('omits section 5 when no uncertain proposals (sections array is pre-filtered)', () => {
    const sections: DigestSection[] = [
      { label: 'Jobs wrapped up today', lines: ['0 jobs completed.'] },
      { label: 'Estimates sent today', lines: ['No estimates sent today.'] },
      { label: 'Invoices out for payment', lines: ['No invoices sent today.'] },
      { label: "Tomorrow's schedule", lines: ['Nothing booked for tomorrow.'] },
      // Section 5 absent
      { label: 'What I learned today', lines: ['1 correction applied to my knowledge base.'] },
    ];

    const messages = renderDigest(sections, SIGN_OFF);
    const combined = messages.join('\n');
    expect(combined).not.toContain("What I wasn't sure about");
    expect(combined).toContain('What I learned today');
  });

  it('omits section 6 when no correction chunks (sections array is pre-filtered)', () => {
    const sections: DigestSection[] = [
      { label: 'Jobs wrapped up today', lines: ['1 job completed.'] },
      { label: 'Estimates sent today', lines: ['No estimates sent today.'] },
      { label: 'Invoices out for payment', lines: ['No invoices sent today.'] },
      { label: "Tomorrow's schedule", lines: ['Nothing booked for tomorrow.'] },
      { label: "What I wasn't sure about", lines: ['1 proposal needs your review.'] },
      // Section 6 absent
    ];

    const messages = renderDigest(sections, SIGN_OFF);
    const combined = messages.join('\n');
    expect(combined).not.toContain('What I learned today');
    expect(combined).toContain("What I wasn't sure about");
  });

  it('splits into 2 messages when rendered text exceeds 320 chars', () => {
    // Build sections that will definitely exceed 320 chars
    const sections: DigestSection[] = [
      {
        label: 'Jobs wrapped up today',
        lines: ['15 jobs completed across multiple crews, covering the entire metro area.'],
      },
      {
        label: 'Estimates sent today',
        lines: ['8 estimates sent — $12,500 total. Follow up with Johnson, Smith, and Williams.'],
      },
      {
        label: 'Invoices out for payment',
        lines: ['5 invoices sent — $8,000 outstanding. Three are past 14 days with no response.'],
      },
      {
        label: "Tomorrow's schedule",
        lines: ['12 visits on the calendar starting at 7am, spread across 4 zip codes.'],
      },
      {
        label: "What I wasn't sure about",
        lines: ['3 proposals need your review — confidence was low on pricing and scope.'],
      },
      {
        label: 'What I learned today',
        lines: ['2 corrections applied to my knowledge base regarding HVAC installation pricing.'],
      },
    ];

    const messages = renderDigest(sections, SIGN_OFF);
    // Should have at least 2 messages
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // Each individual message should not exceed the limit significantly
    for (const msg of messages) {
      expect(msg.length).toBeLessThanOrEqual(DIGEST_SMS_SPLIT_CHARS * 2); // tolerance for boundary section
    }
    // All sections should appear somewhere
    const combined = messages.join('\n');
    expect(combined).toContain('Jobs wrapped up today');
    expect(combined).toContain('What I learned today');
    expect(combined).toContain('Reply LOOKS GOOD or tell me what to fix.');
  });
});
