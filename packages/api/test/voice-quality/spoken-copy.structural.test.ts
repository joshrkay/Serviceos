/**
 * #1601 step 1 — every voice file speaks ONLY catalog copy.
 *
 * The 2026-10-04 code-health review found spoken copy in six files with
 * Spanish keyed on exact English sentences, so every copy fix had to land in
 * parallel places and a one-word English edit silently dropped a translation.
 * Step 1 moves every inline spoken literal of the turn processor, the Gather
 * adapter, the in-app adapter, the FSM transition table and the quote read-back
 * into `tts-copy.ts` (`TTS_COPY`, id-keyed, EN + ES). This guard — the #1599
 * driver guard extended to those files — fails the build if any of them grows
 * a sentence literal of its own again.
 *
 * A "sentence" is any string literal of three or more words carrying sentence
 * punctuation (`spoken-copy-scan.ts`). Those files also carry sentences that
 * are NOT spoken — logger lines, audit notes, owner push/SMS text, operator
 * notes on a proposal, TwiML XML. Each is named below EXACTLY, with why it is
 * not spoken, so the list cannot grow silently: an unlisted sentence fails the
 * guard, and a listed sentence that is no longer in the file fails it too
 * (the allowlist cannot rot). Spoken copy is never allowlisted — it moves.
 *
 * Evidence class: STRUCTURAL (the negative control plants an inline sentence,
 * an allowlisted line and a stale allowlist entry into a temp copy and shows
 * the guard reporting each).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readFileSync } from 'fs';
import { sentenceLiterals } from './spoken-copy-scan';

const SRC = path.resolve(__dirname, '../../src');

type NotSpokenBecause =
  | 'log' // logger.warn / logger.info message
  | 'audit_note' // text persisted on an audit row
  | 'owner_notification' // owner push / SMS title or body
  | 'operator_note' // transcript / note synthesised for the operator
  | 'proposal_summary' // the card's summary / notes an operator reads
  | 'twiml'; // XML markup, not <Say> text

interface Allowed {
  why: NotSpokenBecause;
  /** The literal EXACTLY as the file writes it between its quotes. */
  literal: string;
}

/** The files whose spoken copy lives in tts-copy.ts, with their non-spoken sentences. */
export const GUARDED_FILES: Record<string, Allowed[]> = {
  "ai/voice-turn/create-voice-turn-processor.ts": [
    { why: "proposal_summary", literal: "Review response drafting isn't available on this call yet." },
    { why: "operator_note", literal: "Caller asked for '${intent ?? 'unknown'}' — an operator-only action." },
    { why: "operator_note", literal: " Details heard: ${entityDetails}." },
    { why: "operator_note", literal: "Caller's '${intent ?? 'unknown'}' request needs a human — details were incomplete" },
    { why: "twiml", literal: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" },
    // The <Say> wrapper around the catalog's voicemail line — markup only.
    { why: "twiml", literal: "<Say voice=\"Polly.Joanna\">${voicemailLine}</Say>" },
    { why: "log", literal: "(proposal ${proposal.id}, status ${proposal.status}). Cancel it by hand." },
    { why: "audit_note", literal: "Booking revoked — E1 life-safety signal (${reason}) during the call; a hazard call is never booked." },
    { why: "owner_notification", literal: "⚠️ EMERGENCY — life-safety call" },
    { why: "owner_notification", literal: ". Caller directed to 911/the utility — follow up immediately." },
    { why: "owner_notification", literal: ". Detected: \"${keyword}\". The caller was directed to 911/the utility. " },
    { why: "owner_notification", literal: "Please follow up immediately." },
    { why: "log", literal: "post-quote close: strict confirm failed — treating as not confirmed" },
    { why: "proposal_summary", literal: "Caller ${maskPhone(callerPhone)} matched ${candidates.length} customers — pick which one before this call is attached." },
    { why: "proposal_summary", literal: "Outside the service area (ZIP ${zip}) — asked to book by phone: \"${request}\"" },
    { why: "log", literal: "speechTurn: language switch refused — flap guard" },
  ],
  "telephony/twilio-adapter.ts": [
    { why: "twiml", literal: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response>${parts.join('')}</Response>" },
    { why: "log", literal: "owner-line caller-ID without A-attestation — treating as untrusted caller" },
    { why: "log", literal: "resolveOwnerSession failed — treating caller as non-owner" },
    { why: "log", literal: "loadB2bAccountContext failed — caller routes as normal account" },
    { why: "twiml", literal: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" },
    { why: "log", literal: "E1 audit write exceeded deadline — speaking 911 script anyway" },
    { why: "log", literal: "recording objection: no recording control wired — recording NOT paused" },
    { why: "log", literal: "handleInbound: replay for existing CallSid — reusing session" },
    { why: "log", literal: "handleGather: max call duration reached — ending call" },
    { why: "log", literal: "twilio-adapter: gather hints resolution failed — proceeding without hints" },
    { why: "log", literal: "gather: language switch refused — flap guard" },
  ],
  "ai/agents/customer-calling/inapp-adapter.ts": [
    { why: "proposal_summary", literal: "Review response drafting isn't available on this call yet." },
  ],
  "ai/agents/customer-calling/transitions.ts": [],
  "ai/voice-turn/quote-readback.ts": [],
};

export interface SpokenCopyReport {
  /** Sentence literals in the file that are neither catalog copy nor allowlisted. */
  inline: string[];
  /** Allowlisted literals the file no longer contains (the list rotted). */
  staleAllowlist: string[];
}

export function scanGuardedSource(source: string, allowed: readonly Allowed[]): SpokenCopyReport {
  const found = sentenceLiterals(source);
  const allowedSet = new Set(allowed.map((a) => a.literal));
  const foundSet = new Set(found);
  return {
    inline: found.filter((literal) => !allowedSet.has(literal)),
    staleAllowlist: allowed.map((a) => a.literal).filter((literal) => !foundSet.has(literal)),
  };
}

describe('#1601 — voice files carry no spoken copy of their own (it lives in tts-copy.ts)', () => {
  for (const [file, allowed] of Object.entries(GUARDED_FILES)) {
    it(`${file} speaks only catalog copy; its non-spoken sentences are the allowlisted ones`, () => {
      const report = scanGuardedSource(readFileSync(path.join(SRC, file), 'utf8'), allowed);
      expect(report.inline, `${file}: inline spoken copy — move it to tts-copy.ts`).toEqual([]);
      expect(report.staleAllowlist, `${file}: allowlist names a literal the file no longer has`).toEqual([]);
    });
  }

  it('negative control — the guard reports a planted sentence, accepts an allowlisted one, and flags a stale entry', () => {
    const file = 'ai/agents/customer-calling/transitions.ts';
    const source = readFileSync(path.join(SRC, file), 'utf8');
    const planted =
      source +
      `\nconst spoken = "Got it — I've drafted a callback for review. Anything else?";\n` +
      `logger.warn('planted: something failed — carrying on');\n`;
    const allowed: Allowed[] = [
      { why: 'log', literal: 'planted: something failed — carrying on' },
      { why: 'log', literal: 'stale: this line is not in the file — rotted' },
    ];
    const report = scanGuardedSource(planted, allowed);
    expect(report.inline).toContain("Got it — I've drafted a callback for review. Anything else?");
    expect(report.inline).not.toContain('planted: something failed — carrying on');
    expect(report.staleAllowlist).toEqual(['stale: this line is not in the file — rotted']);
  });

  it('a template made only of expressions is not a sentence; one with words still is', () => {
    const source =
      'const a = `${opener} ${cta}`;\n' +
      'const b = `Thank you for calling ${business}. How can I help you today?`;\n';
    expect(scanGuardedSource(source, []).inline).toEqual([
      'Thank you for calling ${business}. How can I help you today?',
    ]);
  });
});
