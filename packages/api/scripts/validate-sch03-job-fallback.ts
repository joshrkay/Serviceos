/**
 * SCH-03 standalone validation — "cancel the upcoming appointment for that
 * job" fails today because resolveAppointment() only parses literal date
 * phrases and cancel_appointment never looks up a job. This script drives
 * the REAL InAppVoiceAdapter (the customer-calling FSM, the same
 * resolveSchedulingEntities/planVoiceEntityLookups wiring, and the same
 * PgEntityResolver-shaped resolver contract production uses) through a
 * realistic multi-turn call and asserts the fallback chain now resolves the
 * correct appointment instead of returning not_found.
 *
 * Turn 1 — "add a note to the water heater job" (add_note is a
 *          JOB_REF_INTENTS intent): resolves job-77 and stashes it on the
 *          FSM's sticky context.jobId (piece 2).
 * Turn 2 — "yes": confirms the note, proposal queued, FSM moves to closing.
 *          context.jobId survives (nothing in proposal_draft/closing
 *          touches it).
 * Turn 3 — "cancel the appointment for that job" spoken while still in
 *          closing: this is the FSM's second_intent_via_classify path,
 *          which discards the just-classified intent/entities and loops
 *          back to intent_capture WITHOUT resolving anything. This turn
 *          exists specifically to prove context.jobId survives that reset
 *          (piece 2's core claim) — if it didn't, turn 4 below would fail.
 * Turn 4 — the caller repeats "cancel the appointment for that job", now
 *          from intent_capture: classifies as cancel_appointment with
 *          appointmentReference "that job" (NOT a date phrase — parses to
 *          null). The chain is: date parse (fails) → context.jobId (job-77,
 *          survived turn 3) → job-scoped appointment lookup (piece 1) →
 *          resolved. Before this fix, this returned not_found and the FSM
 *          escalated to a human every time.
 *
 * Usage: npx tsx scripts/validate-sch03-job-fallback.ts   (run from packages/api)
 * Exits 0 on success, 1 on the first failing assertion.
 */
import { InAppVoiceAdapter } from '../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../src/proposals/proposal';
import { InMemoryAuditRepository } from '../src/audit/audit';
import { InMemoryOnCallRepository } from '../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../src/ai/gateway/gateway';
import type { EntityResolver, EntityResolverResult } from '../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-sch03-validate';
const USER = 'user-sch03-validate';
const JOB_ID = 'job-77';
const APPOINTMENT_ID = 'appt-321';

let failures = 0;
function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!ok) failures += 1;
}

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: async () => {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    },
  } as unknown as LLMGateway;
}

/**
 * Mirrors PgEntityResolver's resolve() contract exactly, including the
 * jobId parameter piece 1 adds. Only ever returns a resolved appointment
 * when jobId === JOB_ID is actually threaded through — proving the whole
 * chain (transitions.ts sticky jobId → entity-resolution.ts wiring →
 * resolver call) carries it end to end, not just one layer in isolation.
 */
function fakeProductionShapedResolver(): EntityResolver & { appointmentCalls: Array<{ reference: string; jobId?: string }> } {
  const appointmentCalls: Array<{ reference: string; jobId?: string }> = [];
  return {
    appointmentCalls,
    resolve: async (input): Promise<EntityResolverResult> => {
      if (input.kind === 'job' && input.reference === 'water heater job') {
        return {
          kind: 'resolved',
          candidate: { id: JOB_ID, kind: 'job', label: 'Water heater replacement', score: 0.95 },
        };
      }
      if (input.kind === 'appointment') {
        appointmentCalls.push({ reference: input.reference, jobId: input.jobId });
        // Same behavior as PgEntityResolver.resolveAppointment: "that job"
        // doesn't parse as a date, so only the jobId fallback can resolve it.
        if (input.jobId === JOB_ID) {
          return {
            kind: 'resolved',
            candidate: { id: APPOINTMENT_ID, kind: 'appointment', label: '2026-08-01T14:00:00.000Z', score: 1.0 },
          };
        }
        return { kind: 'not_found', reference: input.reference };
      }
      return { kind: 'not_found', reference: input.reference };
    },
  };
}

async function main() {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const onCallRepo = new InMemoryOnCallRepository();
  const resolver = fakeProductionShapedResolver();

  const gateway = scriptedGateway([
    // Turn 1 classify
    JSON.stringify({
      intentType: 'add_note',
      confidence: 0.93,
      extractedEntities: { jobReference: 'water heater job', noteText: 'Confirmed leak at the tank' },
    }),
    // Turn 3 classify (spoken mid-"closing" — discarded by second_intent_via_classify)
    JSON.stringify({
      intentType: 'cancel_appointment',
      confidence: 0.92,
      extractedEntities: { appointmentReference: 'that job' },
    }),
    // Turn 4 classify (caller repeats, now from intent_capture)
    JSON.stringify({
      intentType: 'cancel_appointment',
      confidence: 0.92,
      extractedEntities: { appointmentReference: 'that job' },
    }),
  ]);

  const adapter = new InAppVoiceAdapter({
    store,
    gateway,
    proposalRepo,
    auditRepo,
    onCallRepo,
    entityResolver: resolver,
  });

  const { sessionId } = await adapter.startSession(TENANT, USER);

  // Turn 1 — resolves job-77 and stashes context.jobId.
  const t1 = await adapter.handleInput(sessionId, 'add a note to the water heater job: confirmed leak at the tank');
  assertEqual(t1.state, 'intent_confirm', 'turn 1 lands at intent_confirm (job resolved)');
  const sessionAfterT1 = store.peek(sessionId);
  assertEqual(sessionAfterT1?.machine.currentContext.jobId, JOB_ID, 'turn 1 stashes context.jobId');

  // Turn 2 — caller confirms the note.
  const t2 = await adapter.handleInput(sessionId, 'yes');
  assertEqual(t2.state, 'closing', 'turn 2 confirms and reaches closing');
  const sessionAfterT2 = store.peek(sessionId);
  assertEqual(sessionAfterT2?.machine.currentContext.jobId, JOB_ID, 'context.jobId survives proposal_draft/closing');

  // Turn 3 — a second request mid-closing is discarded by
  // second_intent_via_classify (back to intent_capture with entities wiped)
  // — this turn exists to prove jobId is NOT wiped along with them.
  const proposalCountBeforeT3 = (await proposalRepo.findByTenant(TENANT)).length;
  const t3 = await adapter.handleInput(sessionId, 'cancel the appointment for that job');
  assertEqual(t3.state, 'intent_capture', 'turn 3 (mid-closing) resets to intent_capture');
  const proposalCountAfterT3 = (await proposalRepo.findByTenant(TENANT)).length;
  assertEqual(proposalCountAfterT3, proposalCountBeforeT3, 'turn 3 does not draft a NEW proposal (discarded second intent)');
  const sessionAfterT3 = store.peek(sessionId);
  assertEqual(sessionAfterT3?.machine.currentContext.jobId, JOB_ID, 'context.jobId survives the second_intent_via_classify reset');

  // Turn 4 — the caller repeats the same request from a clean intent_capture.
  // Before this fix: appointmentReference "that job" fails parseDateReference,
  // cancel_appointment never looked up a job, and resolveAppointment
  // returned not_found unconditionally → the FSM escalated to a human.
  const t4 = await adapter.handleInput(sessionId, 'cancel the appointment for that job');
  assertEqual(t4.state, 'intent_confirm', 'turn 4 resolves via the jobId fallback (NOT escalating)');
  const sessionAfterT4 = store.peek(sessionId);
  const appointmentId = (sessionAfterT4?.machine.currentContext.extractedEntities as Record<string, unknown> | undefined)
    ?.appointmentId;
  assertEqual(appointmentId, APPOINTMENT_ID, 'turn 4 resolves the correct appointment id');
  assertEqual(resolver.appointmentCalls.length, 1, 'the resolver was asked about the appointment exactly once');
  assertEqual(resolver.appointmentCalls[0]?.reference, 'that job', 'the appointment lookup carried the raw non-date reference');
  assertEqual(resolver.appointmentCalls[0]?.jobId, JOB_ID, 'the appointment lookup carried the sticky jobId fallback');

  store.dispose();

  console.log('');
  if (failures > 0) {
    console.log(`SCH-03 validation FAILED — ${failures} assertion(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('SCH-03 validation PASSED — job-scoped appointment fallback resolves "that job" end to end.');
  }
}

main().catch((err) => {
  console.error('SCH-03 validation crashed:', err);
  process.exitCode = 1;
});
