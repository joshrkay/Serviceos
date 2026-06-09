import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ProposalType } from '../enums.js';
import { proposalTypeSchema } from './voice-assistants.js';

/**
 * Parity guard: the shared ProposalType enum must exactly mirror the API's
 * authoritative `VALID_PROPOSAL_TYPES` union in
 * packages/api/src/proposals/proposal.ts. This is the test that makes the
 * historical drift — where the shared enum was missing 11 server-handled types
 * (callback, add_crew_member, review_response_proposal, …) — fail CI instead of
 * silently leaving the shared template/SMS/email/voice registries blind.
 */

const here = dirname(fileURLToPath(import.meta.url));
const proposalSource = readFileSync(
  resolve(here, '../../../api/src/proposals/proposal.ts'),
  'utf8',
);

/** Pull the string literals out of the `VALID_PROPOSAL_TYPES: ProposalType[] = [ ... ]` array. */
function apiValidProposalTypes(source: string): Set<string> {
  const match = source.match(/VALID_PROPOSAL_TYPES\s*:\s*ProposalType\[\]\s*=\s*\[([\s\S]*?)\]/);
  if (!match) throw new Error('VALID_PROPOSAL_TYPES array not found in proposal.ts');
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const apiTypes = apiValidProposalTypes(proposalSource);
const sharedTypes = new Set<string>(Object.values(ProposalType));

describe('ProposalType enum ↔ API VALID_PROPOSAL_TYPES parity', () => {
  it('parses the API union', () => {
    expect(apiTypes.size).toBeGreaterThan(0);
  });

  it('shared enum has no type the API does not define', () => {
    const extra = [...sharedTypes].filter((t) => !apiTypes.has(t));
    expect(extra).toEqual([]);
  });

  it('shared enum is missing no type the API defines', () => {
    const missing = [...apiTypes].filter((t) => !sharedTypes.has(t));
    expect(missing).toEqual([]);
  });

  it('proposalTypeSchema accepts every API proposal type', () => {
    for (const t of apiTypes) {
      expect(proposalTypeSchema.parse(t)).toBe(t);
    }
  });
});
