/**
 * D01 — `create_appointment`'s SCH-02 whole-object refine ("requires jobId
 * (or linkedJobId), or a customerId the executor can open a job for" —
 * proposals/contracts.ts `createAppointmentPayloadSchema`) has NO field
 * path: Zod stamps a root-level refine issue with `path: []`, so
 * `fieldPathsFrom` (voice-payload.ts) — which keeps only the first path
 * SEGMENT — silently dropped it. `missingFieldPaths` came back empty even
 * when this exact check failed, so a new-caller booking with a free-text
 * name and no resolvable customerId had nothing nameable to gate on.
 *
 * Live evidence: sweep row D01 (2026-08-30), a 3-turn in-app voice-session
 * booking ("I'd like to book a new customer..." / "Jordan Lee,
 * 480-555-0199..." / "It's for a furnace diagnostic..."), whose payload
 * carried `customerName: 'Jordan Lee'` as free text with no `customerId`
 * anywhere. Without a named gate, this either persisted unchanged (S2,
 * in-app) or degraded to a bare voice_clarification (S1, telephony) instead
 * of a reviewable draft — and a prior investigation had already observed
 * the downstream failure this produces: `CreateAppointmentExecutionHandler`
 * rejecting it at EXECUTION time with "Payload must include a valid jobId".
 *
 * This module-level fix detects the SAME condition proactively (not by
 * parsing Zod internals) and names it `customerId` — mirroring the existing
 * `locationId` gap (`ai/tasks/create-appointment-task.ts`
 * `detectServiceLocationGap`) — so BOTH live voice surfaces can gate the
 * draft with `missingFields` instead of guaranteeing an execution failure.
 * See ai/agents/customer-calling/inapp-adapter.ts and
 * ai/voice-turn/create-voice-turn-processor.ts for the two call sites that
 * thread `missingFieldPaths` into the persisted proposal.
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const deps = { tenantId: 'tenant-1' };

const input = (entities: Record<string, unknown>) => ({
  intent: 'create_appointment' as const,
  proposalType: 'create_appointment' as const,
  entities,
  envelope: { sessionId: 'sess-1' },
});

describe('D01 — create_appointment missing-customer gap is named, not dropped', () => {
  it('a new-caller booking (free-text customerName, no jobId/linkedJobId/customerId) fails the contract with missingFieldPaths: ["customerId"]', async () => {
    const result = await buildVoiceProposalPayload(
      input({
        customerName: 'Jordan Lee',
        scheduledStart: '2026-09-03T12:00:00.000Z',
        scheduledEnd: '2026-09-03T13:00:00.000Z',
        jobTitle: 'Furnace diagnostic inspection',
      }),
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingFieldPaths).toContain('customerId');
    }
  });

  it('a resolved customerId clears the gap (contract accepts it — SCH-02 auto-open-job path)', async () => {
    const result = await buildVoiceProposalPayload(
      input({
        customerId: '11111111-1111-1111-1111-111111111111',
        scheduledStart: '2026-09-03T12:00:00.000Z',
        scheduledEnd: '2026-09-03T13:00:00.000Z',
        jobTitle: 'Furnace diagnostic inspection',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // customerId must not itself be reported missing once it's present.
      expect((result.payload as { customerId?: string }).customerId).toBe(
        '11111111-1111-1111-1111-111111111111',
      );
    }
  });

  it('a resolved jobId (existing job — no customer needed) clears the gap too', async () => {
    const result = await buildVoiceProposalPayload(
      input({
        jobId: '22222222-2222-2222-2222-222222222222',
        scheduledStart: '2026-09-03T12:00:00.000Z',
        scheduledEnd: '2026-09-03T13:00:00.000Z',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it('other proposal types never trip this create_appointment-specific gap', async () => {
    // create_standing_instruction has no customerId concept at all — a
    // payload missing `instruction` should fail on THAT field, never pick up
    // a spurious 'customerId' from this create_appointment-scoped check.
    const result = await buildVoiceProposalPayload(
      {
        intent: 'create_standing_instruction',
        proposalType: 'create_standing_instruction',
        entities: {},
        envelope: { sessionId: 'sess-1' },
      },
      deps,
    );
    if (!result.ok) {
      expect(result.missingFieldPaths).not.toContain('customerId');
    }
  });
});
