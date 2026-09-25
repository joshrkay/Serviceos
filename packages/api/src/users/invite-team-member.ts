/**
 * The one path that issues a teammate invitation.
 *
 * Extracted from POST /api/users/invitations (routes/users.ts) so the
 * onboarding_team_member proposal handler issues invitations the same way
 * the route does. Creating the local row alone is not an invitation: the
 * teammate gets no email and cannot reach the accept flow, while the
 * proposal reports success.
 *
 * Order matters. The local row is written FIRST so a Clerk-side outage
 * cannot lose the tenant's intent, and the Clerk call is best-effort: a
 * failure leaves the pending row standing and the operator re-sends from
 * the Clerk dashboard. `clerkInvitationId` is reported back but not stored
 * — the webhook joins on `public_metadata.invitation_id`, which is the
 * local row's id.
 */
import { PendingInvitation, PendingInvitationRepository } from './pending-invitation';
import { UserRole } from './user';
import { assertSeatAvailable, type SeatUsageReader } from './seat-limit';
import { publicUrl } from '../shared/public-origins';

export interface ClerkInvitationConfig {
  clerkSecretKey?: string;
  /** Defaults to global fetch. Tests inject a stub. */
  clerkFetch?: typeof fetch;
}

export interface InviteTeamMemberInput {
  tenantId: string;
  email: string;
  role: UserRole;
  invitedBy: string;
}

export interface InviteTeamMemberResult {
  invitation: PendingInvitation;
  clerkInvitationId: string | null;
}

export async function inviteTeamMember(
  input: InviteTeamMemberInput,
  invitationRepo: PendingInvitationRepository,
  clerk: ClerkInvitationConfig = {},
  /** Per-plan user limit; enforced whenever wired (always in production). */
  seatUsage?: SeatUsageReader,
): Promise<InviteTeamMemberResult> {
  if (seatUsage) {
    assertSeatAvailable(await seatUsage.getSeatUsage(input.tenantId));
  }
  const invitation = await invitationRepo.create({
    tenantId: input.tenantId,
    email: input.email,
    role: input.role,
    invitedBy: input.invitedBy,
  });

  let clerkInvitationId: string | null = null;
  if (clerk.clerkSecretKey) {
    try {
      const fetchFn = clerk.clerkFetch ?? fetch;
      // Where the invitee lands after Clerk sign-up: the SPA (web origin),
      // never the API host. Resolved once by loadConfig().
      const redirectUrl = publicUrl('web', '/accept-invitation', { invitation_id: invitation.id });
      const clerkRes = await fetchFn('https://api.clerk.com/v1/invitations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clerk.clerkSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email_address: input.email,
          public_metadata: {
            invitation_id: invitation.id,
            tenant_id: input.tenantId,
            role: input.role,
          },
          redirect_url: redirectUrl,
        }),
      });
      if (clerkRes.ok) {
        const data = (await clerkRes.json()) as { id?: string };
        clerkInvitationId = data.id ?? null;
      }
    } catch {
      // Best-effort. Local row stays; UI surfaces "Invited" on it
      // regardless. Re-send is via Clerk dashboard.
    }
  }

  return { invitation, clerkInvitationId };
}
