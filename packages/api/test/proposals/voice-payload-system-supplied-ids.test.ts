/**
 * #1067 — a SYSTEM-SUPPLIED id is never an operator gate.
 *
 * `reviewId` (review_response_proposal) and `entityId` / `groundedProposalId`
 * (adopt_entity_alias) are chosen by the code that drafts the proposal — the
 * review picked from the reputation queue, the entity and proposal a
 * resolution already grounded. No operator can name them and no resolver can
 * lift them, so emitting one as `missingFields` mints a card nobody can ever
 * clear (#909's shape).
 *
 * The decision (owner, 2026-09-26): make that structural. The contract layer
 * declares these fields system-supplied, and the voice payload builder
 * refuses to turn a failure on one of them into a gate — the draft degrades
 * to a clarification instead (both live voice legs degrade on
 * `ok: false` + empty `missingFieldPaths`).
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';
import { isSystemSuppliedIdField } from '../../src/proposals/contracts';

const deps = { tenantId: 'tenant-1' };

describe('#1067 — system-supplied ids are never emitted as voice gates', () => {
  it('review_response_proposal missing its reviewId is NOT gated on reviewId (and not gateable at all)', async () => {
    const result = await buildVoiceProposalPayload(
      {
        intent: 'respond_to_review',
        proposalType: 'review_response_proposal',
        entities: { classification: 'positive' },
        envelope: { sessionId: 'sess-1' },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.missingFieldPaths).not.toContain('reviewId');
    // A partial gate on the OTHER fields would still leave an approve-to-fail
    // card with no reviewId — so the whole draft is not gateable.
    expect(result.missingFieldPaths).toEqual([]);
  });

  it('adopt_entity_alias missing entityId / groundedProposalId is not gateable', async () => {
    const result = await buildVoiceProposalPayload(
      {
        intent: undefined,
        proposalType: 'adopt_entity_alias',
        entities: { alias: 'the big house', entityKind: 'customer' },
        envelope: { sessionId: 'sess-1' },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.missingFieldPaths).not.toContain('entityId');
    expect(result.missingFieldPaths).not.toContain('groundedProposalId');
  });

  it('the declaration is per proposal type — the same key elsewhere is not system-supplied', () => {
    expect(isSystemSuppliedIdField('review_response_proposal', 'reviewId')).toBe(true);
    expect(isSystemSuppliedIdField('adopt_entity_alias', 'entityId')).toBe(true);
    expect(isSystemSuppliedIdField('adopt_entity_alias', 'groundedProposalId')).toBe(true);
    // An operator-nameable id is never swept in.
    expect(isSystemSuppliedIdField('create_appointment', 'jobId')).toBe(false);
    expect(isSystemSuppliedIdField('create_appointment', 'entityId')).toBe(false);
  });

  it('negative control: an operator-nameable gate on another type is unchanged', async () => {
    const result = await buildVoiceProposalPayload(
      {
        intent: 'create_appointment',
        proposalType: 'create_appointment',
        entities: {
          customerName: 'Jordan Lee',
          scheduledStart: '2026-09-03T12:00:00.000Z',
          scheduledEnd: '2026-09-03T13:00:00.000Z',
        },
        envelope: { sessionId: 'sess-1' },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.missingFieldPaths).toContain('customerId');
  });
});
