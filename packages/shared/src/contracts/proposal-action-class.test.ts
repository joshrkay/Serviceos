import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ProposalType } from '../enums.js';
import { CAPTURE_PROPOSAL_TYPES, isCaptureProposalType } from './proposal-action-class.js';

/**
 * Parity guard: the shared CAPTURE_PROPOSAL_TYPES set must exactly mirror the
 * 'capture' arm of the API's authoritative `actionClassForProposalType` switch
 * in packages/api/src/proposals/proposal.ts. This is the safety-critical
 * invariant behind the mobile inbox's "approve all eligible": if a comms/money/
 * irreversible type ever leaked into the capture set (or a capture type were
 * added server-side but forgotten here), bulk approval could either skip a safe
 * action or, far worse, sweep up one that must be reviewed individually.
 */
const here = dirname(fileURLToPath(import.meta.url));
const proposalSource = readFileSync(
  resolve(here, '../../../api/src/proposals/proposal.ts'),
  'utf8',
);

/** Pull the case literals that map to each ActionClass out of the switch. */
function apiCaptureTypes(source: string): Set<string> {
  const body = source.match(
    /export function actionClassForProposalType\([\s\S]*?\)\s*:\s*ActionClass\s*\{([\s\S]*?)\n\}/,
  );
  if (!body) throw new Error('actionClassForProposalType switch not found in proposal.ts');
  const capture = new Set<string>();
  let pending: string[] = [];
  for (const line of body[1].split('\n')) {
    const caseM = line.match(/case\s+['"]([^'"]+)['"]\s*:/);
    if (caseM) {
      pending.push(caseM[1]);
      continue;
    }
    const retM = line.match(/return\s+['"]([^'"]+)['"]\s*;/);
    if (retM) {
      if (retM[1] === 'capture') for (const t of pending) capture.add(t);
      pending = [];
    }
  }
  return capture;
}

const apiCapture = apiCaptureTypes(proposalSource);

describe('CAPTURE_PROPOSAL_TYPES ↔ API actionClassForProposalType parity', () => {
  it('parses the API switch', () => {
    expect(apiCapture.size).toBeGreaterThan(0);
  });

  it('the shared set has no type the API does not classify as capture', () => {
    const extra = [...CAPTURE_PROPOSAL_TYPES].filter((t) => !apiCapture.has(t));
    expect(extra).toEqual([]);
  });

  it('the shared set is missing no capture type the API defines', () => {
    const missing = [...apiCapture].filter((t) => !CAPTURE_PROPOSAL_TYPES.has(t));
    expect(missing).toEqual([]);
  });

  it('every capture type is a real ProposalType', () => {
    const valid = new Set<string>(Object.values(ProposalType));
    const unknown = [...CAPTURE_PROPOSAL_TYPES].filter((t) => !valid.has(t));
    expect(unknown).toEqual([]);
  });
});

describe('isCaptureProposalType', () => {
  it('is true for a capture type, false for comms/money/irreversible and unknowns', () => {
    expect(isCaptureProposalType(ProposalType.DRAFT_INVOICE)).toBe(true);
    expect(isCaptureProposalType(ProposalType.SEND_INVOICE)).toBe(false); // comms
    expect(isCaptureProposalType(ProposalType.RECORD_PAYMENT)).toBe(false); // money
    expect(isCaptureProposalType(ProposalType.CANCEL_APPOINTMENT)).toBe(false); // irreversible
    expect(isCaptureProposalType('not_a_real_type')).toBe(false);
  });
});
