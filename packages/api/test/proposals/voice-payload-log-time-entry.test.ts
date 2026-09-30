/**
 * #1018 row 5.3 — `log_time_entry` classifier→contract key alias on the live
 * voice turn (phone + in-app adapters share `buildVoiceProposalPayload`).
 *
 * The classifier emits `timeEntryType` (`ExtractedEntities.timeEntryType`);
 * `logTimeEntryPayloadSchema` requires `entryType`. Found by the 5.3 in-app
 * reachability run: "log two hours on the Garcia job" drafted a card the
 * owner could never approve ("Needs: entryType"). The memo/chat leg
 * (`LogTimeEntryTaskHandler`) already maps it, defaulting to 'job'.
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const deps = { tenantId: 'tenant-1' };
const JOB_ID = '11111111-1111-4111-8111-111111111111';

const input = (entities: Record<string, unknown>) => ({
  intent: 'log_time_entry' as const,
  proposalType: 'log_time_entry' as const,
  entities,
  envelope: { sessionId: 'sess-1' },
});

describe('#1018 5.3 — log_time_entry payload alias', () => {
  it("promotes the classifier's timeEntryType onto the contract's entryType, so the draft is approvable", async () => {
    const result = await buildVoiceProposalPayload(
      input({ timeEntryType: 'job', durationMinutes: 120, jobReference: 'Garcia', jobId: JOB_ID }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ entryType: 'job', durationMinutes: 120, jobId: JOB_ID });
    expect(result.missingFieldPaths).toEqual([]);
  });
});
