import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ProposalType } from '../enums.js';
import {
  CAPTURE_PROPOSAL_TYPES,
  COMMS_PROPOSAL_TYPES,
  MONEY_PROPOSAL_TYPES,
  IRREVERSIBLE_PROPOSAL_TYPES,
  MANUAL_PROPOSAL_TYPES,
  actionClassForProposalType,
  isCaptureProposalType,
} from './proposal-action-class.js';

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
function apiTypesByClass(source: string): Record<string, Set<string>> {
  const body = source.match(
    /export function actionClassForProposalType\([\s\S]*?\)\s*:\s*ActionClass\s*\{([\s\S]*?)\n\}/,
  );
  if (!body) throw new Error('actionClassForProposalType switch not found in proposal.ts');
  const byClass: Record<string, Set<string>> = {};
  let pending: string[] = [];
  for (const line of body[1].split('\n')) {
    const caseM = line.match(/case\s+['"]([^'"]+)['"]\s*:/);
    if (caseM) {
      pending.push(caseM[1]);
      continue;
    }
    const retM = line.match(/return\s+['"]([^'"]+)['"]\s*;/);
    if (retM) {
      const cls = retM[1];
      byClass[cls] ??= new Set<string>();
      for (const t of pending) byClass[cls].add(t);
      pending = [];
    }
  }
  return byClass;
}

const apiByClass = apiTypesByClass(proposalSource);
const apiCapture = apiByClass['capture'] ?? new Set<string>();

/** The shared sets, keyed the same way as the parsed API switch. */
const SHARED_SETS: Record<string, ReadonlySet<string>> = {
  capture: CAPTURE_PROPOSAL_TYPES,
  comms: COMMS_PROPOSAL_TYPES,
  money: MONEY_PROPOSAL_TYPES,
  irreversible: IRREVERSIBLE_PROPOSAL_TYPES,
  manual: MANUAL_PROPOSAL_TYPES,
};

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

describe('all five lanes ↔ API actionClassForProposalType parity (U1)', () => {
  it('parses every lane from the API switch', () => {
    for (const cls of ['capture', 'comms', 'money', 'irreversible', 'manual']) {
      expect(apiByClass[cls]?.size ?? 0, `no '${cls}' arm parsed`).toBeGreaterThan(0);
    }
  });

  it.each(['capture', 'comms', 'money', 'irreversible', 'manual'])(
    "shared '%s' set exactly matches the API switch",
    (cls) => {
      const shared = SHARED_SETS[cls];
      const api = apiByClass[cls] ?? new Set<string>();
      expect([...shared].filter((t) => !api.has(t)), 'extra in shared').toEqual([]);
      expect([...api].filter((t) => !shared.has(t)), 'missing from shared').toEqual([]);
    },
  );

  it('classifies every real ProposalType into a lane — never unknown', () => {
    const unknowns = Object.values(ProposalType).filter(
      (t) => actionClassForProposalType(t) === 'unknown',
    );
    expect(unknowns).toEqual([]);
  });

  it('returns unknown for an unrecognized type (fail-closed lane)', () => {
    expect(actionClassForProposalType('not_a_real_type')).toBe('unknown');
  });

  it('agrees with isCaptureProposalType', () => {
    for (const t of Object.values(ProposalType)) {
      expect(actionClassForProposalType(t) === 'capture').toBe(isCaptureProposalType(t));
    }
  });
});
