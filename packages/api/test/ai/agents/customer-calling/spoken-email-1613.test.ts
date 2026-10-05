/**
 * #1613 — email addresses captured by voice. Layer 2 run 37323734649
 * (update-customer-email-known-customer) read "ops@acme.com" back as
 * "oppeaceatacme.com" and "ope-s.acme.com": the recogniser's spelling of the
 * address went straight into the readback and the draft, and a caller
 * hearing an address spoken as one word cannot tell whether it was heard
 * right. Two pure helpers, shared by the readback and the update_customer
 * draft: `normalizeSpokenEmail` turns a spoken address ("ops at acme dot
 * com") into the address, and `spokenEmail` spells one out for the caller
 * ("o-p-s at acme dot com") so a mishearing is audible and correctable.
 *
 * Seam: the two exported functions (expected values written by hand).
 */
import { describe, it, expect } from 'vitest';

import { normalizeSpokenEmail, spokenEmail } from '../../../../src/ai/agents/customer-calling/spoken-email';

describe('#1613 — normalizeSpokenEmail', () => {
  it.each([
    ['ops at acme dot com', 'ops@acme.com'],
    ['OPS at Acme dot com.', 'ops@acme.com'],
    ['jane dot smith at example dot com', 'jane.smith@example.com'],
    ['ops underscore team at acme dash hvac dot com', 'ops_team@acme-hvac.com'],
    ['ops @ acme . com', 'ops@acme.com'],
    ['Ops@Acme.com', 'ops@acme.com'],
  ])('"%s" → "%s"', (spoken, address) => {
    expect(normalizeSpokenEmail(spoken)).toBe(address);
  });

  it('leaves a value that is not an address alone (trimmed), so a mishearing is read back as heard', () => {
    expect(normalizeSpokenEmail('  oppeaceatacme.com ')).toBe('oppeaceatacme.com');
    expect(normalizeSpokenEmail('the usual one')).toBe('the usual one');
  });

  it('never glues surrounding words into an address — a spoken address is word, symbol, word, …', () => {
    expect(normalizeSpokenEmail('the new one is ops at acme dot com')).toBe('the new one is ops at acme dot com');
    expect(normalizeSpokenEmail('jane dot smith at example dot com please')).toBe(
      'jane dot smith at example dot com please',
    );
  });

  it('understands the two-word Spanish underscore it spells with', () => {
    expect(normalizeSpokenEmail('ops guion bajo team arroba acme punto com')).toBe('ops_team@acme.com');
  });
});

describe('#1613 — spokenEmail spells the address for the caller', () => {
  it.each([
    ['ops@acme.com', 'en', 'o-p-s at acme dot com'],
    ['jane.smith@example.com', 'en', 'j-a-n-e dot s-m-i-t-h at example dot com'],
    ['ops_team2@acme-hvac.co.uk', 'en', 'o-p-s underscore t-e-a-m-2 at acme dash hvac dot co dot uk'],
    ['ops_team@acme.com', 'es', 'o-p-s guion bajo t-e-a-m arroba acme punto com'],
    ['ops@acme.com', 'es', 'o-p-s arroba acme punto com'],
  ] as const)('"%s" (%s) → "%s"', (address, lang, spelled) => {
    expect(spokenEmail(address, lang)).toBe(spelled);
  });

  it('passes a value that is not an address through unchanged', () => {
    expect(spokenEmail('oppeaceatacme.com', 'en')).toBe('oppeaceatacme.com');
  });
});
