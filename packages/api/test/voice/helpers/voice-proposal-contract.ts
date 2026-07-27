/**
 * The voice-suite payload-contract net.
 *
 * Every proposal a voice surface mints must be EXECUTABLE IF APPROVED — that
 * is the whole point of `proposals/voice-payload.ts`. But a suite only ever
 * checks the proposals it happens to reach in and inspect, so a surface that
 * quietly persists a malformed payload alongside the one under test stays
 * invisible. That is exactly how the real Twilio path shipped an unexecutable
 * nested envelope past a green golden-path suite.
 *
 * `guardVoiceProposalContract` closes that by checking at the WRITE, not the
 * read: hand it the `InMemoryProposalRepository` a voice suite is wired with
 * and every `create` / `createMany` through it is contract-checked, whether or
 * not the test looks at the result.
 *
 * ── Why it records instead of throwing ────────────────────────────────────
 * Both voice adapters wrap proposal creation in a try/catch that turns ANY
 * throw into an audit row and a swallowed `undefined`. An assertion thrown
 * from inside `create` would therefore be eaten, and would additionally
 * corrupt the flow under test — it surfaced once as an unrelated, baffling
 * "booking rate 0.16" three assertions downstream. So violations are recorded
 * and reported by a file-scoped `afterEach` (registered on import), which
 * cannot be swallowed and names the real defect.
 */
import { afterEach, expect } from 'vitest';
import type { Proposal, ProposalRepository } from '../../../src/proposals/proposal';
// `missingFields` rides inside `sourceContext` (no schema migration); this is
// the typed reader. Reaching for `proposal.missingFields` silently yields
// undefined and would make this guard treat every GATED draft as ungated.
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { validateProposalPayload } from '../../../src/proposals/contracts';

/**
 * A `proposalType` whose payload is knowingly allowed to fail its contract in
 * this suite, with the reason it is still open. Anything NOT declared here is
 * a hard failure.
 */
export interface KnownContractGap {
  proposalType: string;
  /** Why it is still failing, and where it is tracked. */
  reason: string;
}

/** Violations seen since the last `afterEach`, across every guarded repo. */
const pendingViolations: string[] = [];

/**
 * Describe a proposal that is an APPROVE-TO-FAIL card, or `undefined` if it
 * is fine.
 *
 * The invariant is deliberately not "the payload always validates" — this
 * codebase persists partial AI drafts ON PURPOSE, stamping the unmet keys as
 * `missingFields`, and `approveProposal` (proposals/actions.ts) then REFUSES
 * to approve until an operator fills them. That is a safe, intended state.
 *
 * What must never exist is the third case: a payload that fails its contract
 * with NOTHING gating it, so an operator taps approve and the execution
 * handler throws. That is precisely the card the real Twilio phone path used
 * to mint for every inbound caller.
 *
 *   valid payload                      → fine
 *   invalid payload + missingFields    → fine (gated; operator must complete)
 *   invalid payload + no missingFields → THE BUG
 */
export function voiceProposalContractViolation(proposal: Proposal): string | undefined {
  const result = validateProposalPayload(proposal.proposalType, proposal.payload);
  if (result.valid) return undefined;
  if (missingFieldsFor(proposal).length > 0) return undefined;
  return (
    `voice-minted proposal '${proposal.proposalType}' (summary: ${proposal.summary}) ` +
    `failed validateProposalPayload AND carries no missingFields gate, so approving ` +
    `it would throw at the execution handler.\n` +
    `  errors: ${(result.errors ?? []).join('; ')}\n` +
    `  payload: ${JSON.stringify(proposal.payload)}`
  );
}

/** Direct, throwing form — for a proposal a test already holds. */
export function assertVoiceProposalPayloadValid(proposal: Proposal): void {
  const violation = voiceProposalContractViolation(proposal);
  expect(violation ?? 'ok').toBe('ok');
}

/**
 * Install the contract net on a proposal repository. Returns the SAME
 * instance (patched in place) so call sites read as a one-line wrap:
 *
 *   const proposalRepo = guardVoiceProposalContract(new InMemoryProposalRepository());
 */
export function guardVoiceProposalContract<R extends ProposalRepository>(
  repo: R,
  options: { knownGaps?: readonly KnownContractGap[] } = {},
): R {
  const exempt = new Set((options.knownGaps ?? []).map((gap) => gap.proposalType));
  const check = (proposal: Proposal): void => {
    // Scoped to the two surfaces that share `proposals/voice-payload.ts`:
    // the real Twilio path (ai/voice-turn/create-voice-turn-processor.ts) and
    // the in-app adapter (ai/agents/customer-calling/inapp-adapter.ts). Both
    // stamp `sourceContext.source = 'calling-agent'`.
    //
    // Deliberately NOT the voice-action-router worker (`source: 'voice'`),
    // which mints proposals through the AI TASK handlers — a different
    // pipeline with its own contract tests, and one whose suites seed
    // deliberately-fake ids (`cust-lee`, `job-1`) that no uuid schema accepts.
    // Widening this guard to cover it would test the fixtures, not the code.
    if (proposal.sourceContext?.source !== 'calling-agent') return;
    if (exempt.has(proposal.proposalType)) return;
    const violation = voiceProposalContractViolation(proposal);
    if (violation) pendingViolations.push(violation);
  };

  const originalCreate = repo.create.bind(repo);
  repo.create = async (proposal: Proposal) => {
    check(proposal);
    return originalCreate(proposal);
  };

  if (typeof repo.createMany === 'function') {
    const originalCreateMany = repo.createMany.bind(repo);
    repo.createMany = async (proposals: Proposal[]) => {
      for (const proposal of proposals) check(proposal);
      return originalCreateMany(proposals);
    };
  }

  return repo;
}

// File-scoped: registered once per test file that imports this helper.
afterEach(() => {
  const seen = pendingViolations.splice(0);
  expect(
    seen,
    `${seen.length} voice-minted proposal(s) would fail at the execution handler ` +
      `if approved:\n\n${seen.join('\n\n')}\n\nIf a gap is known and deliberately ` +
      `unfixed, declare it via guardVoiceProposalContract(repo, { knownGaps: [...] }).`,
  ).toEqual([]);
});
