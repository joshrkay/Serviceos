/**
 * The Clerk `user.created` event an INVITED teammate's sign-up produces, for
 * journeys that join a member to an existing tenant through the real
 * `/webhooks/clerk` route.
 *
 * The invitation join (packages/api/src/webhooks/routes.ts) runs only when
 * the PRIMARY email address is one Clerk reports as verified
 * (packages/api/src/webhooks/clerk-primary-email.ts):
 * `primary_email_address_id` names an `email_addresses[].id` whose
 * `verification.status` is 'verified'. A sign-up through Clerk's invitation
 * link is verified by the invitation ticket itself, so that is the default
 * here. The bare `{ email_address }` shape the owner-bootstrap payloads use
 * carries no verification: sent for an invitee, it bootstraps a separate
 * tenant instead of joining the inviter's.
 *
 * Every e2e invitee payload is built here; an inline one is refused by
 * packages/api/test/webhooks/e2e-clerk-invitee-payload.test.ts. The payload
 * shape itself comes from the API's own fixture, so the two cannot drift.
 */
import { clerkUserCreatedEvent } from '../../packages/api/test/support/clerk-user-created';

export interface ClerkInviteeOptions {
  /** The new Clerk user id. */
  sub: string;
  /** The address the invitation was sent to. */
  email: string;
  /**
   * The `public_metadata` inviteTeamMember sends Clerk
   * (packages/api/src/users/invite-team-member.ts). The join resolves the
   * tenant and role from the invitation row, never from these claims. Omit
   * for a sign-up that did not come through the invitation link, which
   * leaves the join to match the pending invitation by address.
   */
  invitation?: { id: string; tenantId: string; role: string };
  /** Defaults to 'verified'. */
  emailStatus?: 'verified' | 'unverified';
}

export function clerkInviteeUserCreated(opts: ClerkInviteeOptions): ReturnType<typeof clerkUserCreatedEvent> {
  return clerkUserCreatedEvent({
    userId: opts.sub,
    emails: [
      {
        address: opts.email,
        status: opts.emailStatus ?? 'verified',
        strategy: opts.invitation ? 'ticket' : 'email_code',
      },
    ],
    publicMetadata: opts.invitation
      ? { invitation_id: opts.invitation.id, tenant_id: opts.invitation.tenantId, role: opts.invitation.role }
      : {},
  });
}
