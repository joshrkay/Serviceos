/**
 * Voice-approval utterance classifier tests.
 *
 * Critical safety: `classifyStrictConfirm` gates the RV-071 confirm
 * stage — only a short, unambiguous affirmative approves; negation
 * always dominates, and retargeting/compound utterances re-ask rather
 * than execute. These tests are the forcing function that keeps that
 * behavior explicit. (The readback script itself — including the
 * money/comms/irreversible screen-tap cue — is composed by
 * `composeReadback` in ai/tasks/proposal-approval-task.ts and pinned
 * there.)
 */
import { describe, it, expect } from 'vitest';
import {
  classifyVoiceApproval,
  classifyStrictConfirm,
} from '../../../src/ai/tts/readback';

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
