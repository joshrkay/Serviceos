/**
 * The primary email address a Clerk `user` webhook payload carries, and
 * whether Clerk reports that address as verified.
 *
 * Payload shape (Clerk UserJSON / EmailAddressJSON): `primary_email_address_id`
 * names one of `email_addresses[].id`, and each entry has
 * `verification: { status: 'unverified' | 'verified' | 'transferable' |
 * 'failed' | 'expired', strategy, ... }` or `null`.
 *
 * - `address` is the entry `primary_email_address_id` names. When the payload
 *   names no primary, or names one that is not in the list, it falls back to
 *   the first entry — the address the signup path has always used as the new
 *   tenant's owner email.
 * - `verified` is true only when that entry IS the primary (or the payload
 *   names none) and its `verification.status` is exactly `'verified'`. A
 *   verified secondary address never stands in for the primary.
 *
 * Anything that grants access on the strength of the address — joining an
 * existing tenant through a pending invitation — must require `verified`.
 */
export interface ClerkPrimaryEmail {
  address: string;
  verified: boolean;
}

interface EmailEntry {
  id?: unknown;
  email_address?: unknown;
  verification?: { status?: unknown } | null;
}

function isEntry(value: unknown): value is EmailEntry {
  return typeof value === 'object' && value !== null;
}

export function clerkPrimaryEmail(userData: unknown): ClerkPrimaryEmail | null {
  if (!isEntry(userData)) return null;
  const data = userData as { email_addresses?: unknown; primary_email_address_id?: unknown };
  const entries = Array.isArray(data.email_addresses) ? data.email_addresses.filter(isEntry) : [];
  const primaryId =
    typeof data.primary_email_address_id === 'string' && data.primary_email_address_id
      ? data.primary_email_address_id
      : null;

  const named = primaryId ? entries.find((e) => e.id === primaryId) : undefined;
  const chosen = named ?? entries[0];
  if (!chosen || typeof chosen.email_address !== 'string') return null;
  const address = chosen.email_address.trim();
  if (!address) return null;

  const isPrimary = primaryId === null || named !== undefined;
  const verified = isPrimary && chosen.verification?.status === 'verified';
  return { address, verified };
}
