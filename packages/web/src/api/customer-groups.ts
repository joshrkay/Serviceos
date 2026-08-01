/**
 * U8 (CRM Jobber parity) — customer groups web client.
 *
 * Talks to /api/customer-groups: manage named segments and membership.
 */
import { apiFetch } from '../utils/api-fetch';

export interface CustomerGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  color: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerGroupWithCount extends CustomerGroup {
  memberCount: number;
}

export interface CustomerGroupInput {
  name: string;
  description?: string | null;
  color?: string | null;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listCustomerGroups(): Promise<CustomerGroupWithCount[]> {
  const res = await apiFetch('/api/customer-groups');
  const data = await readJsonOrThrow<unknown>(res, 'load customer groups');
  return Array.isArray(data) ? (data as CustomerGroupWithCount[]) : [];
}

export async function createCustomerGroup(input: CustomerGroupInput): Promise<CustomerGroup> {
  const res = await apiFetch('/api/customer-groups', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<CustomerGroup>(res, 'create customer group');
}

export async function archiveCustomerGroup(id: string): Promise<void> {
  const res = await apiFetch(`/api/customer-groups/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to archive group: ${res.status}`);
}

export async function listGroupsForCustomer(customerId: string): Promise<CustomerGroup[]> {
  const res = await apiFetch(`/api/customer-groups/for-customer/${encodeURIComponent(customerId)}`);
  const data = await readJsonOrThrow<unknown>(res, 'load customer groups');
  return Array.isArray(data) ? (data as CustomerGroup[]) : [];
}

export async function addCustomerToGroup(groupId: string, customerId: string): Promise<void> {
  const res = await apiFetch(
    `/api/customer-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(customerId)}`,
    { method: 'PUT' },
  );
  if (!res.ok) throw new Error(`Failed to add to group: ${res.status}`);
}

export async function removeCustomerFromGroup(groupId: string, customerId: string): Promise<void> {
  const res = await apiFetch(
    `/api/customer-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(customerId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`Failed to remove from group: ${res.status}`);
}
