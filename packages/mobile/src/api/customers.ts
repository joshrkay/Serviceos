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
