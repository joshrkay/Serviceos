/**
 * Real-shaped Clerk `user.created` webhook payloads (Clerk's UserJSON /
 * EmailAddressJSON, as typed in @clerk/backend's api/resources/JSON.d.ts):
 * `primary_email_address_id` names one of `email_addresses[].id`, and each
 * address carries `verification: { status, strategy, attempts, expire_at }`
 * (or null). Tests that exercise the invitation-join path need these fields;
 * the bare `{ email_address }` shape some older tests use has no
 * verification and so can no longer join an invitation's tenant.
 */
export type ClerkVerificationStatus =
  | 'unverified'
  | 'verified'
  | 'transferable'
  | 'failed'
  | 'expired';

export interface ClerkTestEmail {
  address: string;
  /** null models an address Clerk has not started verifying (verification: null). */
  status: ClerkVerificationStatus | null;
  strategy?: string;
}

export interface ClerkUserCreatedOptions {
  userId: string;
  emails: ClerkTestEmail[];
  /** Index into `emails` of the primary address. Defaults to 0; null sends a null primary id. */
  primaryIndex?: number | null;
  publicMetadata?: Record<string, unknown>;
  firstName?: string | null;
  lastName?: string | null;
}

export function clerkUserCreatedEvent(opts: ClerkUserCreatedOptions): {
  type: 'user.created';
  object: 'event';
  data: Record<string, unknown>;
} {
  const emailAddresses = opts.emails.map((e, i) => ({
    id: `idn_${opts.userId}_${i}`,
    object: 'email_address',
    email_address: e.address,
    linked_to: [],
    verification:
      e.status === null
        ? null
        : {
            status: e.status,
            strategy: e.strategy ?? 'email_code',
            attempts: e.status === 'verified' ? 1 : 0,
            expire_at: 1_900_000_000_000,
          },
  }));
  const primaryIndex = opts.primaryIndex === undefined ? 0 : opts.primaryIndex;
  return {
    type: 'user.created',
    object: 'event',
    data: {
      id: opts.userId,
      object: 'user',
      first_name: opts.firstName ?? null,
      last_name: opts.lastName ?? null,
      primary_email_address_id:
        primaryIndex === null ? null : (emailAddresses[primaryIndex]?.id ?? null),
      email_addresses: emailAddresses,
      phone_numbers: [],
      external_accounts: [],
      public_metadata: opts.publicMetadata ?? {},
      private_metadata: {},
      unsafe_metadata: {},
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
  };
}
