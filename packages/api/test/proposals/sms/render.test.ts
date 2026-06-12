/**
 * P2-034 — proposal → SMS rendering.
 *
 * Every proposal type renders (the summary backbone makes the renderer
 * total), realistic inputs stay within the 320-char target, and the reply
 * instructions + one-tap link survive truncation of any summary length.
 */
import { describe, it, expect } from 'vitest';
import {
  renderProposalSms,
  PROPOSAL_SMS_MAX_CHARS,
} from '../../../src/proposals/sms/render';
import { VALID_PROPOSAL_TYPES } from '../../../src/proposals/proposal';

const URL = 'https://api.example.com/public/proposals/one-tap-approve?token=abc123';

describe('renderProposalSms', () => {
  it('renders every proposal type without throwing', () => {
    for (const proposalType of VALID_PROPOSAL_TYPES) {
      const body = renderProposalSms(
        { proposalType, summary: `Proposal of type ${proposalType}`, payload: {} },
        { approveUrl: URL },
      );
      expect(body).toContain('Reply Y to approve, N to reject, EDIT to change.');
      expect(body).toContain(URL);
    }
  });

  it('keeps the human-readable part within the 320-char target (link rides on top)', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_invoice',
        summary: 'Invoice for water heater replacement at 12 Oak St',
        payload: { customerName: 'Mrs Lee', totalCents: 184250 },
      },
      { approveUrl: URL },
    );
    const humanPart = body.slice(0, body.indexOf(' Or tap'));
    expect(humanPart.length).toBeLessThanOrEqual(PROPOSAL_SMS_MAX_CHARS);
    expect(body).toContain('Mrs Lee');
    expect(body).toContain('$1,842.50');
  });

  it('a realistic ~250-char signed URL never starves the summary', () => {
    const longUrl = `https://api.example.com/public/proposals/one-tap-approve?token=${'x'.repeat(250)}`;
    const summary = 'Appointment — Tuesday, June 16 at 2:00 PM for Mrs Lee';
    const body = renderProposalSms(
      { proposalType: 'create_appointment', summary, payload: {} },
      { approveUrl: longUrl },
    );
    expect(body).toContain(summary);
    expect(body).toContain(longUrl);
  });

  it('never truncates the instructions or link — the summary gives way', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'A'.repeat(600),
        payload: {},
      },
      { approveUrl: URL },
    );
    expect(body).toContain('Reply Y to approve');
    expect(body).toContain(URL);
    expect(body).toContain('…');
  });

  it('sums catalog-priced line items when no headline total exists', () => {
    const body = renderProposalSms({
      proposalType: 'draft_invoice',
      summary: 'Invoice draft',
      payload: {
        lineItems: [
          { description: 'Capacitor', unitPriceCents: 22500, quantity: 1 },
          { description: 'Labor', unitPriceCents: 15000, quantity: 2 },
        ],
      },
    });
    expect(body).toContain('$525.00');
  });

  it('skips money when line items carry non-integer prices (never derives floats)', () => {
    const body = renderProposalSms({
      proposalType: 'draft_invoice',
      summary: 'Invoice draft',
      payload: { lineItems: [{ description: 'X', unitPriceCents: 22.5 }] },
    });
    expect(body).not.toContain('$');
  });

  it('does not repeat facts already present in the summary', () => {
    const body = renderProposalSms({
      proposalType: 'draft_invoice',
      summary: 'Invoice Mrs Lee $225.00 for capacitor swap',
      payload: { customerName: 'Mrs Lee', totalCents: 22500 },
    });
    expect(body.match(/Mrs Lee/g)).toHaveLength(1);
    expect(body.match(/\$225\.00/g)).toHaveLength(1);
  });

  it('prefixes re-approval renders', () => {
    const body = renderProposalSms(
      { proposalType: 'draft_invoice', summary: 'Invoice Mrs Lee', payload: {} },
      { reapproval: true },
    );
    expect(body.startsWith('Updated: ')).toBe(true);
  });

  it('omits the link line when no URL is supplied', () => {
    const body = renderProposalSms({
      proposalType: 'add_note',
      summary: 'Add note to job',
      payload: {},
    });
    expect(body).not.toContain('Or tap');
    expect(body).toContain('Reply Y to approve');
  });
});
