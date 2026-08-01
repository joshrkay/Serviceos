/**
 * Regression: create_customer field capture across the ROUTER BOUNDARY.
 *
 * Why this file exists.
 *
 * The first attempt at the dropped-address fix shipped tests that handed
 * entities straight to `CreateCustomerVoiceTaskHandler.run()`:
 *
 *     handler.run({ existingEntities: { displayName: 'x', address: 'y' } })
 *
 * That proved the task handler could carry an address. It could not, and did
 * not, prove anything about how entities REACH the task handler — and on the
 * voice-worker path (uploaded audio, the surface the live failure came from)
 * they arrive via `entitiesForProposal`, an allowlist that rebuilt the entity
 * bag from scratch and silently dropped every key it did not name. The fix
 * passed unit tests and changed nothing live.
 *
 * So these tests start where the classifier's output starts and run the real
 * translation chain:
 *
 *     classifier entities
 *       → entitiesForProposal()      ← the allowlist that dropped the address
 *       → TaskContext.existingEntities
 *       → CreateCustomerVoiceTaskHandler.run()
 *       → proposal.payload
 *
 * Nothing in between is stubbed. A field added to the classifier but not
 * forwarded by the allowlist fails here.
 */
import { describe, it, expect } from 'vitest';
import { entitiesForProposal } from '../../src/workers/voice-action-router';
import { CreateCustomerVoiceTaskHandler } from '../../src/ai/tasks/create-customer-task';
import { scriptHermeticResponse } from '../../src/ai/providers/mock';
import type { ExtractedEntities } from '../../src/ai/orchestration/intent-classifier';
import type { LLMRequest } from '../../src/ai/gateway/gateway';

const TENANT = 'tenant-1';
const SESSION = 'session-uuid-1';
const SYSTEM_USER = 'voice_agent';

/** Drive the full router→handler chain for one utterance's entities. */
async function payloadFor(entities: ExtractedEntities, transcript: string) {
  const handler = new CreateCustomerVoiceTaskHandler({ requirePhone: false });
  const forwarded = entitiesForProposal('create_customer', entities);
  const out = await handler.run({
    tenantId: TENANT,
    message: transcript,
    conversationId: SESSION,
    userId: SYSTEM_USER,
    existingEntities: forwarded ?? {},
  });
  return out;
}

describe('create_customer field capture — classifier entities through the router boundary', () => {
  const cases: ReadonlyArray<{
    transcript: string;
    entities: ExtractedEntities;
    expectedName: string;
    expectedAddress: string;
    expectedPhone?: string;
  }> = [
    {
      transcript: 'Add a new customer, Mario Delingo, 412 Oak Street, Scottsdale, 85254.',
      entities: {
        displayName: 'Mario Delingo',
        address: '412 Oak Street, Scottsdale, 85254',
      },
      expectedName: 'Mario Delingo',
      expectedAddress: '412 Oak Street, Scottsdale, 85254',
    },
    {
      transcript:
        'We have a new customer, Bill Roganowski, 88 Sycamore Lane, phone number is 555-0124.',
      entities: {
        displayName: 'Bill Roganowski',
        phone: '555-0124',
        address: '88 Sycamore Lane',
      },
      expectedName: 'Bill Roganowski',
      expectedAddress: '88 Sycamore Lane',
      expectedPhone: '555-0124',
    },
    {
      transcript: "Create a new customer, Ashia Aksuna. She's over at 1207 Riverbell Drive.",
      entities: { displayName: 'Ashia Aksuna', address: '1207 Riverbell Drive' },
      expectedName: 'Ashia Aksuna',
      expectedAddress: '1207 Riverbell Drive',
    },
    {
      transcript: "Add Jimmy Hartlett as a new customer. He's at 34 Quarry Street.",
      entities: { displayName: 'Jimmy Hartlett', address: '34 Quarry Street' },
      expectedName: 'Jimmy Hartlett',
      expectedAddress: '34 Quarry Street',
    },
    {
      transcript: "Add a new customer, nguyen, that's N-G-U-Y-E-N at 91 Fairway Avenue.",
      entities: { displayName: 'nguyen', address: '91 Fairway Avenue' },
      expectedName: 'Nguyen',
      expectedAddress: '91 Fairway Avenue',
    },
  ];

  for (const c of cases) {
    it(`address reaches the payload through entitiesForProposal: "${c.transcript}"`, async () => {
      const out = await payloadFor(c.entities, c.transcript);
      expect(out.status).toBe('proposal_drafted');
      expect(out.proposal!.payload.name).toBe(c.expectedName);
      // The live regression: entitiesForProposal dropped this, so the task
      // handler had nothing to read and the payload shipped without it.
      expect(out.proposal!.payload.address).toBe(c.expectedAddress);
      if (c.expectedPhone) expect(out.proposal!.payload.phone).toBe(c.expectedPhone);
    });
  }

  it('entitiesForProposal forwards the address (unit-level pin on the allowlist)', () => {
    expect(
      entitiesForProposal('create_customer', {
        displayName: 'Mario Delingo',
        address: '412 Oak Street, Scottsdale, 85254',
      })
    ).toEqual({
      name: 'Mario Delingo',
      address: '412 Oak Street, Scottsdale, 85254',
    });
  });

  it('entitiesForProposal maps serviceAddress onto address on a create_customer turn', () => {
    expect(
      entitiesForProposal('create_customer', {
        displayName: 'Sam Costello',
        serviceAddress: '91 Fairway Avenue',
      })
    ).toEqual({ name: 'Sam Costello', address: '91 Fairway Avenue' });
  });

  it('entitiesForProposal still passes other intents through untouched', () => {
    // The allowlist rebuild applies ONLY to create_customer; every other
    // intent must keep receiving the classifier's entities verbatim.
    const entities: ExtractedEntities = {
      customerName: 'Sam Costello',
      serviceAddress: '91 Fairway Avenue',
    };
    expect(entitiesForProposal('add_service_location', entities)).toBe(entities);
  });

  /**
   * The generalizable guard. `entitiesForProposal` is an allowlist, so the
   * failure mode is "a new field is added upstream and nobody updates the
   * allowlist". Pin the full set of create_customer entity keys the
   * classifier can emit against what the allowlist forwards, so the next
   * added field fails here instead of in production.
   */
  it('forwards every create_customer entity the classifier can emit', () => {
    const everything: ExtractedEntities = {
      displayName: 'Mario Delingo',
      email: 'mario@example.com',
      phone: '555-0124',
      address: '412 Oak Street, Scottsdale, 85254',
    };
    const forwarded = entitiesForProposal('create_customer', everything)!;
    expect(Object.keys(forwarded).sort()).toEqual(
      ['address', 'email', 'name', 'phone'].sort()
    );
  });
});

describe('create_customer field capture — the hermetic mock can produce an address', () => {
  /**
   * The voice-quality corpus replays cassettes, and every recorded cassette
   * entry is `provider: "mock"` — i.e. the corpus grades THIS function's
   * output, not a real model's. A create_customer field the mock cannot
   * emit is a field the corpus can never grade, which is why the dropped
   * address cleared the launch gate. Pin the mock's address extraction so
   * corpus coverage for the field is real coverage.
   */
  function classify(transcript: string): ExtractedEntities {
    const req = {
      taskType: 'classify_intent',
      messages: [{ role: 'user', content: transcript }],
    } as unknown as LLMRequest;
    return JSON.parse(scriptHermeticResponse(req)).extractedEntities;
  }

  it.each([
    ['Add a new customer, Mario Delingo, 412 Oak Street, Scottsdale, 85254.', '412 Oak Street, Scottsdale, 85254'],
    ["Add Jimmy Hartlett as a new customer. He's at 34 Quarry Street.", '34 Quarry Street'],
    ["Create a new customer, Ashia Aksuna. She's over at 1207 Riverbell Drive.", '1207 Riverbell Drive'],
    ["Add a new customer, nguyen, that's N-G-U-Y-E-N at 91 Fairway Avenue.", '91 Fairway Avenue'],
  ])('extracts the address from %s', (transcript, expected) => {
    expect(classify(transcript).address).toBe(expected);
  });

  it('omits address when the utterance states none', () => {
    expect(classify("I'd like to sign up as a new customer. My name is Jane Smith.").address)
      .toBeUndefined();
  });

  it('end-to-end through the mock classifier and the router boundary', async () => {
    const transcript = 'Add a new customer, Mario Delingo, 412 Oak Street, Scottsdale, 85254.';
    const handler = new CreateCustomerVoiceTaskHandler({ requirePhone: false });
    const out = await handler.run({
      tenantId: TENANT,
      message: transcript,
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: entitiesForProposal('create_customer', classify(transcript)) ?? {},
    });
    expect(out.proposal!.payload.name).toBe('Mario Delingo');
    expect(out.proposal!.payload.address).toBe('412 Oak Street, Scottsdale, 85254');
  });
});
