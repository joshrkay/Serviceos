/**
 * #1272 — a live voice cancel must not mint an approve-to-fail draft.
 *
 * SCH-03 (dev, 2026-09-19): "Cancel my upcoming appointment please — I need
 * to reschedule it for a later date" → confirmed → cancel_appointment proposal
 * with `missingFields: ["cancellationType"]`, and `POST /approve` 400'd
 * ("unfilled required fields: cancellationType"). The memo/chat leg
 * (`CancelAppointmentTaskHandler`, ai/tasks/voice-extended-tasks.ts) has
 * always stamped `cancellationType: ee.cancellationType ?? 'other'` and
 * `reason: ee.cancellationReason ?? <utterance>`; the shared live-turn
 * builder did neither, so the two legs drifted.
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const TENANT = 'tenant-payload';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT = '33333333-3333-4333-8333-333333333333';

async function buildCancel(entities: Record<string, unknown>, utterance?: string) {
  return buildVoiceProposalPayload(
    {
      intent: 'cancel_appointment',
      proposalType: 'cancel_appointment',
      entities: { customerId: CUSTOMER, appointmentId: APPOINTMENT, ...entities },
      envelope: { sessionId: 'sess-1' },
      ...(utterance ? { utterance } : {}),
    },
    { tenantId: TENANT },
  );
}

describe('buildVoiceProposalPayload — cancel_appointment defaults (#1272)', () => {
  it('SCH-03: a stated reason with no cancellationType yields an approvable payload (memo-leg default)', async () => {
    const built = await buildCancel({
      appointmentReference: 'upcoming appointment',
      cancellationReason: 'I need to reschedule it for a later date',
    });

    expect(built.missingFieldPaths).not.toContain('cancellationType');
    expect(built.ok).toBe(true);
    expect(built.payload.cancellationType).toBe('other');
    expect(built.payload.reason).toBe('I need to reschedule it for a later date');
  });

  it('keeps a classifier-extracted cancellationType instead of the default', async () => {
    const built = await buildCancel({
      cancellationType: 'customer_request',
      cancellationReason: 'customer called out',
    });
    expect(built.ok).toBe(true);
    expect(built.payload.cancellationType).toBe('customer_request');
  });

  it('falls back to the spoken request as the reason, like the memo leg', async () => {
    const built = await buildCancel({}, 'Cancel the Johnson appointment');
    expect(built.ok).toBe(true);
    expect(built.payload.reason).toBe('Cancel the Johnson appointment');
  });
});
