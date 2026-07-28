/**
 * `create_customer` address capture — the payload contract and the two
 * destinations an approved address can reach.
 *
 * The bug: a spoken address rendered on the approval card, the approver
 * approved, `customer.created` fired — and the address was discarded, because
 * `service_locations` requires street1/city/state/postal_code NOT NULL and the
 * utterance carried only a street. Nothing on `customers` held an address, so
 * there was no trace at all.
 *
 * The anti-regression is the FALLBACK assertion: after this change there must
 * be no path where an address is accepted and then vanishes.
 */
import { describe, it, expect } from 'vitest';
import { CreateCustomerVoiceExecutionHandler } from '../../../src/proposals/execution/create-customer-handler';
import { createProposal } from '../../../src/proposals/proposal';
import { validateProposalPayload } from '../../../src/proposals/contracts';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';
import { InMemoryLocationRepository } from '../../../src/locations/location';
import { InMemoryNoteRepository, NoteRepository } from '../../../src/notes/note';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT = 'tenant-1';
const EXECUTOR = 'voice_agent';

function makeProposal(payload: Record<string, unknown>) {
  return createProposal({
    tenantId: TENANT,
    proposalType: 'create_customer',
    payload,
    summary: 'create customer from voice',
    createdBy: EXECUTOR,
  });
}

function wire(opts?: { noteRepo?: NoteRepository | null; locationRepo?: InMemoryLocationRepository }) {
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = opts?.locationRepo ?? new InMemoryLocationRepository();
  const noteRepo = opts?.noteRepo === null ? undefined : (opts?.noteRepo ?? new InMemoryNoteRepository());
  const auditRepo = new InMemoryAuditRepository();
  const handler = new CreateCustomerVoiceExecutionHandler(
    customerRepo,
    auditRepo,
    locationRepo,
    noteRepo,
  );
  return { customerRepo, locationRepo, noteRepo, auditRepo, handler };
}

describe('createCustomerPayloadSchema — structured address fields', () => {
  it('still accepts the OLD shape, unchanged', () => {
    // Every payload that validated before this change must still validate.
    for (const payload of [
      { name: 'Jane Smith' },
      { name: 'Jane Smith', email: 'jane@example.com', phone: '555-0100' },
      { name: 'Ashia Aksuna', address: '1207 Riverbell Drive', smsConsent: false },
      { name: 'Jane Smith', notes: 'gate code 4412' },
    ]) {
      expect(validateProposalPayload('create_customer', payload)).toEqual({ valid: true });
    }
  });

  it('accepts the NEW shape with structured address fields', () => {
    expect(
      validateProposalPayload('create_customer', {
        name: 'Ashia Aksuna',
        address: '1207 Riverbell Drive',
        street1: '1207 Riverbell Drive',
        street2: 'Unit 3',
        city: 'Scottsdale',
        state: 'AZ',
        postalCode: '85254',
        country: 'US',
      }),
    ).toEqual({ valid: true });
  });

  it('accepts a PARTIALLY completed address — each field is independently optional', () => {
    // Deliberately not an all-or-nothing refine (contrast leads/enums.ts):
    // an approver who knows the city but not the ZIP must still be able to
    // save and approve.
    expect(
      validateProposalPayload('create_customer', {
        name: 'Ashia Aksuna',
        address: '1207 Riverbell Drive',
        city: 'Scottsdale',
      }),
    ).toEqual({ valid: true });
  });

  it('rejects an empty string in a structured field rather than writing a blank column', () => {
    const result = validateProposalPayload('create_customer', {
      name: 'Ashia Aksuna',
      city: '',
    });
    expect(result.valid).toBe(false);
  });
});

describe('create_customer execution — a COMPLETE address becomes a service_location', () => {
  it('writes the primary location from approver-supplied structured fields', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({
        name: 'Ashia Aksuna',
        address: '1207 Riverbell Drive',
        street1: '1207 Riverbell Drive',
        city: 'Scottsdale',
        state: 'AZ',
        postalCode: '85254',
      }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );

    expect(result.success).toBe(true);
    const locations = await w.locationRepo.findByCustomer(TENANT, result.resultEntityId!);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      street1: '1207 Riverbell Drive',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
      country: 'US',
      isPrimary: true,
    });

    // A real location means no fallback anywhere.
    expect(await w.noteRepo!.findByEntity(TENANT, 'customer', result.resultEntityId!)).toHaveLength(0);
    const customer = await w.customerRepo.findById(TENANT, result.resultEntityId!);
    expect(customer!.communicationNotes ?? '').not.toContain('Address from voice');
  });

  it('carries street2 and a non-default country onto the location', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({
        name: 'Ashia Aksuna',
        street1: '1207 Riverbell Drive',
        street2: 'Apt 2B',
        city: 'Scottsdale',
        state: 'AZ',
        postalCode: '85254',
        country: 'CA',
      }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    const locations = await w.locationRepo.findByCustomer(TENANT, result.resultEntityId!);
    expect(locations[0]).toMatchObject({ street2: 'Apt 2B', country: 'CA' });
  });

  it('the approver overrides what the parser guessed', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({
        name: 'Mario Delingo',
        address: '412 Oak Street, Scottsdale, AZ 85254',
        city: 'Paradise Valley',
      }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    const locations = await w.locationRepo.findByCustomer(TENANT, result.resultEntityId!);
    expect(locations[0]).toMatchObject({ city: 'Paradise Valley', postalCode: '85254' });
  });
});

describe('create_customer execution — an INCOMPLETE address is never discarded', () => {
  it('preserves the verbatim address as a pinned customer note (the anti-regression)', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({ name: 'Ashia Aksuna', address: '1207 Riverbell Drive', smsConsent: false }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );

    expect(result.success).toBe(true);
    const customerId = result.resultEntityId!;

    // Still no invented city/state/ZIP.
    expect(await w.locationRepo.findByCustomer(TENANT, customerId)).toHaveLength(0);

    const notes = await w.noteRepo!.findByEntity(TENANT, 'customer', customerId);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('1207 Riverbell Drive');
    expect(notes[0].content).toContain('city, state, ZIP');
    expect(notes[0].isPinned).toBe(true);
    expect(notes[0].authorRole).toBe('voice_agent');
  });

  it('also writes it onto the customer row itself, in the same INSERT', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({ name: 'Jimmy Hartlett', address: '34 Quarry Street' }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    const customer = await w.customerRepo.findById(TENANT, result.resultEntityId!);
    expect(customer!.communicationNotes).toContain('34 Quarry Street');
  });

  it('never clobbers the operator’s own notes', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({
        name: 'Jimmy Hartlett',
        address: '34 Quarry Street',
        notes: 'Dog in the back yard.',
      }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    const customer = await w.customerRepo.findById(TENANT, result.resultEntityId!);
    expect(customer!.communicationNotes).toContain('Dog in the back yard.');
    expect(customer!.communicationNotes).toContain('34 Quarry Street');
  });

  it('emits a queryable audit marker naming exactly what is still missing', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({ name: 'Ashia Aksuna', address: '1207 Riverbell Drive' }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    const markers = w.auditRepo
      .getAll()
      .filter((e) => e.eventType === 'customer.address_unstructured');
    expect(markers).toHaveLength(1);
    expect(markers[0].entityId).toBe(result.resultEntityId);
    expect(markers[0].metadata).toMatchObject({
      address: '1207 Riverbell Drive',
      missingFields: ['city', 'state', 'postalCode'],
      preservedAs: 'note',
    });
  });

  it('falls back to the customer row when NO note repository is wired', async () => {
    const w = wire({ noteRepo: null });
    const result = await w.handler.execute(
      makeProposal({ name: 'Ashia Aksuna', address: '1207 Riverbell Drive' }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    const customer = await w.customerRepo.findById(TENANT, result.resultEntityId!);
    expect(customer!.communicationNotes).toContain('1207 Riverbell Drive');
    expect(
      (w.auditRepo.getAll().find((e) => e.eventType === 'customer.address_unstructured')!
        .metadata as Record<string, unknown>).preservedAs,
    ).toBe('communication_notes');
  });

  it('falls back to the customer row when the note write THROWS', async () => {
    const exploding = {
      create: async () => {
        throw new Error('notes table unavailable');
      },
      findById: async () => null,
      findByEntity: async () => [],
      update: async () => null,
      delete: async () => false,
    } satisfies NoteRepository;
    const w = wire({ noteRepo: exploding });

    const result = await w.handler.execute(
      makeProposal({ name: 'Ashia Aksuna', address: '1207 Riverbell Drive' }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );

    expect(result.success).toBe(true);
    const customer = await w.customerRepo.findById(TENANT, result.resultEntityId!);
    expect(customer!.communicationNotes).toContain('1207 Riverbell Drive');
  });

  it('preserves a COMPLETE address when the location write fails', async () => {
    // The address was complete, so nothing was pre-written onto the customer.
    // The location insert then failed — which historically meant the address
    // was gone. It must land in the note instead.
    const exploding = {
      create: async () => {
        throw new Error('locations table unavailable');
      },
      findByCustomer: async () => [],
    } as unknown as InMemoryLocationRepository;
    const w = wire({ locationRepo: exploding });

    const result = await w.handler.execute(
      makeProposal({ name: 'Mario Delingo', address: '412 Oak Street, Scottsdale, AZ 85254' }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );

    expect(result.success).toBe(true);
    const notes = await w.noteRepo!.findByEntity(TENANT, 'customer', result.resultEntityId!);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('412 Oak Street, Scottsdale, AZ 85254');
  });

  it('preserves a partial address the approver typed with nothing spoken', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({ name: 'Ashia Aksuna', street1: '1207 Riverbell Drive', city: 'Scottsdale' }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    const notes = await w.noteRepo!.findByEntity(TENANT, 'customer', result.resultEntityId!);
    expect(notes[0].content).toContain('1207 Riverbell Drive, Scottsdale');
    expect(notes[0].content).toContain('still needs state, ZIP');
  });

  it('writes nothing extra when there was no address at all', async () => {
    const w = wire();
    const result = await w.handler.execute(
      makeProposal({ name: 'Alex Smith', phone: '+15551230100' }),
      { tenantId: TENANT, executedBy: EXECUTOR },
    );
    expect(await w.locationRepo.findByCustomer(TENANT, result.resultEntityId!)).toHaveLength(0);
    expect(await w.noteRepo!.findByEntity(TENANT, 'customer', result.resultEntityId!)).toHaveLength(0);
    const customer = await w.customerRepo.findById(TENANT, result.resultEntityId!);
    expect(customer!.communicationNotes).toBeUndefined();
    expect(
      w.auditRepo.getAll().filter((e) => e.eventType === 'customer.address_unstructured'),
    ).toHaveLength(0);
  });
});
