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
import { VALID_PROPOSAL_TYPES, actionClassForProposalType } from '../../../src/proposals/proposal';

const URL = 'https://api.example.com/public/proposals/one-tap-approve?token=abc123';

describe('renderProposalSms', () => {
  it('renders every proposal type without throwing', () => {
    for (const proposalType of VALID_PROPOSAL_TYPES) {
      const body = renderProposalSms(
        { proposalType, summary: `Proposal of type ${proposalType}`, payload: {} },
        { approveUrl: URL },
      );
      if (actionClassForProposalType(proposalType) === 'capture') {
        expect(body, `${proposalType} should use Y instructions`).toContain(
          'Reply Y to approve, N to reject, EDIT to change.',
        );
      } else {
        expect(body, `${proposalType} should use link instructions`).toContain(
          'Tap the link to approve, reply N to reject, or EDIT to change.',
        );
        expect(body, `${proposalType} should NOT contain Reply Y`).not.toContain('Reply Y');
      }
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

  it('non-capture (money/comms/irreversible) proposals get link-based instructions, no Reply Y', () => {
    // record_payment = money, send_estimate = comms, cancel_appointment = irreversible
    for (const proposalType of ['record_payment', 'send_estimate', 'cancel_appointment'] as const) {
      const body = renderProposalSms(
        { proposalType, summary: `Pending ${proposalType}`, payload: {} },
        { approveUrl: URL },
      );
      expect(body, `${proposalType} should NOT contain Reply Y`).not.toContain('Reply Y');
      expect(body, `${proposalType} should contain Tap the link`).toContain(
        'Tap the link to approve, reply N to reject, or EDIT to change.',
      );
      expect(body, `${proposalType} should contain the approve URL`).toContain(URL);
    }
  });

  it('capture proposals still get Reply Y instructions', () => {
    // draft_estimate = capture, create_appointment = capture
    for (const proposalType of ['draft_estimate', 'create_appointment'] as const) {
      const body = renderProposalSms(
        { proposalType, summary: `Pending ${proposalType}`, payload: {} },
        { approveUrl: URL },
      );
      expect(body, `${proposalType} should contain Reply Y`).toContain(
        'Reply Y to approve, N to reject, EDIT to change.',
      );
    }
  });

  // ── Item 1 pin: non-capture WITHOUT approveUrl (reapproval path) gets the
  // in-app variant, not the tap-the-link copy that would reference a missing URL.
  it('non-capture WITHOUT approveUrl (reapproval / chain-head review) gets app-variant instructions', () => {
    for (const proposalType of ['record_payment', 'send_estimate', 'cancel_appointment'] as const) {
      const body = renderProposalSms(
        { proposalType, summary: `Pending ${proposalType}`, payload: {} },
        // No approveUrl — reapproval render or chain-head review form.
      );
      expect(body, `${proposalType} no-link: must NOT say "Tap the link"`).not.toContain('Tap the link');
      expect(body, `${proposalType} no-link: must say "Review and approve in the app"`).toContain(
        'Review and approve in the app',
      );
      expect(body, `${proposalType} no-link: must still offer N and EDIT`).toContain('reply N to reject');
      expect(body, `${proposalType} no-link: must NOT contain Reply Y`).not.toContain('Reply Y');
    }
  });

  it('non-capture WITH approveUrl keeps the tap-the-link instructions (existing behavior unchanged)', () => {
    for (const proposalType of ['record_payment', 'send_estimate', 'cancel_appointment'] as const) {
      const body = renderProposalSms(
        { proposalType, summary: `Pending ${proposalType}`, payload: {} },
        { approveUrl: URL },
      );
      expect(body, `${proposalType} with-link: must say "Tap the link"`).toContain(
        'Tap the link to approve, reply N to reject, or EDIT to change.',
      );
      expect(body, `${proposalType} with-link: must contain URL`).toContain(URL);
    }
  });

  it('capture WITHOUT approveUrl still gets the standard Reply-Y instructions (unchanged)', () => {
    for (const proposalType of ['draft_estimate', 'create_appointment'] as const) {
      const body = renderProposalSms(
        { proposalType, summary: `Pending ${proposalType}`, payload: {} },
        // No approveUrl.
      );
      expect(body, `${proposalType} capture no-link: still has Reply Y`).toContain(
        'Reply Y to approve, N to reject, EDIT to change.',
      );
    }
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

  // ── HIGH confidence — byte-identical to no-meta ───────────────────────────
  // (These also pin the absent-_meta form: each compares a no-meta call
  // against a HIGH-meta call, so a change to either side fails.)

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
    expect(body).toContain('reply N to reject');
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
    expect(body).toContain('reply N to reject');
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
    expect(body).toContain('reply N to reject');
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

// ─────────────────────────────────────────────────────────────────────────────
// RV-221 — chain summary rendering (one SMS per chain)
// ─────────────────────────────────────────────────────────────────────────────

import { renderChainSms, type ChainSmsMember } from '../../../src/proposals/sms/render';

function member(overrides: Partial<ChainSmsMember> = {}): ChainSmsMember {
  return {
    proposalType: 'create_customer',
    summary: 'Create customer Jane Doe',
    payload: {},
    ...overrides,
  };
}

describe('renderChainSms — RV-221 chain summaries', () => {
  it('renders a 2-member capture chain as one numbered summary with the truthful set-approval reply prompt', () => {
    const body = renderChainSms(
      [
        member(),
        member({
          proposalType: 'create_job',
          summary: 'Open a job for Jane Doe',
        }),
      ],
      { approveUrl: URL },
    );
    expect(body).toContain('2 linked actions:');
    expect(body).toContain('1) Create customer Jane Doe');
    expect(body).toContain('2) Open a job for Jane Doe');
    // Track E truthful copy: Y approves the capture-class setup steps together.
    expect(body).toContain('Reply Y to approve the setup steps; starred items follow separately.');
    expect(body).toContain(URL);
    // No money/comms member → no separate-approval legend.
    expect(body).not.toContain('Approval follows separately');
  });

  it('renders a 3-member chain, appends money facts, and marks money/comms members as approved separately', () => {
    const body = renderChainSms(
      [
        member(),
        member({
          proposalType: 'create_appointment',
          summary: 'Book Tuesday 9am for Jane Doe',
        }),
        member({
          proposalType: 'send_estimate',
          summary: 'Send Jane the estimate',
          payload: { totalCents: 45000 },
        }),
      ],
      { approveUrl: URL },
    );
    expect(body).toContain('3 linked actions:');
    expect(body).toContain('1) Create customer Jane Doe');
    expect(body).toContain('2) Book Tuesday 9am for Jane Doe');
    // Money fact extracted from the payload; comms member flagged.
    expect(body).toContain('3) Send Jane the estimate ($450.00)*');
    expect(body).toContain('*Approval follows separately.');
    expect(body).toContain('Reply Y to approve the setup steps; starred items follow separately.');
    expect(body).toContain(URL);
  });

  it('marks money-class members (record_payment) the same way', () => {
    const body = renderChainSms([
      member(),
      member({
        proposalType: 'record_payment',
        summary: 'Record a payment from Jane',
        payload: { amountCents: 20000 },
      }),
    ]);
    expect(body).toContain('2) Record a payment from Jane ($200.00)*');
    expect(body).toContain('*Approval follows separately.');
  });

  it('Track E: a MONEY head (record_payment) switches the WHOLE SMS to the review-in-app form', () => {
    const body = renderChainSms(
      [
        member({
          proposalType: 'record_payment',
          summary: 'Record a $200 payment from Jane',
          payload: { amountCents: 20000 },
        }),
        member({ proposalType: 'add_note', summary: 'Note the payment on the job' }),
      ],
      { approveUrl: URL },
    );
    // Y acts on the head, and money is never Y-approvable over SMS.
    expect(body).toContain('2 linked actions:');
    expect(body).toContain('Needs review in app before approval — reply N to reject.');
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain(URL);
    expect(body).not.toContain('*Approval follows separately.');
  });

  it('Track E: a COMMS head (send_estimate) switches the WHOLE SMS to the review-in-app form', () => {
    const body = renderChainSms(
      [
        member({
          proposalType: 'send_estimate',
          summary: 'Send Jane the estimate',
          payload: { totalCents: 45000 },
        }),
        member({ proposalType: 'add_note', summary: 'Note the send on the job' }),
      ],
      { approveUrl: URL },
    );
    expect(body).toContain('Needs review in app before approval — reply N to reject.');
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain(URL);
  });

  it('Track E: a non-capture member BEHIND a capture head keeps the approvable form (legend stars it)', () => {
    const body = renderChainSms(
      [
        member(),
        member({
          proposalType: 'record_payment',
          summary: 'Record a payment from Jane',
          payload: { amountCents: 20000 },
        }),
      ],
      { approveUrl: URL },
    );
    // Y approves the capture setup steps; the money member is starred.
    expect(body).toContain('Reply Y to approve the setup steps; starred items follow separately.');
    expect(body).toContain('2) Record a payment from Jane ($200.00)*');
    expect(body).toContain('*Approval follows separately.');
    expect(body).toContain(URL);
  });

  it('a low/very_low member switches the WHOLE SMS to the review-in-app form', () => {
    const body = renderChainSms(
      [
        member(),
        member({
          proposalType: 'create_appointment',
          summary: 'Book Tuesday 9am for Jane Doe',
          payload: { _meta: { overallConfidence: 'low' } },
        }),
        member({
          proposalType: 'send_estimate',
          summary: 'Send Jane the estimate',
          payload: { totalCents: 45000 },
        }),
      ],
      { approveUrl: URL },
    );
    // Review form: list survives, but there is NO approve affordance.
    expect(body).toContain('3 linked actions:');
    expect(body).toContain('Needs review in app before approval — reply N to reject.');
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain(URL);
    // Nothing is Y-approvable, so nothing is marked "separately".
    expect(body).not.toContain('*Approval follows separately.');
  });

  it('very_low blocks the same as low', () => {
    const body = renderChainSms(
      [member({ payload: { _meta: { overallConfidence: 'very_low' } } }), member()],
      { approveUrl: URL },
    );
    expect(body).toContain('Needs review in app before approval — reply N to reject.');
    expect(body).not.toContain(URL);
  });

  it('keeps the human-readable part within the 320-char budget — summaries give way, instructions survive', () => {
    const body = renderChainSms(
      [
        member({ summary: 'A'.repeat(300) }),
        member({ proposalType: 'create_job', summary: 'B'.repeat(300) }),
        member({ proposalType: 'send_invoice', summary: 'C'.repeat(300), payload: { totalCents: 12345 } }),
      ],
      { approveUrl: URL },
    );
    const humanPart = body.includes(' Or tap') ? body.slice(0, body.indexOf(' Or tap')) : body;
    expect(humanPart.length).toBeLessThanOrEqual(PROPOSAL_SMS_MAX_CHARS);
    expect(body).toContain('Reply Y to approve the setup steps; starred items follow separately.');
    expect(body).toContain(URL);
    expect(body).toContain('…');
  });

  it('does not repeat a money fact the summary already carries', () => {
    const body = renderChainSms([
      member(),
      member({
        proposalType: 'send_invoice',
        summary: 'Send the $123.45 invoice to Jane',
        payload: { totalCents: 12345 },
      }),
    ]);
    expect(body.match(/\$123\.45/g)).toHaveLength(1);
  });

  // Item 4 pin: an empty members list must throw rather than emit
  // a nonsensical "0 linked actions:" message.
  it('throws on an empty members list (guard: callers must supply at least one member)', () => {
    expect(() => renderChainSms([])).toThrow();
    expect(() => renderChainSms([], { approveUrl: URL })).toThrow();
  });
});
