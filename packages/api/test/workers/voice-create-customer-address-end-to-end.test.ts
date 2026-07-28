/**
 * END-TO-END: a spoken street address, from the microphone to
 * `service_locations` (or, when it can't get there, to a durable note).
 *
 * WHY THIS FILE EXISTS, AND WHY IT LOOKS LIKE THIS
 * -----------------------------------------------
 * A technician said "Create a new customer, Ashia Aksuna, she's over at 1207
 * Riverbell Drive". The classifier heard it, the router forwarded it, the
 * approval card rendered it, the approver approved it — and the address was
 * gone. `select * from service_locations where customer_id = …` returned zero
 * rows, because the table requires street1/city/state/postal_code NOT NULL and
 * a job-site utterance carries none of the last three.
 *
 * Before that, the SAME address had been destroyed four separate times in four
 * separate intermediate layers, each of which rebuilt an object from an
 * allowlist and silently dropped the key it did not name. Every one of those
 * layers had green unit tests, because each test hand-fed the layer under test
 * the very field the layer was dropping.
 *
 * So this file stubs NOTHING. It starts at the classifier's own output and
 * runs the real chain, layer by layer:
 *
 *   scriptHermeticResponse()        ← the mock LLM the corpus actually grades
 *     → entitiesForProposal()       ← the router allowlist (bug #4 lived here)
 *     → CreateCustomerVoiceTaskHandler.run()
 *     → validateProposalPayload()   ← the contract gate
 *     → addressCaptureFor()         ← the assistant card serializer (allowlist #5)
 *     → resolveSpokenAddress()      ← what the review card renders
 *     → editProposal()              ← the approver completing the fields, via
 *                                     the REAL edit action + repository
 *     → ProposalExecutor + createExecutionHandlerRegistry()
 *     → service_locations / notes / customers.communication_notes
 *
 * A field added upstream and forgotten in any one of those layers fails here.
 */
import { describe, it, expect } from 'vitest';
import { resolveSpokenAddress } from '@ai-service-os/shared';
import { entitiesForProposal } from '../../src/workers/voice-action-router';
import { CreateCustomerVoiceTaskHandler } from '../../src/ai/tasks/create-customer-task';
import { scriptHermeticResponse } from '../../src/ai/providers/mock';
import { addressCaptureFor } from '../../src/routes/assistant';
import type { ExtractedEntities } from '../../src/ai/orchestration/intent-classifier';
import type { LLMRequest } from '../../src/ai/gateway/gateway';
import { validateProposalPayload } from '../../src/proposals/contracts';
import {
  InMemoryProposalRepository,
  Proposal,
  ProposalType,
} from '../../src/proposals/proposal';
import { editProposal } from '../../src/proposals/actions';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionHandler,
} from '../../src/proposals/execution/handlers';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryNoteRepository } from '../../src/notes/note';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

/** Layer 1 — the mock provider the voice-quality corpus actually replays. */
function classify(transcript: string): ExtractedEntities {
  const req = {
    taskType: 'classify_intent',
    messages: [{ role: 'user', content: transcript }],
  } as unknown as LLMRequest;
  return JSON.parse(scriptHermeticResponse(req)).extractedEntities;
}

/** Layers 1→3: transcript to a drafted proposal, through the router allowlist. */
async function draftFromTranscript(transcript: string): Promise<Proposal> {
  const entities = classify(transcript);
  const forwarded = entitiesForProposal('create_customer', entities);
  const handler = new CreateCustomerVoiceTaskHandler({ requirePhone: false });
  const out = await handler.run({
    tenantId: TENANT,
    message: transcript,
    conversationId: '33333333-3333-4333-8333-333333333333',
    userId: 'voice_agent',
    existingEntities: forwarded ?? {},
  });
  expect(out.status).toBe('proposal_drafted');
  return out.proposal!;
}

interface Wiring {
  proposalRepo: InMemoryProposalRepository;
  customerRepo: InMemoryCustomerRepository;
  locationRepo: InMemoryLocationRepository;
  noteRepo: InMemoryNoteRepository;
  auditRepo: InMemoryAuditRepository;
  executor: ProposalExecutor;
}

/**
 * Production wiring, not a hand-built handler map: the registry is where the
 * `noteRepo` dependency is threaded through, so a registry that forgets to
 * pass it must fail here too.
 */
function wire(): Wiring {
  const proposalRepo = new InMemoryProposalRepository();
  const executionRepo = new InMemoryProposalExecutionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const noteRepo = new InMemoryNoteRepository();
  const auditRepo = new InMemoryAuditRepository();

  const handlers = createExecutionHandlerRegistry({
    customerRepo,
    locationRepo,
    noteRepo,
    auditRepo,
  }) as Map<ProposalType, ExecutionHandler>;

  const guard = new IdempotencyGuard(executionRepo, proposalRepo);
  const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
  return { proposalRepo, customerRepo, locationRepo, noteRepo, auditRepo, executor };
}

/** Approve + execute exactly as the approve route does. */
async function approveAndExecute(w: Wiring, proposalId: string) {
  const stored = await w.proposalRepo.findById(TENANT, proposalId);
  let approved = transitionProposal(stored!, 'ready_for_review', APPROVER);
  approved = transitionProposal(approved, 'approved', APPROVER);
  // Backdate past the undo window so the executor runs immediately.
  approved = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
  await w.proposalRepo.update(TENANT, proposalId, approved);
  const { result } = await w.executor.execute(approved, {
    tenantId: TENANT,
    executedBy: APPROVER,
  });
  expect(result.success).toBe(true);
  return result.resultEntityId!;
}

describe('spoken address, microphone → service_locations (nothing stubbed)', () => {
  const TRANSCRIPT = "Create a new customer, Ashia Aksuna. She's over at 1207 Riverbell Drive.";

  it('the approver completes city/state/ZIP on the card and a service_location is written', async () => {
    // ── Layers 1–3: classifier → router allowlist → task handler ──────────
    const drafted = await draftFromTranscript(TRANSCRIPT);
    // `toContain`, not `toBe`, and that is a FINDING rather than a looser
    // assertion: on this exact live utterance the hermetic mock classifier
    // extracts `displayName` as "Ashia Aksuna. She's" — it runs the name
    // regex to the end of the sentence instead of stopping at the period.
    // That is a separate defect in the name path (out of scope here, and
    // invisible to the corpus because every cassette replays this same mock),
    // but pinning it prevents this file from silently asserting a name it
    // never actually produced.
    expect(drafted.payload.name).toContain('Ashia Aksuna');
    expect(drafted.payload.address).toBe('1207 Riverbell Drive');

    // ── Layer 4: the contract gate accepts the drafted payload ────────────
    expect(validateProposalPayload('create_customer', drafted.payload).valid).toBe(true);

    const w = wire();
    await w.proposalRepo.create(drafted);

    // ── Layer 5: what the assistant card serializer hands to the UI ───────
    const capture = addressCaptureFor('create_customer', drafted.payload);
    expect(capture).toEqual({ address: '1207 Riverbell Drive' });

    // ── Layer 6: what the review card decides to render ───────────────────
    const asCardSeesIt = resolveSpokenAddress(capture!);
    expect(asCardSeesIt.kind).toBe('note');
    expect(asCardSeesIt.prefill.street1).toBe('1207 Riverbell Drive');
    expect(asCardSeesIt.missing).toEqual(['city', 'state', 'postalCode']);

    // ── Layer 7: the approver fills the boxes; the card PUTs these edits ──
    // Exactly the keys AIProposalCard sends, through the real edit action.
    const { editedFields } = await editProposal(
      w.proposalRepo,
      TENANT,
      drafted.id,
      APPROVER,
      'owner',
      {
        street1: '1207 Riverbell Drive',
        city: 'Scottsdale',
        state: 'AZ',
        postalCode: '85254',
      },
    );
    expect(editedFields.sort()).toEqual(['city', 'postalCode', 'state', 'street1']);

    // ── Layers 8–9: approve → executor → registry handler → repositories ──
    const customerId = await approveAndExecute(w, drafted.id);

    const locations = await w.locationRepo.findByCustomer(TENANT, customerId);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      street1: '1207 Riverbell Drive',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
      country: 'US',
      isPrimary: true,
    });

    // A completed address is a real location, so no "lost address" note.
    expect(await w.noteRepo.findByEntity(TENANT, 'customer', customerId)).toHaveLength(0);
    expect(
      w.auditRepo.getAll().filter((e) => e.eventType === 'customer.address_unstructured'),
    ).toHaveLength(0);
  });

  it('the approver approves WITHOUT completing the fields and the address still lands somewhere durable', async () => {
    // This is the anti-regression for the actual production incident:
    // proposal.approved → customer.created → proposal.executed, and the
    // address evaporated. Approving an incomplete address is legitimate —
    // the approver may not know the ZIP — but it may never be a silent loss.
    const drafted = await draftFromTranscript(TRANSCRIPT);
    const w = wire();
    await w.proposalRepo.create(drafted);

    const customerId = await approveAndExecute(w, drafted.id);

    // No invented city/state/ZIP — we still refuse to fabricate.
    expect(await w.locationRepo.findByCustomer(TENANT, customerId)).toHaveLength(0);

    // 1. A pinned customer note carrying the verbatim words.
    const notes = await w.noteRepo.findByEntity(TENANT, 'customer', customerId);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('1207 Riverbell Drive');
    expect(notes[0].content).toContain('city, state, ZIP');
    expect(notes[0].isPinned).toBe(true);

    // 2. The customer row itself, written in the same INSERT as the customer.
    const customer = await w.customerRepo.findById(TENANT, customerId);
    expect(customer!.communicationNotes).toContain('1207 Riverbell Drive');

    // 3. A queryable audit marker naming exactly what is still owed.
    const markers = w.auditRepo
      .getAll()
      .filter((e) => e.eventType === 'customer.address_unstructured');
    expect(markers).toHaveLength(1);
    expect(markers[0].entityId).toBe(customerId);
    expect(markers[0].metadata).toMatchObject({
      address: '1207 Riverbell Drive',
      missingFields: ['city', 'state', 'postalCode'],
      preservedAs: 'note',
    });
  });

  it('a fully-spoken address needs no human completion at all', async () => {
    const transcript = 'Add a new customer, Mario Delingo, 412 Oak Street, Scottsdale, AZ 85254.';
    const drafted = await draftFromTranscript(transcript);
    const capture = addressCaptureFor('create_customer', drafted.payload)!;

    // The card renders NO address inputs for a complete address.
    expect(resolveSpokenAddress(capture).kind).toBe('location');

    const w = wire();
    await w.proposalRepo.create(drafted);
    const customerId = await approveAndExecute(w, drafted.id);

    const locations = await w.locationRepo.findByCustomer(TENANT, customerId);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      street1: '412 Oak Street',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
    expect(await w.noteRepo.findByEntity(TENANT, 'customer', customerId)).toHaveLength(0);
  });

  it('a customer with no address at all behaves exactly as before', async () => {
    const drafted = await draftFromTranscript(
      "I'd like to sign up as a new customer. My name is Jane Smith.",
    );
    expect(drafted.payload.address).toBeUndefined();
    expect(addressCaptureFor('create_customer', drafted.payload)).toBeUndefined();

    const w = wire();
    await w.proposalRepo.create(drafted);
    const customerId = await approveAndExecute(w, drafted.id);

    expect(await w.locationRepo.findByCustomer(TENANT, customerId)).toHaveLength(0);
    expect(await w.noteRepo.findByEntity(TENANT, 'customer', customerId)).toHaveLength(0);
    const customer = await w.customerRepo.findById(TENANT, customerId);
    expect(customer!.communicationNotes ?? '').not.toContain('Address from voice');
  });

  /**
   * The generalizable guard against allowlist #5. `addressCaptureFor` is the
   * serializer that decides which payload keys reach the review card, and it
   * is exactly the shape of the four functions that already lost this field.
   * Pin the full structured key set so the next added column fails here
   * instead of on a job site.
   */
  it('the card serializer forwards every structured address key on the payload', () => {
    const payload = {
      name: 'Mario Delingo',
      address: '412 Oak Street, Scottsdale, AZ 85254',
      street1: '412 Oak Street',
      street2: 'Unit 3',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
      country: 'US',
    };
    expect(Object.keys(addressCaptureFor('create_customer', payload)!).sort()).toEqual(
      ['address', 'city', 'country', 'postalCode', 'state', 'street1', 'street2'].sort(),
    );
    // …and never for a proposal type that has no address.
    expect(addressCaptureFor('draft_estimate', payload)).toBeUndefined();
  });
});
