/**
 * P2-034 — proposal → SMS rendering.
 *
 * Every proposal type renders (the summary backbone makes the renderer
 * total), realistic inputs stay within the 320-char target, and the reply
 * instructions + one-tap link survive truncation of any summary length.
 *
 * RV-074 (F-4) — three-tier confidence rendering tests:
 *   HIGH / absent → byte-identical to today's output.
 *   MEDIUM → (?) on medium-or-lower fieldConfidence facts; trailing Check: line.
 *   LOW / VERY_LOW → no Reply Y, no approve URL, "needs review in app" form.
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

// ─────────────────────────────────────────────────────────────────────────────
// RV-074 (F-4) — three-tier confidence rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('renderProposalSms — RV-074 confidence markers', () => {
  // Reference inputs used across tests (estimate + appointment, two types).
  const estimatePayloadBase = {
    customerName: 'Jane Doe',
    totalCents: 87500,
  };
  const appointmentPayloadBase = {
    customerName: 'Bob Smith',
    jobId: 'abc-123',
  };

  // ── absent _meta — byte-identical regression ──────────────────────────────

  it('absent _meta: estimate output is byte-identical to no-meta call', () => {
    const withoutMeta = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: { ...estimatePayloadBase },
      },
      { approveUrl: URL },
    );
    const withHighMeta = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: { ...estimatePayloadBase },
      },
      { approveUrl: URL },
    );
    expect(withoutMeta).toBe(withHighMeta);
  });

  it('absent _meta: appointment output is byte-identical to no-meta call', () => {
    const withoutMeta = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'Book 2pm Tuesday for Bob Smith',
        payload: { ...appointmentPayloadBase },
      },
      { approveUrl: URL },
    );
    const withHighMeta = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'Book 2pm Tuesday for Bob Smith',
        payload: { ...appointmentPayloadBase },
      },
      { approveUrl: URL },
    );
    expect(withoutMeta).toBe(withHighMeta);
  });

  // ── HIGH confidence — byte-identical to no-meta ───────────────────────────

  it('high confidence (estimate): output is byte-identical to absent-_meta', () => {
    const noMeta = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: { ...estimatePayloadBase },
      },
      { approveUrl: URL },
    );
    const highMeta = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: { overallConfidence: 'high' },
        },
      },
      { approveUrl: URL },
    );
    expect(highMeta).toBe(noMeta);
  });

  it('high confidence (appointment): output is byte-identical to absent-_meta', () => {
    const noMeta = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'Book 2pm Tuesday for Bob Smith',
        payload: { ...appointmentPayloadBase },
      },
      { approveUrl: URL },
    );
    const highMeta = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'Book 2pm Tuesday for Bob Smith',
        payload: {
          ...appointmentPayloadBase,
          _meta: { overallConfidence: 'high' },
        },
      },
      { approveUrl: URL },
    );
    expect(highMeta).toBe(noMeta);
  });

  // ── MEDIUM confidence — (?) markers + Check: line ────────────────────────

  it('medium confidence (estimate): money fact gets (?) when totalCents fieldConfidence is medium', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: {
            overallConfidence: 'medium',
            fieldConfidence: { totalCents: 'medium' },
          },
        },
      },
      { approveUrl: URL },
    );
    expect(body).toContain('$875.00(?)');
    expect(body).toContain('Reply Y to approve');
    expect(body).toContain(URL);
  });

  it('medium confidence (estimate): customer name gets (?) when customerName fieldConfidence is low', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: {
            overallConfidence: 'medium',
            fieldConfidence: { customerName: 'low' },
          },
        },
      },
      { approveUrl: URL },
    );
    expect(body).toContain('Jane Doe(?)');
    expect(body).toContain('Reply Y to approve');
    expect(body).toContain(URL);
  });

  it('medium confidence (estimate): trailing Check: line when marker exists', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: {
            overallConfidence: 'medium',
            fieldConfidence: { totalCents: 'medium' },
            markers: [
              { path: 'totalCents', reason: 'Price not found in catalog' },
              { path: 'customerName', reason: 'Second marker ignored in SMS' },
            ],
          },
        },
      },
      { approveUrl: URL },
    );
    expect(body).toContain('Check: Price not found in catalog');
    // Only the first marker reason appears (SMS brevity)
    expect(body).not.toContain('Second marker ignored in SMS');
    expect(body).toContain('Reply Y to approve');
    expect(body).toContain(URL);
  });

  it('medium confidence (appointment): no (?) when no fieldConfidence on rendered facts', () => {
    const body = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'Book 2pm Tuesday for Bob Smith',
        payload: {
          ...appointmentPayloadBase,
          _meta: {
            overallConfidence: 'medium',
            // fieldConfidence on a path that does not map to a rendered fact
            fieldConfidence: { technicianId: 'medium' },
            markers: [{ path: 'technicianId', reason: 'Technician assignment uncertain' }],
          },
        },
      },
      { approveUrl: URL },
    );
    // No (?) markers since the flagged path is not a rendered fact
    expect(body).not.toContain('(?)');
    // But the Check: line still appears (marker exists)
    expect(body).toContain('Check: Technician assignment uncertain');
    expect(body).toContain('Reply Y to approve');
    expect(body).toContain(URL);
  });

  it('medium confidence: no Check: line when no markers', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: {
            overallConfidence: 'medium',
            fieldConfidence: { totalCents: 'medium' },
            // No markers array
          },
        },
      },
      { approveUrl: URL },
    );
    expect(body).not.toContain('Check:');
    expect(body).toContain('$875.00(?)');
    expect(body).toContain('Reply Y to approve');
  });

  it('medium confidence: no (?) when all fieldConfidence entries are high', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: {
            overallConfidence: 'medium',
            fieldConfidence: { totalCents: 'high', customerName: 'high' },
          },
        },
      },
      { approveUrl: URL },
    );
    expect(body).not.toContain('(?)');
    expect(body).toContain('$875.00');
    expect(body).toContain('Jane Doe');
    expect(body).toContain('Reply Y to approve');
  });

  it('medium confidence: (?) on line item money fact when lineItem fieldConfidence is low', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for two items',
        payload: {
          lineItems: [
            { description: 'Part A', unitPriceCents: 10000, quantity: 1 },
            { description: 'Labor', unitPriceCents: 5000, quantity: 2 },
          ],
          _meta: {
            overallConfidence: 'medium',
            fieldConfidence: { 'lineItems[0].unitPriceCents': 'low' },
          },
        },
      },
      { approveUrl: URL },
    );
    // $200.00 = 100 + 50*2; flagged because a lineItem price has low confidence
    expect(body).toContain('$200.00(?)');
    expect(body).toContain('Reply Y to approve');
  });

  it('medium confidence: budget respected — total stays within PROPOSAL_SMS_MAX_CHARS (human part)', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for a very long description that goes on and on about the job details',
        payload: {
          ...estimatePayloadBase,
          _meta: {
            overallConfidence: 'medium',
            fieldConfidence: { totalCents: 'medium' },
            markers: [{ path: 'totalCents', reason: 'Catalog price not confirmed for this item type' }],
          },
        },
      },
      { approveUrl: URL },
    );
    const humanPart = body.includes(' Or tap') ? body.slice(0, body.indexOf(' Or tap')) : body;
    expect(humanPart.length).toBeLessThanOrEqual(PROPOSAL_SMS_MAX_CHARS);
    expect(body).toContain('Reply Y to approve');
  });

  // ── LOW confidence — no Y prompt, no one-tap link ────────────────────────

  it('low confidence (estimate): no Reply Y, no approveUrl, includes review-in-app instruction', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: { overallConfidence: 'low' },
        },
      },
      { approveUrl: URL },
    );
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain(URL);
    expect(body).toContain('Needs review in app');
    expect(body).toContain('Reply N to reject');
  });

  it('low confidence (appointment): no Reply Y, no approveUrl', () => {
    const body = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'Book 2pm Tuesday for Bob Smith',
        payload: {
          ...appointmentPayloadBase,
          _meta: { overallConfidence: 'low' },
        },
      },
      { approveUrl: URL },
    );
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain(URL);
    expect(body).toContain('Needs review in app');
    expect(body).toContain('Reply N to reject');
  });

  it('low confidence: stays within PROPOSAL_SMS_MAX_CHARS', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'A'.repeat(400),
        payload: {
          _meta: { overallConfidence: 'low' },
        },
      },
      { approveUrl: URL },
    );
    expect(body.length).toBeLessThanOrEqual(PROPOSAL_SMS_MAX_CHARS);
  });

  // ── VERY_LOW confidence — same as low ────────────────────────────────────

  it('very_low confidence (estimate): no Reply Y, no approveUrl, needs-review form', () => {
    const body = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: { overallConfidence: 'very_low' },
        },
      },
      { approveUrl: URL },
    );
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain(URL);
    expect(body).toContain('Needs review in app');
    expect(body).toContain('Reply N to reject');
  });

  it('very_low confidence (appointment): no Reply Y, no approveUrl', () => {
    const body = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'Book 2pm Tuesday for Bob Smith',
        payload: {
          ...appointmentPayloadBase,
          _meta: { overallConfidence: 'very_low' },
        },
      },
      { approveUrl: URL },
    );
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain(URL);
    expect(body).toContain('Needs review in app');
  });

  it('very_low confidence: stays within PROPOSAL_SMS_MAX_CHARS', () => {
    const body = renderProposalSms(
      {
        proposalType: 'create_appointment',
        summary: 'A'.repeat(400),
        payload: {
          _meta: { overallConfidence: 'very_low' },
        },
      },
      { approveUrl: URL },
    );
    expect(body.length).toBeLessThanOrEqual(PROPOSAL_SMS_MAX_CHARS);
  });

  // ── Predicate reuse — isBlockingConfidence alignment ────────────────────

  it('predicate alignment: only low and very_low suppress the approve affordance', () => {
    const approvableLevels = ['high', 'medium'] as const;
    const blockingLevels = ['low', 'very_low'] as const;

    for (const level of approvableLevels) {
      const body = renderProposalSms(
        {
          proposalType: 'draft_estimate',
          summary: 'Estimate',
          payload: { _meta: { overallConfidence: level } },
        },
        { approveUrl: URL },
      );
      expect(body, `level ${level} should include Reply Y`).toContain('Reply Y to approve');
      expect(body, `level ${level} should include approveUrl`).toContain(URL);
    }

    for (const level of blockingLevels) {
      const body = renderProposalSms(
        {
          proposalType: 'draft_estimate',
          summary: 'Estimate',
          payload: { _meta: { overallConfidence: level } },
        },
        { approveUrl: URL },
      );
      expect(body, `level ${level} should NOT include Reply Y`).not.toContain('Reply Y to approve');
      expect(body, `level ${level} should NOT include approveUrl`).not.toContain(URL);
    }
  });

  // ── Malformed _meta — tolerant ────────────────────────────────────────────

  it('malformed _meta (unknown level): treated as absent, normal output', () => {
    const noMeta = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: { ...estimatePayloadBase },
      },
      { approveUrl: URL },
    );
    const malformed = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: { overallConfidence: 'UNKNOWN_LEVEL' },
        },
      },
      { approveUrl: URL },
    );
    expect(malformed).toBe(noMeta);
  });

  it('_meta is null: treated as absent, normal output', () => {
    const noMeta = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: { ...estimatePayloadBase },
      },
      { approveUrl: URL },
    );
    const nullMeta = renderProposalSms(
      {
        proposalType: 'draft_estimate',
        summary: 'Estimate for furnace replacement',
        payload: {
          ...estimatePayloadBase,
          _meta: null,
        },
      },
      { approveUrl: URL },
    );
    expect(nullMeta).toBe(noMeta);
  });
});
