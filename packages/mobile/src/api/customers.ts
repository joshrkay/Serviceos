import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';

export interface CreateCustomerInput {
  firstName: string;
  lastName: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
}

export interface CustomerRecord extends CreateCustomerInput {
  id: string;
  displayName?: string;
}

export async function createCustomer(
  client: AuthedFetch,
  input: CreateCustomerInput,
): Promise<CustomerRecord> {
  const res = await client('/api/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createCustomer: ${res.status}`);
  return (await res.json()) as CustomerRecord;
}

export async function updateCustomer(
  client: AuthedFetch,
  id: string,
  input: Partial<CreateCustomerInput>,
): Promise<CustomerRecord> {
  const res = await client(`/api/customers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`updateCustomer: ${res.status}`);
  return (await res.json()) as CustomerRecord;
}

/**
 * C3 — add a service location for a customer. DIRECT audited route
 * (POST /api/locations, not a proposal mint). The server's
 * `createServiceLocationSchema` requires street1/city/state/postalCode; the
 * caller enforces the same four fields before submit so validation failures
 * surface inline. Capture-class. The 201 body may carry advisory duplicate
 * `warnings` (P1-019) — informational, never blocking.
 */
export interface CreateServiceLocationInput {
  customerId: string;
  street1: string;
  city: string;
  state: string;
  postalCode: string;
  label?: string;
  street2?: string;
  country?: string;
  accessNotes?: string;
  isPrimary?: boolean;
  addressType?: 'service' | 'billing' | 'both';
}

export interface ServiceLocationRecord {
  id: string;
  customerId?: string;
  label?: string;
  street1: string;
  city: string;
  state: string;
  postalCode: string;
}

export async function createServiceLocation(
  client: AuthedFetch,
  input: CreateServiceLocationInput,
): Promise<ServiceLocationRecord> {
  const res = await client('/api/locations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await decodeError(res);
  return (await res.json()) as ServiceLocationRecord;
}

/**
 * C6 — add a manual note to a customer. DIRECT audited route (POST /api/notes),
 * `entityType: 'customer'`. `isPinned` is optional (server default false); the
 * manual composer uses it for a "pin to top" toggle. Capture-class.
 */
export interface AddCustomerNoteInput {
  customerId: string;
  content: string;
  isPinned?: boolean;
}

export interface NoteRecord {
  id: string;
  entityType: string;
  entityId: string;
  content: string;
  isPinned: boolean;
}

export async function addCustomerNote(
  client: AuthedFetch,
  input: AddCustomerNoteInput,
): Promise<NoteRecord> {
  const res = await client('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entityType: 'customer',
      entityId: input.customerId,
      content: input.content,
      ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
    }),
  });
  if (!res.ok) throw await decodeError(res);
  return (await res.json()) as NoteRecord;
}
