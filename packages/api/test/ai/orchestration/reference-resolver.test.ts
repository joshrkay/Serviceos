/**
 * Reference resolver unit tests. Verifies pronouns and
 * "the X" references get rewritten with concrete referents from
 * recent conversation turns BEFORE classification — the mechanism
 * that makes "send it to him" work as a follow-up to "create an
 * invoice for Rodriguez".
 */
import { describe, it, expect } from 'vitest';
import {
  resolveReferences,
  ConversationReferent,
} from '../../../src/ai/orchestration/reference-resolver';

function referent(partial: Partial<ConversationReferent>): ConversationReferent {
  return {
    proposalType: 'draft_invoice',
    createdAt: new Date(),
    ...partial,
  };
}

describe('reference-resolver — resolveReferences', () => {
  it('leaves transcript unchanged when no pronouns appear', () => {
    const out = resolveReferences('create an invoice for Acme for 450', {
      recentReferents: [referent({ invoiceReference: 'INV-0042', customerName: 'Rodriguez' })],
    });
    expect(out.rewrote).toBe(false);
    expect(out.transcript).toBe('create an invoice for Acme for 450');
  });

  it('leaves transcript unchanged when there is no recent referent', () => {
    const out = resolveReferences('send it to him', { recentReferents: [] });
    expect(out.rewrote).toBe(false);
    expect(out.transcript).toBe('send it to him');
  });

  it('rewrites "it" to the most recent invoice reference', () => {
    const out = resolveReferences('send it over', {
      recentReferents: [referent({ invoiceReference: 'INV-0042' })],
    });
    expect(out.rewrote).toBe(true);
    expect(out.transcript).toContain('invoice INV-0042');
  });

  it('rewrites "the invoice" to the concrete invoice reference', () => {
    const out = resolveReferences('email the invoice', {
      recentReferents: [referent({ invoiceReference: 'INV-0042' })],
    });
    expect(out.rewrote).toBe(true);
    expect(out.transcript.toLowerCase()).toContain('invoice inv-0042');
  });

  it('rewrites person pronouns to the most recent customer name', () => {
    const out = resolveReferences('text him', {
      recentReferents: [referent({ customerName: 'Rodriguez' })],
    });
    expect(out.rewrote).toBe(true);
    expect(out.transcript).toContain('Rodriguez');
  });

  it('rewrites compound: "send it to him" gets both parts resolved', () => {
    const out = resolveReferences('send it to him', {
      recentReferents: [
        referent({ invoiceReference: 'INV-0042', customerName: 'Rodriguez' }),
      ],
    });
    expect(out.rewrote).toBe(true);
    // Both substitutions logged.
    const labels = out.substitutions.map((s) => s.pronoun);
    expect(labels).toEqual(expect.arrayContaining(['him/her/them']));
    expect(out.transcript).toContain('Rodriguez');
  });

  it('prefers the most-recent referent when multiple exist', () => {
    const older = referent({ invoiceReference: 'INV-0001', createdAt: new Date(2020, 0, 1) });
    const newer = referent({ invoiceReference: 'INV-0042', createdAt: new Date() });
    const out = resolveReferences('send the invoice', {
      recentReferents: [newer, older],
    });
    expect(out.rewrote).toBe(true);
    expect(out.transcript).toContain('INV-0042');
    expect(out.transcript).not.toContain('INV-0001');
  });

  it('does not mangle words that happen to contain pronoun letters', () => {
    // "it" appears inside "itemize" and "hit"; word-boundary regex
    // must not replace those.
    const out = resolveReferences('itemize the labor hit', {
      recentReferents: [referent({ invoiceReference: 'INV-0042' })],
    });
    expect(out.transcript).toBe('itemize the labor hit');
    expect(out.rewrote).toBe(false);
  });

  it('handles "the job" / "the appointment" by matching appointment or job references', () => {
    const out = resolveReferences('cancel the job', {
      recentReferents: [referent({ appointmentReference: 'APT-0012' })],
    });
    expect(out.rewrote).toBe(true);
    expect(out.transcript).toContain('APT-0012');
  });
});
