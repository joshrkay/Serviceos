/**
 * #1540 §1 — on the PHONE, "reschedule my appointment from Tuesday to
 * Wednesday at the same time" drafts the reschedule with the appointment's
 * own clock time on the new day (newScheduledStart / newScheduledEnd), so the
 * draft is not gated on a time the caller already gave.
 *
 * Seam: createVoiceTurnProcessor().speechTurn with a scripted gateway
 * (classifier + confirm_intent), the fixture entity resolver and in-memory
 * repos.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemorySettingsRepository, type TenantSettings } from '../../../src/settings/settings';
import { makeRepoBundle } from '../../../src/ai/voice-quality/runner';
import { fixtureEntityResolverForBundle } from '../../../src/ai/voice-quality/fixture-entity-resolver';
import type { Customer } from '../../../src/customers/customer';
import type { Job } from '../../../src/jobs/job';
import type { Appointment } from '../../../src/appointments/appointment';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-1540-resched';
const CALL_SID = 'CA-1540-resched';
const CALLER_ID = '+15555550202';
const LA = 'America/Los_Angeles';
const JANE = '00000000-0000-4000-8000-000015402001';
const JOB = '00000000-0000-4000-8000-000015402002';
const APPT = '00000000-0000-4000-8000-000015402003';
const NOW = () => new Date('2026-05-01T12:00:00.000Z');

function scriptedGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const saidYes = JSON.stringify(req.messages ?? '').includes('Yes, go ahead');
      return {
        content: isConfirm
          ? JSON.stringify({ answer: saidYes ? 'yes' : 'no', reasoning: 'scripted' })
          : classifier,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

describe('#1540 §1 — phone reschedule "to Wednesday at the same time"', () => {
  it('drafts Wednesday 2–4pm for the Tuesday 2–4pm appointment', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const repos = makeRepoBundle('memory');
    await repos.customerRepo.create({
      id: JANE, tenantId: TENANT, firstName: 'Jane', lastName: 'Smith', displayName: 'Jane Smith',
      primaryPhone: CALLER_ID, isArchived: false, createdBy: 'seed',
      createdAt: new Date('2026-01-15T10:00:00.000Z'), updatedAt: new Date('2026-01-15T10:00:00.000Z'),
    } as unknown as Customer);
    await repos.jobRepo.create({
      id: JOB, tenantId: TENANT, customerId: JANE, locationId: '00000000-0000-4000-8000-0000154020ff',
      jobNumber: 'JOB-0202', summary: 'AC service', status: 'scheduled', priority: 'normal', createdBy: 'seed',
      createdAt: new Date('2026-04-15T10:00:00.000Z'), updatedAt: new Date('2026-04-15T10:00:00.000Z'),
    } as unknown as Job);
    await repos.appointmentRepo.create({
      id: APPT, tenantId: TENANT, jobId: JOB,
      scheduledStart: new Date('2026-05-05T21:00:00.000Z'), scheduledEnd: new Date('2026-05-05T23:00:00.000Z'),
      timezone: LA, status: 'scheduled', createdBy: 'seed',
      createdAt: new Date('2026-04-15T10:00:00.000Z'), updatedAt: new Date('2026-04-15T10:00:00.000Z'),
    } as unknown as Appointment);
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({ tenantId: TENANT, timezone: LA } as unknown as TenantSettings);
    const proposalRepo = new InMemoryProposalRepository();

    const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: CALLER_ID, to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: JANE });
    session.customerId = JANE;
    session.callerPhone = CALLER_ID;

    const processor = createVoiceTurnProcessor({
      store,
      gateway: scriptedGateway(
        JSON.stringify({
          intentType: 'reschedule_appointment',
          confidence: 0.93,
          extractedEntities: {
            appointmentReference: 'my appointment on Tuesday',
            newDateTimeDescription: 'Wednesday at the same time',
          },
        }),
      ),
      businessName: 'Test HVAC Co',
      systemActorId: 'test-actor',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo: repos.customerRepo,
      appointmentRepo: repos.appointmentRepo,
      jobRepo: repos.jobRepo,
      settingsRepo,
      now: NOW,
      entityResolver: fixtureEntityResolverForBundle(repos, { tenantId: TENANT, timezone: LA, now: NOW }),
    });
    const turn = (speechResult: string) =>
      processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });

    await turn('I need to reschedule my appointment from Tuesday to Wednesday at the same time.');
    await turn('Yes, go ahead.');

    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.proposalType).toBe('reschedule_appointment');
    expect(proposal?.payload).toMatchObject({
      appointmentId: APPT,
      newScheduledStart: '2026-05-06T21:00:00.000Z',
      newScheduledEnd: '2026-05-06T23:00:00.000Z',
    });
  });
});
