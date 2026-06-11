/**
 * Readback + voice-approval classifier tests.
 *
 * Critical safety: money / comms / irreversible proposals must
 * ALWAYS say "tap to confirm on screen" — they cannot be approved
 * by voice under any circumstance. These tests are the forcing
 * function that keeps the behavior explicit.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReadbackScript,
  isVoiceApprovable,
  classifyVoiceApproval,
  classifyStrictConfirm,
} from '../../../src/ai/tts/readback';
import { Proposal, ProposalType } from '../../../src/proposals/proposal';

function fakeProposal(partial: Partial<Proposal> & { proposalType: ProposalType }): Proposal {
  const now = new Date();
  return {
    id: 'p-1',
    tenantId: 't-1',
    status: 'draft',
    payload: {},
    summary: 'Sarah Chen, $450',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe('readback — isVoiceApprovable', () => {
  it('allows voice approval only for capture-class proposals', () => {
    expect(isVoiceApprovable('draft_invoice')).toBe(true);
    expect(isVoiceApprovable('create_customer')).toBe(true);
    expect(isVoiceApprovable('reschedule_appointment')).toBe(true);
    expect(isVoiceApprovable('add_note')).toBe(true);
  });

  it('refuses voice approval for money / comms / irreversible', () => {
    expect(isVoiceApprovable('record_payment')).toBe(false); // money
    expect(isVoiceApprovable('send_invoice')).toBe(false); // comms
    expect(isVoiceApprovable('send_estimate')).toBe(false); // comms
    expect(isVoiceApprovable('cancel_appointment')).toBe(false); // irreversible
  });
});

describe('readback — buildReadbackScript', () => {
  it('ends capture-class readbacks with the voice approval cue', () => {
    const s = buildReadbackScript(fakeProposal({ proposalType: 'draft_invoice' }));
    expect(s).toContain('Say approve or cancel.');
  });

  it('forces screen-tap cue on money proposals even if payload looks harmless', () => {
    const s = buildReadbackScript(fakeProposal({ proposalType: 'record_payment' }));
    expect(s).not.toContain('Say approve');
    expect(s.toLowerCase()).toContain('tap to confirm on screen');
  });

  it('forces screen-tap cue on comms proposals (send_invoice)', () => {
    const s = buildReadbackScript(fakeProposal({ proposalType: 'send_invoice' }));
    expect(s).not.toContain('Say approve');
    expect(s.toLowerCase()).toContain('tap to confirm on screen');
  });

  it('forces screen-tap cue on comms proposals (send_estimate)', () => {
    const s = buildReadbackScript(fakeProposal({ proposalType: 'send_estimate' }));
    expect(s).not.toContain('Say approve');
    expect(s.toLowerCase()).toContain('tap to confirm on screen');
    expect(s.toLowerCase()).toContain('send an estimate');
  });

  it('forces screen-tap cue on irreversible proposals (cancel_appointment)', () => {
    const s = buildReadbackScript(fakeProposal({ proposalType: 'cancel_appointment' }));
    expect(s).not.toContain('Say approve');
    expect(s.toLowerCase()).toContain('tap to confirm on screen');
  });

  it('truncates overlong summaries with an ellipsis to keep the readback short', () => {
    const long =
      'Very long summary '.repeat(20) + 'END';
    const s = buildReadbackScript(
      fakeProposal({ proposalType: 'draft_invoice', summary: long })
    );
    expect(s.length).toBeLessThan(200);
    expect(s).toContain('…');
  });
});

describe('readback — classifyVoiceApproval', () => {
  it('recognizes approval phrases', () => {
    expect(classifyVoiceApproval('yes')).toBe('approve');
    expect(classifyVoiceApproval('approve it')).toBe('approve');
    expect(classifyVoiceApproval('go ahead')).toBe('approve');
    expect(classifyVoiceApproval('send it')).toBe('approve');
    expect(classifyVoiceApproval('yeah confirm')).toBe('approve');
  });

  it('recognizes cancel phrases', () => {
    expect(classifyVoiceApproval('no')).toBe('cancel');
    expect(classifyVoiceApproval('cancel')).toBe('cancel');
    expect(classifyVoiceApproval('never mind')).toBe('cancel');
    expect(classifyVoiceApproval("don't send it")).toBe('cancel');
    expect(classifyVoiceApproval('stop')).toBe('cancel');
  });

  it('cancel dominates when both approve and cancel phrases appear', () => {
    // Safety-first: a negation word in the reply means do NOT approve.
    expect(classifyVoiceApproval('no, approve it')).toBe('cancel');
    expect(classifyVoiceApproval('yes but cancel anyway')).toBe('cancel');
  });

  it('recognizes repeat and edit phrases', () => {
    expect(classifyVoiceApproval('repeat')).toBe('repeat');
    expect(classifyVoiceApproval('say that again')).toBe('repeat');
    expect(classifyVoiceApproval('edit it')).toBe('edit');
    expect(classifyVoiceApproval('change the amount')).toBe('edit');
  });

  it('returns unknown for empty and for ambiguous input', () => {
    expect(classifyVoiceApproval('')).toBe('unknown');
    expect(classifyVoiceApproval('   ')).toBe('unknown');
    expect(classifyVoiceApproval('mmhm')).toBe('unknown');
    expect(classifyVoiceApproval('what')).toBe('unknown');
  });
});

describe('readback — classifyStrictConfirm (table-driven)', () => {
  // Pure yes/approve variants → approve
  it.each([
    'yes',
    'approve',
    'yep',
    'confirm',
    'go ahead',
    'do it',
  ])('"%s" → approve (strict short affirmative)', (input) => {
    expect(classifyStrictConfirm(input)).toBe('approve');
  });

  // With filler words stripped — still short enough → approve
  it.each([
    'yes please',
    'yeah approve it',
    'okay yes',
    'um yes',
  ])('"%s" → approve (strict with fillers stripped)', (input) => {
    expect(classifyStrictConfirm(input)).toBe('approve');
  });

  // Retargeting / compound utterances → reask
  it.each([
    'approve the acme invoice instead',
    'yes and also send the invoice',
    'approve it but change the amount first',
    'yes approve the Henderson one',
  ])('"%s" → reask (retargeting / too long)', (input) => {
    expect(classifyStrictConfirm(input)).toBe('reask');
  });

  // Negation → reject
  it.each([
    'no',
    "yes... actually no",
    'cancel',
    'stop',
    'no approve it',
  ])('"%s" → reject (negation dominates)', (input) => {
    expect(classifyStrictConfirm(input)).toBe('reject');
  });

  // Empty / silence → unknown
  it.each(['', '   '])('"%s" → unknown (empty)', (input) => {
    expect(classifyStrictConfirm(input)).toBe('unknown');
  });

  // Gibberish → reask (not empty, not approve, not reject)
  it.each([
    'what time is it',
    'hmm let me think',
    'maybe tomorrow',
  ])('"%s" → reask (gibberish / off-topic)', (input) => {
    expect(classifyStrictConfirm(input)).toBe('reask');
  });
});
