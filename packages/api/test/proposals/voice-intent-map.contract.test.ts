/**
 * ONE intent → proposal-type map. The drift net.
 *
 * There used to be three copies of this mapping — `INTENT_TO_PROPOSAL_TYPE`
 * in `workers/voice-action-router.ts` (35 intents), a 25-case switch in
 * `ai/agents/customer-calling/inapp-adapter.ts`, and a private 17-case switch
 * in `ai/voice-turn/create-voice-turn-processor.ts`. They had already drifted
 * in BOTH directions and nothing caught it, because the map's DEFAULT is
 * `voice_clarification`: a missing case does not throw, it silently downgrades
 * a real request to a "a human should look at this" card.
 *
 * This suite makes a fourth copy fail CI instead of shipping.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  INTENT_TO_PROPOSAL_TYPE,
  intentToProposalType,
  voiceProposalSummary,
} from '../../src/proposals/voice-intent-map';
import { INTENT_TO_PROPOSAL_TYPE as ROUTER_REEXPORT } from '../../src/workers/voice-action-router';
import { S1_ALLOWED_PROPOSAL_TYPES } from '../../src/proposals/surface';
import { VALID_PROPOSAL_TYPES } from '../../src/proposals/proposal';

const SRC = join(__dirname, '../../src');
/** The one module allowed to define the mapping. */
const CANONICAL = 'proposals/voice-intent-map.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('voice intent → proposal type: exactly one map', () => {
  it('every consumer resolves to the SAME object — the router re-export is not a copy', () => {
    // Identity, not deep-equality: a second literal that happens to agree
    // today is precisely the failure mode this file exists to prevent.
    expect(ROUTER_REEXPORT).toBe(INTENT_TO_PROPOSAL_TYPE);
  });

  it('no other module defines an intent→proposalType mapping', () => {
    // A copy announces itself one of two ways: another `INTENT_TO_PROPOSAL_TYPE`
    // object literal, or another `intentToProposalType` FUNCTION declaration.
    // (Imports and call sites of the shared names are fine and expected.)
    const definitionPatterns = [
      /INTENT_TO_PROPOSAL_TYPE\s*(?::[^=]*)?=\s*\{/,
      /function\s+intentToProposalType\s*\(/,
    ];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (rel === CANONICAL) continue;
      const source = readFileSync(file, 'utf8');
      if (definitionPatterns.some((pattern) => pattern.test(source))) offenders.push(rel);
    }
    expect(
      offenders,
      `these modules define their own intent→proposalType mapping; there must be exactly ` +
        `one, in src/${CANONICAL}. Import it instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every mapped value is a real ProposalType', () => {
    const known = new Set<string>(VALID_PROPOSAL_TYPES);
    for (const [intent, proposalType] of Object.entries(INTENT_TO_PROPOSAL_TYPE)) {
      expect(known.has(proposalType as string), `${intent} → ${proposalType}`).toBe(true);
    }
  });

  it('falls back to voice_clarification for unmapped / absent intents', () => {
    expect(intentToProposalType(undefined)).toBe('voice_clarification');
    // lookup_* intents are READ-ONLY and deliberately unmapped (P11-001).
    expect(intentToProposalType('lookup_catalog')).toBe('voice_clarification');
    expect(intentToProposalType('not_a_real_intent')).toBe('voice_clarification');
    // …and the default is itself S1-allowed, which is why a caller that lands
    // on it must still be handed a CONTRACT-VALID clarification payload.
    expect(S1_ALLOWED_PROPOSAL_TYPES.has('voice_clarification')).toBe(true);
  });

  it('unifying the map did not widen the S1 (inbound caller) surface', () => {
    // The security boundary is the ALLOWLIST, not this map: the phone path
    // gates the mapped type before building a payload, so an intent that
    // gains a mapping can only become reachable if its type is allowlisted.
    // These five are the entire caller-reachable set, and adding intents here
    // must never change that.
    const s1Reachable = Object.entries(INTENT_TO_PROPOSAL_TYPE)
      .filter(([, proposalType]) => S1_ALLOWED_PROPOSAL_TYPES.has(proposalType!))
      .map(([intent]) => intent)
      .sort();
    expect(s1Reachable).toEqual([
      'create_appointment',
      'create_customer',
      'create_job',
      'draft_estimate',
      'reschedule_appointment',
    ]);
  });
});

describe('voiceProposalSummary', () => {
  it('names an auto-opened job usefully — not "Voice intent: create_appointment"', () => {
    // CreateAppointmentExecutionHandler falls back to `proposal.summary` for
    // the job name when the classifier emitted no jobTitle. The real phone
    // path used to pass the bare intent string.
    expect(voiceProposalSummary('create_appointment', { customerName: 'Jane Smith' })).toBe(
      'Schedule appointment for Jane Smith',
    );
    expect(voiceProposalSummary('create_appointment', {})).toBe('Schedule appointment');
    expect(voiceProposalSummary('draft_estimate', { customerName: 'Jane Smith' })).toBe(
      'Draft estimate for Jane Smith',
    );
    expect(voiceProposalSummary(undefined, {})).toBe('Voice clarification needed');
  });
});
