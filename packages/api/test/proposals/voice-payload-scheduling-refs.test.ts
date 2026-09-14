/**
 * SCH-D1/D2 — the resolved scheduling REFERENCES must survive the voice →
 * proposal payload translation.
 *
 * `buildVoiceProposalPayload` promotes scalars generically, so these ids ride
 * along "for free" — which is exactly why they need a test. The generic loop
 * is one `RESERVED_ENVELOPE_KEYS` entry away from silently dropping any of
 * them, and the symptom would be a proposal that reads correctly on the card
 * and then executes against nothing: an appointment booked with no
 * technician, a delay notice with no appointment to attach to.
 *
 * These are the payload-side halves of register cases book-02 (technicianId),
 * delay-01 and confirm-01 (appointmentId).
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const TENANT = 'tenant-payload';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const TECHNICIAN = '22222222-2222-4222-8222-222222222222';
const APPOINTMENT = '33333333-3333-4333-8333-333333333333';

describe('buildVoiceProposalPayload — resolved scheduling refs', () => {
  it('book-02: a resolved technicianId lands on the create_appointment payload and passes the contract', async () => {
    const built = await buildVoiceProposalPayload(
      {
        intent: 'create_appointment',
        proposalType: 'create_appointment',
        entities: {
          customerName: 'Garcia',
          customerId: CUSTOMER,
          technicianId: TECHNICIAN,
          jobTitle: 'HVAC install',
          scheduledStart: '2026-09-15T21:00:00.000Z',
          scheduledEnd: '2026-09-15T22:00:00.000Z',
        },
        envelope: { sessionId: 'sess-1' },
        confidence: 0.92,
      },
      { tenantId: TENANT },
    );

    expect(built.ok).toBe(true);
    expect(built.payload.technicianId).toBe(TECHNICIAN);
    expect(built.payload.customerId).toBe(CUSTOMER);
  });

  it('delay-01: a resolved appointmentId lifts notify_delay past its own contract gate', async () => {
    const withId = await buildVoiceProposalPayload(
      {
        intent: 'notify_delay',
        proposalType: 'notify_delay',
        entities: { customerName: 'Garcia', customerId: CUSTOMER, appointmentId: APPOINTMENT, delayMinutes: 20 },
        envelope: { sessionId: 'sess-1' },
      },
      { tenantId: TENANT },
    );
    expect(withId.ok).toBe(true);
    expect(withId.payload.appointmentId).toBe(APPOINTMENT);
    expect(withId.payload.delayMinutes).toBe(20);

    // The gate this closes: `notifyDelayPayloadSchema` requires
    // `appointmentId || appointmentReference`, so before the customer anchor
    // resolved one, "text Garcia that I'm running late" had NEITHER.
    const withoutId = await buildVoiceProposalPayload(
      {
        intent: 'notify_delay',
        proposalType: 'notify_delay',
        entities: { customerName: 'Garcia', customerId: CUSTOMER, delayMinutes: 20 },
        envelope: { sessionId: 'sess-1' },
      },
      { tenantId: TENANT },
    );
    expect(withoutId.ok).toBe(false);
  });

  it('confirm-01: a resolved appointmentId lands on the confirm_appointment payload', async () => {
    const built = await buildVoiceProposalPayload(
      {
        intent: 'confirm_appointment',
        proposalType: 'confirm_appointment',
        entities: { customerName: 'Garcia', customerId: CUSTOMER, appointmentId: APPOINTMENT },
        envelope: { sessionId: 'sess-1' },
      },
      { tenantId: TENANT },
    );
    expect(built.ok).toBe(true);
    expect(built.payload.appointmentId).toBe(APPOINTMENT);
  });

  it('an id that is not a uuid is NAMED as a missing field, never persisted as one', async () => {
    const built = await buildVoiceProposalPayload(
      {
        intent: 'notify_delay',
        proposalType: 'notify_delay',
        entities: { appointmentId: 'the Garcia visit', delayMinutes: 20 },
        envelope: { sessionId: 'sess-1' },
      },
      { tenantId: TENANT },
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.missingFieldPaths).toContain('appointmentId');
  });
});
