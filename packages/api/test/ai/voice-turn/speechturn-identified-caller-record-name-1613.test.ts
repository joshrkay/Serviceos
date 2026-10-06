/**
 * #1613 — a caller the line already identified by caller-ID is their CRM
 * record, not whatever the speech recogniser heard their name as.
 *
 * Layer 2 run 37323734649 (create-appointment-known-customer): Jane Smith,
 * identified by caller-ID, heard her booking read back "for James Smith".
 * The readback and the draft took `customerName` straight from the
 * classifier's transcript. For a caller who IS a known record, the record's
 * name is the truth: the readback speaks it and the draft carries it. The
 * transcribed name never replaces anything on the record.
 *
 * Seam: createVoiceTurnProcessor().speechTurn on the customer line (S1) with
 * a scripted classifier + confirm_intent and in-memory repos; the readback is
 * checked as the transcript line AND as a transport renders it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemorySettingsRepository, type TenantSettings } from '../../../src/settings/settings';
import { renderTtsText } from '../../../src/ai/agents/customer-calling/tts-copy';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import type { EntityResolver } from '../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1613-record-name';
const CALL_SID = 'CA-1613-record-name';
const JANE_PHONE = '+15555550201';

/** The classifier heard "James" for "Jane"; the yes/no model hears the yes. */
const HEARD_JAMES = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.95,
  extractedEntities: { customerName: 'James Smith', dateTimeDescription: 'next Tuesday at 2pm' },
});

function scriptedGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const saidYes = JSON.stringify(req.messages ?? '').includes("Yes, that's right");
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

function lastReadback(effects: SideEffect[]): { recorded: string; heard: string } {
  const fx = effects.filter((e) => e.type === 'tts_play').pop();
  if (!fx) throw new Error('no tts_play');
  return { recorded: String(fx.payload.text), heard: renderTtsText(String(fx.payload.text), fx.payload, 'en') };
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function callFrom(opts: { ownerLine?: boolean; alsoJames?: boolean }) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const customerRepo = new InMemoryCustomerRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    tenantId: TENANT,
    timezone: 'America/Los_Angeles',
    businessHoursSchedule: [],
  } as unknown as TenantSettings);
  const jane = await createCustomer(
    { tenantId: TENANT, firstName: 'Jane', lastName: 'Smith', primaryPhone: JANE_PHONE, createdBy: 'seed' },
    customerRepo,
  );
  // A tenant that also has a James Smith, and a resolver (as app.ts wires
  // PgEntityResolver) that finds him by name — the heard name must never be
  // looked up against other customers for an identified caller.
  let entityResolver: EntityResolver | undefined;
  if (opts.alsoJames) {
    const james = await createCustomer(
      { tenantId: TENANT, firstName: 'James', lastName: 'Smith', primaryPhone: '+15555550999', createdBy: 'seed' },
      customerRepo,
    );
    entityResolver = {
      resolve: async ({ kind, reference }) =>
        kind === 'customer' && /james/i.test(reference)
          ? { kind: 'resolved', candidate: { id: james.id, kind: 'customer', label: 'James Smith', score: 1 } }
          : { kind: 'not_found', reference },
    } as EntityResolver;
  }
  const session = store.create(TENANT, 'telephony', {
    callSid: CALL_SID,
    ...(opts.ownerLine ? { ownerSession: true } : {}),
  });
  session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: JANE_PHONE, to: '+15125550999', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: jane.id });
  session.customerId = jane.id;
  session.callerPhone = JANE_PHONE;
  if (opts.ownerLine) session.actorUserId = 'vq-owner:tenant-1613';
  const processor = createVoiceTurnProcessor({
    store,
    gateway: scriptedGateway(HEARD_JAMES),
    businessName: 'Test HVAC Co',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
    settingsRepo,
    ...(entityResolver ? { entityResolver } : {}),
    now: () => new Date('2026-05-01T12:00:00.000Z'),
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });
  return { session, turn, proposalRepo, customerRepo, jane };
}

describe('#1613 — an identified caller is read back and drafted by their record name', () => {
  it("speaks the CRM record's name in the readback, never the transcribed one", async () => {
    const { session, turn } = await callFrom({});

    const readback = lastReadback(
      await turn("Hi, this is Jane Smith. I'd like to schedule a service appointment for next Tuesday at 2pm."),
    );

    expect(session.machine.currentState).toBe('intent_confirm');
    const expected =
      "Just to confirm — you'd like to schedule an appointment for Jane Smith, next Tuesday at 2pm. Is that right?";
    expect(readback.recorded).toBe(expected);
    expect(readback.heard).toBe(expected);
  });

  it("drafts the booking for the record (its id and name); the heard name replaces nothing on the record", async () => {
    const { turn, proposalRepo, customerRepo, jane } = await callFrom({});
    await turn("Hi, this is Jane Smith. I'd like to schedule a service appointment for next Tuesday at 2pm.");

    await turn("Yes, that's right.");

    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.proposalType).toBe('create_appointment');
    expect(proposal?.payload).toMatchObject({ customerId: jane.id, customerName: 'Jane Smith' });
    expect((await customerRepo.findById(TENANT, jane.id))?.displayName).toBe('Jane Smith');
  });

  it('binds the draft to the caller even when the heard name is another real customer', async () => {
    const { turn, proposalRepo, jane } = await callFrom({ alsoJames: true });
    await turn("Hi, this is Jane Smith. I'd like to schedule a service appointment for next Tuesday at 2pm.");

    await turn("Yes, that's right.");

    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.payload).toMatchObject({ customerId: jane.id, customerName: 'Jane Smith' });
  });

  it('the owner line keeps the spoken name — there the owner names someone else', async () => {
    const { turn } = await callFrom({ ownerLine: true });

    const readback = lastReadback(await turn('Schedule an appointment for James Smith next Tuesday at 2pm.'));

    expect(readback.heard).toContain('for James Smith');
  });
});
