/**
 * #1331 (Layer 2 create-service-agreement) — the contract gate reads the SAME
 * clock the payload was filled from. The payload resolved "starts next month"
 * on the processor clock while `startsOn must not be in the past` compared
 * against the wall clock, so a pinned-clock call (the voice-quality corpus
 * world, 2026-05-01) gated a start date that was in its future. In production
 * both clocks are the wall clock, so behaviour there is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';
import { validateProposalPayload } from '../../src/proposals/contracts';

const LA = 'America/Los_Angeles';

function agreementInput(entities: Record<string, unknown>) {
  return {
    intent: 'create_service_agreement',
    proposalType: 'create_service_agreement' as const,
    entities,
    envelope: { sessionId: 'sess-1331' },
    callerCustomerId: '11111111-1111-4111-8111-111111111111',
  };
}

describe('#1331 — the start-date gate follows the payload clock', () => {
  it('a start date in the future of the processor clock is not gated, even when the wall clock is past it', async () => {
    // The corpus world: Friday 2026-05-01 — before any wall clock this runs on.
    const built = await buildVoiceProposalPayload(
      agreementInput({ name: 'HVAC tune-up plan', priceCents: 15000, serviceAgreementCadence: 'quarterly' }),
      { tenantId: 't-1331', timezone: LA, now: () => new Date('2026-05-01T12:00:00.000Z') },
    );

    expect(built.payload.startsOn).toBe('2026-06-01');
    expect(built.ok).toBe(true);
    expect(built.missingFieldPaths).not.toContain('startsOn');
  });

  it('the same clock still gates a start date that is behind it (nothing loosened)', () => {
    const result = validateProposalPayload(
      'create_service_agreement',
      {
        customerId: '11111111-1111-4111-8111-111111111111',
        name: 'HVAC tune-up plan',
        recurrenceRule: 'FREQ=MONTHLY;INTERVAL=3',
        priceCents: 15000,
        startsOn: '2026-04-30',
      },
      { now: () => new Date('2026-05-01T12:00:00.000Z') },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('startsOn: startsOn must not be in the past');
  });
});
