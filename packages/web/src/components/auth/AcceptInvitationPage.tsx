import { Navigate, useSearchParams } from 'react-router';
import { useMe } from '../../hooks/useMe';
import { Spinner } from '../ui';

/**
 * 1.11 — lands an invited teammate after they complete Clerk's invitation
 * sign-up.
 *
 * `inviteTeamMember` (users/invite-team-member.ts) redirects an accepted
 * invitee to `${appBaseUrl}/accept-invitation?invitation_id=<id>` — but the
 * web router had no such route, so every invited technician 404'd instead of
 * reaching the app.
 *
 * The actual acceptance already happens server-side: Clerk's `user.created`
 * webhook (webhooks/routes.ts) joins this clerk_user_id to the inviting
 * tenant with the invited role, marks the pending invitation accepted, and
 * audits `tenant.invitation.accepted` — all BEFORE this page ever renders
 * (Clerk redirects here only once its own hosted sign-up step, driven by the
 * invitation ticket, completes). This page's job is narrow:
 *
 *   - It gives `ProtectedRoute` a real route to gate: a signed-out visitor
 *     (invitation link opened cold, no active Clerk session) bounces to
 *     `/login` with a return path, same as every other authenticated page.
 *   - Once signed in, `/api/me` already reports the invited role straight
 *     from the token claims (routes/me.ts — `role` never depends on the
 *     local `users` row landing first), so there is no race to poll for:
 *     hand off immediately to `RoleHome`'s existing per-role landing
 *     (`/` -> `/technician/day` for a technician, HomePage otherwise).
 *
 * `invitation_id` is read only to display a specific message if `/api/me`
 * never resolves (e.g. an expired/replayed link with no live session) — no
 * API call reads it back here; the join already happened.
 */
export function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const invitationId = searchParams.get('invitation_id');
  const { me, isLoading, error } = useMe();

  if (isLoading && !me) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <Spinner />
          <p className="text-sm text-slate-500">Setting up your account…</p>
        </div>
      </div>
    );
  }

  if (me) {
    // RoleHome (rendered at "/") applies the real per-role split.
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-sm text-center">
        <p className="text-sm text-slate-600">
          {error
            ? "We couldn't confirm your invitation. Please ask for a new invite link."
            : invitationId
              ? "We couldn't find that invitation. Please ask for a new invite link."
              : "This invitation link is missing its invitation code. Please ask for a new invite link."}
        </p>
      </div>
    </div>
  );
}
