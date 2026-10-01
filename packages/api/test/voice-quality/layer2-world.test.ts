/**
 * #1331 — the Layer 2 harness wires the production voice-turn processor the
 * way app.ts does, from the script's fixtures.
 *
 * Run 36829085635's Layer 2 processor had no settings repo (so no tenant
 * zone: every spoken time stayed unresolved — "scheduledStart: Required"),
 * no on-call rotation ("notify_oncall (oncall/audit repos not wired)"), and
 * the wall clock, against a corpus authored in a pinned world (Layer 1 pins
 * 2026-05-01T12:00Z): appointments in May/June 2026 were "not upcoming".
 */
import { describe, expect, it } from 'vitest';

import { buildLayer2ProcessorWorld } from '../../src/ai/voice-quality/layer2-world';
import { loadLayer2Corpus } from '../../src/ai/voice-quality/corpus/loader';
import { runScript, type RepoBundle } from '../../src/ai/voice-quality/runner';

describe('#1331 — buildLayer2ProcessorWorld', () => {
  it('gives the processor the fixture tenant zone, an on-call dispatcher and the corpus clock', async () => {
    const script = loadLayer2Corpus().find((s) => s.id === 'create-appointment-known-customer')!;
    const world = buildLayer2ProcessorWorld(script, 't_02_create_appointment');

    expect((await world.settingsRepo.findByTenant('t_02_create_appointment'))?.timezone).toBe(
      'America/Los_Angeles',
    );
    expect(await world.onCallRepo.getNextOnCall('t_02_create_appointment')).not.toBeNull();
    expect(world.now().toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  it.each([
    { id: 'cancel-appointment-known-customer', reference: 'my appointment on Tuesday', anchored: true },
    { id: 'reschedule-appointment-known-customer', reference: 'my appointment on Tuesday', anchored: true },
    { id: 'confirm-appointment-known-customer', reference: "tomorrow's appointment", anchored: true },
    { id: 'notify-delay-known-customer', reference: 'the customer on the 10am', anchored: false },
  ])(
    '#1540 §1 — $id: the world\'s entity resolver finds the fixture appointment the caller means',
    async ({ id, reference, anchored }) => {
      const script = loadLayer2Corpus().find((s) => s.id === id)!;
      const expectedAppointmentId = script.turns[0]!.expected.slots!.appointmentId as string;
      // The runner seeds the bundle from the fixtures exactly as a Layer 2 run
      // does; the driver is a no-op — only the seeded repos matter here.
      let repos: RepoBundle | undefined;
      await runScript(
        { ...script, turns: [] },
        {
          repoMode: 'memory',
          driverFactory: (ctx) => {
            repos = ctx.repos;
            return {
              startSession: async () => ({ sessionId: 's-1540' }),
              speak: async () => ({ agentResponse: '', latencyMs: 0 }),
              hangup: async () => {},
              endSession: async () => {},
            };
          },
        },
      );
      const scriptTenantId = (script.fixtures.tenant as { id: string }).id;
      const world = buildLayer2ProcessorWorld(script, scriptTenantId, repos!);
      const callerCustomerId = (script.fixtures.customers as Array<{ id: string }>)[0]!.id;

      const result = await world.entityResolver!.resolve({
        tenantId: scriptTenantId,
        reference,
        kind: 'appointment',
        ...(anchored ? { customerId: callerCustomerId } : {}),
      });

      expect(result.kind === 'resolved' && result.candidate.id).toBe(expectedAppointmentId);
    },
  );

  it('a script that pins its call moment (business hours) runs at that moment', () => {
    const script = loadLayer2Corpus().find((s) => s.id === 'lookup-catalog-empty')!;
    const pinned = {
      ...script,
      fixtures: {
        ...script.fixtures,
        tenant: {
          ...(script.fixtures.tenant as Record<string, unknown>),
          businessHours: { timezone: 'America/Phoenix', schedule: [], callMomentLocal: '2026-05-04T22:00:00-07:00' },
        },
      },
    };
    const world = buildLayer2ProcessorWorld(pinned, 't_01_lookup_catalog');
    expect(world.now().toISOString()).toBe('2026-05-05T05:00:00.000Z');
  });
});
