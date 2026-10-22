/**
 * #1736 — the correction flywheel: turn an owner's "correct this call" into a
 * regression case in the voice-quality corpus.
 *
 * A correction names what the agent should have done differently on a real
 * call (`CorrectionKind`) and, optionally, which caller turn. This module
 * builds the corpus artifacts for it, in the existing on-disk format:
 *
 *   scripts/13-owner-corrections/<id>.json   a `VoiceQualityScript` — the
 *                                            caller's turns up to the corrected
 *                                            one, with the owner's expectation
 *                                            on that turn
 *   golden/<id>.json                         `[]` (no expected proposal payloads)
 *   cassettes/<id>.json                      an EMPTY placeholder; the real LLM
 *                                            exchanges are recorded by
 *                                            `npm run voice-quality:record`
 *                                            (cassette hashes cannot be
 *                                            hand-authored), so the case runs
 *                                            live-gated until recorded — the
 *                                            same state every new script is in
 *
 * PII: the transcript is a real caller's. Only CALLER lines are kept (the
 * agent's old reply is exactly what is being corrected) and each is run through
 * `redactForCorpus` — phone numbers, emails, card numbers, street addresses and
 * a self-introduced name. Redaction is best-effort, not a guarantee: the
 * export CLI marks every case "review before commit" and the case lands in the
 * repo only through a human-reviewed commit, never straight from the API.
 */
import * as fs from 'fs';
import * as path from 'path';
import { redactCardNumbers } from '../../privacy/pan-redact';
import { VoiceQualityScriptSchema, type VoiceQualityScript } from '../schema';
import type { CorrectionKind } from '../../../voice/scoring/call-score-store';

export const CORRECTION_BUCKET = '13-owner-corrections' as const;
/** Synthetic caller id (555-01xx reserved range style used across the corpus). */
const SYNTHETIC_CALLER_ID = '+15555550199';
const MAX_SCRIPT_TURNS = 8;
const MAX_NOTE_IN_EXPECTATION = 300;

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ADDRESS_RE =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl|circle|cir|terrace|ter|highway|hwy)\b\.?/gi;
const SELF_INTRO_RE = /\b(my name is|this is|i am|i'm|it's)\s+(?:[A-Z][a-z'-]+)(?:\s+[A-Z][a-z'-]+)?/g;

/** Best-effort PII scrub of a caller line (see file header: not a guarantee). */
export function redactForCorpus(text: string): string {
  const noCards = redactCardNumbers(text);
  return noCards
    .replace(EMAIL_RE, '[email]')
    .replace(ADDRESS_RE, '[address]')
    .replace(PHONE_RE, '[phone]')
    .replace(SELF_INTRO_RE, (_m, lead: string) => `${lead} [name]`);
}

export interface CorrectionInput {
  id: string;
  kind: CorrectionKind;
  /** 0-based CALLER turn index; null = the final caller turn. */
  turnIndex: number | null;
  note: string;
}

export interface CorrectionCase {
  scriptId: string;
  script: VoiceQualityScript;
}

/** `owner-correction-<first 8 hex of the correction id>`; stable, so a re-export overwrites in place. */
export function correctionScriptId(correctionId: string): string {
  return `owner-correction-${correctionId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

function expectationFor(kind: CorrectionKind, note: string) {
  const ownerNote = redactForCorpus(note).trim().slice(0, MAX_NOTE_IN_EXPECTATION);
  switch (kind) {
    case 'should_have_booked':
      return {
        intent: 'create_appointment',
        proposalType: 'create_appointment',
        spokenAnswerMatches: 'agent moves the caller toward a booked appointment instead of ending without a next step',
      };
    case 'should_have_escalated':
      return {
        escalates: true,
        spokenAnswerMatches: 'agent hands the caller to a person rather than answering or improvising',
      };
    case 'should_not_have_escalated':
      return {
        escalates: false,
        spokenAnswerMatches: 'agent helps the caller itself and does not hand off unnecessarily',
      };
    case 'wrong_price':
      return {
        spokenAnswerMatches:
          'agent states no price that is not from the shop catalog; it defers to a quote or a person instead of inventing a figure',
      };
    case 'other':
      return {
        spokenAnswerMatches: ownerNote.length > 0 ? `owner expectation: ${ownerNote}` : 'agent handles the call the way the owner expects',
      };
  }
}

/**
 * Build the corpus script for a correction from the call's CALLER lines
 * (already in speaking order). Throws when the call has no caller turn or the
 * result fails the corpus schema — a correction that cannot become a valid
 * case must fail loudly at export, not write a file the loader rejects.
 */
export function buildCorrectionCase(correction: CorrectionInput, callerTurns: readonly string[]): CorrectionCase {
  if (callerTurns.length === 0) throw new Error('buildCorrectionCase: the call has no caller turns');
  const target = Math.min(correction.turnIndex ?? callerTurns.length - 1, callerTurns.length - 1);
  const first = Math.max(0, target + 1 - MAX_SCRIPT_TURNS);
  const slice = callerTurns.slice(first, target + 1);

  const scriptId = correctionScriptId(correction.id);
  const escalation = correction.kind === 'should_have_escalated' || correction.kind === 'should_not_have_escalated';
  const candidate = {
    id: scriptId,
    bucket: CORRECTION_BUCKET,
    callerId: SYNTHETIC_CALLER_ID,
    callerIdBlocked: false,
    fixtures: {
      tenant: {
        id: `t_13_${scriptId.replace(/-/g, '_')}`,
        display_name: 'Test HVAC Co',
        timezone: 'America/New_York',
      },
      customers: [],
      appointments: [],
      invoices: [],
    },
    turns: slice.map((caller, i) => ({
      caller: redactForCorpus(caller),
      expected: i === slice.length - 1 ? expectationFor(correction.kind, correction.note) : {},
      hangupAfter: false,
    })),
    grading: {
      appliesFloor: [1, 2, 3, 4, 5],
      appliesDisposition: escalation ? [9, 11, 12] : [9, 12],
    },
    layer2Eligible: false,
  };
  const parsed = VoiceQualityScriptSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`buildCorrectionCase: invalid script: ${parsed.error.message}`);
  return { scriptId, script: parsed.data };
}

/**
 * Write the script, golden and placeholder cassette under `corpusRoot`
 * (`scripts/13-owner-corrections/`, `golden/`, `cassettes/`). Scripts and
 * goldens are rewritten (a replaced correction updates its case); an existing
 * cassette is left alone so recorded exchanges are never wiped. Returns the
 * paths written.
 */
export function writeCorrectionCase(c: CorrectionCase, corpusRoot: string): string[] {
  const scriptPath = path.join(corpusRoot, 'scripts', CORRECTION_BUCKET, `${c.scriptId}.json`);
  const goldenPath = path.join(corpusRoot, 'golden', `${c.scriptId}.json`);
  const cassettePath = path.join(corpusRoot, 'cassettes', `${c.scriptId}.json`);
  const written: string[] = [];
  const put = (file: string, body: unknown, overwrite: boolean): void => {
    if (!overwrite && fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    written.push(file);
  };
  put(scriptPath, c.script, true);
  put(goldenPath, [], true);
  put(cassettePath, { scriptId: c.scriptId, version: 1, rubricVersion: 'v1', entries: [] }, false);
  return written;
}
