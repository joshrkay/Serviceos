/**
 * #845 — `create_standing_instruction` classifier→contract key alias.
 *
 * The classifier emits `instructionText` (`ai/orchestration/intent-classifier.ts`,
 * `ExtractedEntities.instructionText`). The contract requires `instruction`
 * (`proposals/contracts/standing-instruction.ts`). Without an alias in the
 * single flat-payload builder, every spoken standing instruction lands in the
 * missing-fields path and can never be approved — the capability is listed as
 * shipped but is unreachable end to end.
 *
 * This mirrors the aliases already in `voice-payload.ts` section 2
 * (`displayName → name`, `sendChannel → channel`, `jobTitle → title`).
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const deps = { tenantId: 'tenant-1' };

const input = (entities: Record<string, unknown>) => ({
  intent: 'create_standing_instruction' as const,
  proposalType: 'create_standing_instruction' as const,
  entities,
  envelope: { sessionId: 'sess-1' },
});

describe('#845 — create_standing_instruction payload alias', () => {
  it('promotes the classifier\'s instructionText onto the contract\'s instruction', async () => {
    const result = await buildVoiceProposalPayload(
      input({ instructionText: 'Always call before arriving at the Henderson place' }),
      deps,
    );
    expect(result.payload.instruction).toBe('Always call before arriving at the Henderson place');
  });

  it('produces a payload the contract accepts, so it can be approved', async () => {
    // The end-to-end point of the fix. Before it, this returned
    // ok:false with errors ['instruction: Required'] — the payload was
    // born unapprovable, which is why the capability never worked.
    const result = await buildVoiceProposalPayload(
      input({ instructionText: 'Never schedule the Okafor job before 10am' }),
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it('does not overwrite an explicit instruction when both are present', async () => {
    // Matches the precedence of every other alias: explicit contract key wins.
    const result = await buildVoiceProposalPayload(
      input({ instruction: 'explicit wins', instructionText: 'alias loses' }),
      deps,
    );
    expect(result.payload.instruction).toBe('explicit wins');
  });

  it('leaves instruction unset when the classifier emitted nothing', async () => {
    const result = await buildVoiceProposalPayload(input({}), deps);
    expect(result.payload.instruction).toBeUndefined();
  });
});
