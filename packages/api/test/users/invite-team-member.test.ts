/**
 * inviteTeamMember — the one path that issues a teammate invitation.
 *
 * The Clerk invitation's redirect_url is where the invitee lands after
 * sign-up: the SPA's /accept-invitation page. That is a link a human opens,
 * so it is built on the WEB origin from config.publicOrigins — never on the
 * API host (which is what prod emitted while app.ts passed
 * APP_PUBLIC_URL ?? 'http://localhost:3000' as the base).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, resetConfig } from '../../src/shared/config';
import { inviteTeamMember } from '../../src/users/invite-team-member';
import { InMemoryPendingInvitationRepository } from '../../src/users/pending-invitation';

describe('inviteTeamMember', () => {
  beforeEach(() => {
    resetConfig();
    loadConfig({ NODE_ENV: 'dev', WEB_URL: 'https://app.example.com' });
  });
  afterEach(() => resetConfig());

  it('sends Clerk a redirect_url on the web origin pointing at /accept-invitation for the new row', async () => {
    const repo = new InMemoryPendingInvitationRepository();
    const clerkFetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'inv_clerk_1' }) }));

    const result = await inviteTeamMember(
      { tenantId: 'tenant-1', email: 'tech@example.com', role: 'technician', invitedBy: 'owner-1' },
      repo,
      { clerkSecretKey: 'sk_test', clerkFetch: clerkFetch as unknown as typeof fetch },
    );

    expect(result.clerkInvitationId).toBe('inv_clerk_1');
    const [url, init] = clerkFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.clerk.com/v1/invitations');
    const body = JSON.parse(String(init.body)) as { redirect_url: string };
    expect(body.redirect_url).toBe(
      `https://app.example.com/accept-invitation?invitation_id=${encodeURIComponent(result.invitation.id)}`,
    );
  });
});
