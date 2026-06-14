import { describe, it, expect } from 'vitest';
import {
  generateApprovalCode,
  normalizeApprovalCode,
  parseApprovalReply,
  proposalShortLine,
  lineItemsTotalCents,
  renderApprovalRequestSms,
  renderApprovalReplySms,
  smsApprovalCodeOf,
} from '../../../src/sms/proposal-approval/render';
import type { Proposal } from '../../../src/proposals/proposal';

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-1',
    tenantId: 't-1',
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    payload: {},
    summary: 'invoice Acme for the water heater',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('generateApprovalCode', () => {
  it('is 4 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateApprovalCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it('round-trips through normalizeApprovalCode unchanged (no look-alikes emitted)', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateApprovalCode();
      expect(normalizeApprovalCode(code)).toBe(code);
    }
  });
});

describe('normalizeApprovalCode', () => {
  it('uppercases and strips whitespace/punctuation', () => {
    expect(normalizeApprovalCode(' a7kq ')).toBe('A7KQ');
    expect(normalizeApprovalCode('a7-kq')).toBe('A7KQ');
  });

  it('folds the classic look-alikes an owner might mistype', () => {
    // O→Q and 0→Q; I/L/1→J. A code we'd never generate, but a human might type.
    expect(normalizeApprovalCode('o0')).toBe('QQ');
    expect(normalizeApprovalCode('il1')).toBe('JJJ');
  });
});

describe('parseApprovalReply', () => {
  it('maps approve keywords to approve', () => {
    for (const kw of ['APPROVE', 'yes', 'OK', 'y']) {
      expect(parseApprovalReply(kw)?.action).toBe('approve');
    }
  });

  it('maps reject keywords to reject', () => {
    for (const kw of ['REJECT', 'no', 'decline', 'N']) {
      expect(parseApprovalReply(kw)?.action).toBe('reject');
    }
  });

  it('extracts and normalizes a code from the second token', () => {
    expect(parseApprovalReply('APPROVE a7kq')).toEqual({ action: 'approve', code: 'A7KQ' });
    expect(parseApprovalReply('NO   A7KQ')).toEqual({ action: 'reject', code: 'A7KQ' });
  });

  it('returns null for non-approval first tokens', () => {
    expect(parseApprovalReply('maybe later')).toBeNull();
    expect(parseApprovalReply('')).toBeNull();
  });
});

describe('lineItemsTotalCents / proposalShortLine', () => {
  it('sums invoice unitPriceCents × quantity', () => {
    const p = proposal({
      payload: {
        lineItems: [
          { description: 'Water Heater', quantity: 1, unitPriceCents: 185_000 },
          { description: 'Labor', quantity: 2, unitPriceCents: 15_000 },
        ],
      },
    });
    expect(lineItemsTotalCents(p)).toBe(215_000);
    expect(proposalShortLine(p)).toBe('Invoice — $2,150.00');
  });

  it('sums estimate unitPrice (also integer cents)', () => {
    const p = proposal({
      proposalType: 'draft_estimate',
      payload: { lineItems: [{ description: 'Tune-up', quantity: 1, unitPrice: 12_500 }] },
    });
    expect(proposalShortLine(p)).toBe('Estimate — $125.00');
  });

  it('falls back to the summary when lines are not priceable', () => {
    const p = proposal({ payload: { lineItems: [{ description: 'x', quantity: 1 }] } });
    expect(lineItemsTotalCents(p)).toBeUndefined();
    expect(proposalShortLine(p)).toBe('Invoice: invoice Acme for the water heater');
  });

  it('uses the bare summary for types with no label', () => {
    const p = proposal({ proposalType: 'add_note', summary: 'note: called back', payload: {} });
    expect(proposalShortLine(p)).toBe('note: called back');
  });
});

describe('renderApprovalRequestSms', () => {
  it('includes the code in both the approve and decline instruction and stays <=320 chars', () => {
    const p = proposal({
      payload: { lineItems: [{ description: 'WH', quantity: 1, unitPriceCents: 185_000 }] },
    });
    const sms = renderApprovalRequestSms(p, 'A7KQ');
    expect(sms).toContain('YES A7KQ');
    expect(sms).toContain('NO A7KQ');
    expect(sms).toContain('$1,850.00');
    expect(sms.length).toBeLessThanOrEqual(320);
  });

  it('clips a very long description but keeps the reply instruction intact', () => {
    const p = proposal({ proposalType: 'add_note', summary: 'x'.repeat(500), payload: {} });
    const sms = renderApprovalRequestSms(p, 'A7KQ');
    expect(sms.length).toBeLessThanOrEqual(320);
    expect(sms).toContain('YES A7KQ to approve or NO A7KQ to decline.');
  });
});

describe('renderApprovalReplySms', () => {
  it('confirms approval with the short line', () => {
    const p = proposal({
      payload: { lineItems: [{ description: 'WH', quantity: 1, unitPriceCents: 185_000 }] },
    });
    expect(renderApprovalReplySms('approved', { proposal: p })).toContain('✓ Approved');
    expect(renderApprovalReplySms('approved', { proposal: p })).toContain('$1,850.00');
  });

  it('renders each non-action outcome', () => {
    expect(renderApprovalReplySms('needs_code', { pendingCount: 3 })).toContain('3 items');
    expect(renderApprovalReplySms('nothing_pending')).toMatch(/caught up/i);
    expect(renderApprovalReplySms('not_found')).toMatch(/already be handled/i);
    expect(renderApprovalReplySms('needs_details')).toMatch(/open the app/i);
  });
});

describe('smsApprovalCodeOf', () => {
  it('reads the stamped code, or undefined when absent', () => {
    expect(smsApprovalCodeOf(proposal())).toBeUndefined();
    expect(
      smsApprovalCodeOf(proposal({ sourceContext: { smsApproval: { code: 'A7KQ' } } })),
    ).toBe('A7KQ');
  });
});
