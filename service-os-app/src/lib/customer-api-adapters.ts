/**
 * Maps canonical API (packages/api) customer DTOs to the simplified shape
 * used by service-os-app pages. Stats are not on the customer aggregate yet.
 */

export interface MobileCustomer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  total_jobs: number;
  total_revenue: number;
}

export interface ApiCustomerJson {
  id: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
}

export function apiCustomerToMobile(c: ApiCustomerJson): MobileCustomer {
  return {
    id: c.id,
    name: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Customer',
    phone: c.primaryPhone,
    email: c.email,
    address: undefined,
    total_jobs: 0,
    total_revenue: 0,
  };
}

function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const t = name.trim();
  if (!t) {
    return { firstName: 'Unknown', lastName: 'Customer' };
  }
  const parts = t.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: parts[0] };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** POST /api/customers body from mobile UI -> Express createCustomerSchema */
export function mobileCreateBodyToApi(body: {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
}): Record<string, unknown> {
  const { firstName, lastName } = splitDisplayName(body.name);
  const out: Record<string, unknown> = {
    firstName,
    lastName,
  };
  if (body.phone?.trim()) {
    out.primaryPhone = body.phone.trim();
  }
  if (body.email?.trim()) {
    out.email = body.email.trim();
  }
  if (body.address?.trim()) {
    out.communicationNotes = `Address: ${body.address.trim()}`;
  }
  return out;
}

/** PATCH body from mobile -> Express updateCustomer partial */
export function mobilePatchBodyToApi(body: {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const { firstName, lastName } = splitDisplayName(body.name);
    out.firstName = firstName;
    out.lastName = lastName;
  }
  if (body.phone !== undefined) {
    out.primaryPhone = body.phone.trim() || undefined;
  }
  if (body.email !== undefined) {
    out.email = body.email.trim() || undefined;
  }
  if (body.address !== undefined && body.address.trim()) {
    out.communicationNotes = `Address: ${body.address.trim()}`;
  }
  return out;
}
