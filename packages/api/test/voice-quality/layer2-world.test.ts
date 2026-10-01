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

import { buildLayer2ProcessorWorld, establishLayer2Caller } from '../../src/ai/voice-quality/layer2-world';
import { VoiceSessionStore, type VoiceSessionEvent } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
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

describe('#1331 — establishLayer2Caller (session establishment, as twilio-adapter does it)', () => {
  const tenantId = 't_caller_id';
  const customer = (id: string, phone: string): Customer =>
    ({
      id,
      tenantId,
      firstName: 'Fiona',
      lastName: 'Test',
      displayName: `Fiona ${id}`,
      primaryPhone: phone,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: 'seed',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }) as Customer;

  async function establish(customers: Customer[], callerId: string, callerIdBlocked = false) {
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create(tenantId, 'telephony', { callSid: `CA_${Math.random()}` });
    const events: VoiceSessionEvent[] = [];
    session.events.on('voice-event', (e: VoiceSessionEvent) => events.push(e));
    const customerRepo = new InMemoryCustomerRepository();
    for (const c of customers) await customerRepo.create(c);
    await establishLayer2Caller(session, { callerId, callerIdBlocked }, customerRepo);
    store.dispose();
    return { session, identityStamps: events.filter((e) => e.type === 'lookup_executed' && e.skillName === 'identify_caller_by_caller_id') };
  }

  it('a caller-ID matching exactly one customer identifies that customer and stamps the identity', async () => {
    const { session, identityStamps } = await establish([customer('c-1', '+15555550105')], '+15555550105');
    expect(session.customerId).toBe('c-1');
    expect(session.callerPhone).toBe('+15555550105');
    expect(identityStamps).toHaveLength(1);
  });

  it('an ambiguous, unknown or blocked caller-ID is never stamped', async () => {
    const twoAccounts = await establish([customer('c-1', '+15555550105'), customer('c-2', '+15555550105')], '+15555550105');
    const unknown = await establish([customer('c-1', '+15555550105')], '+15555550999');
    const blocked = await establish([customer('c-1', '+15555550105')], '+15555550105', true);
    for (const r of [twoAccounts, unknown, blocked]) {
      expect(r.session.customerId).toBeUndefined();
      expect(r.identityStamps).toHaveLength(0);
    }
  });
});
