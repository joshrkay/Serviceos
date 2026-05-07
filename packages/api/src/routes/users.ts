import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, ValidationError } from '../shared/errors';
import {
  UserRepository,
  USER_ROLES,
  listUsers,
  updateUser,
  UserRole,
} from '../users/user';
import { PendingInvitationRepository } from '../users/pending-invitation';

const updateUserSchema = z.object({
  role: z.enum(['owner', 'dispatcher', 'technician']).optional(),
  firstName: z.string().trim().max(200).optional(),
  lastName: z.string().trim().max(200).optional(),
  canFieldServe: z.boolean().optional(),
});

const inviteUserSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(['owner', 'dispatcher', 'technician']),
});

/**
 * Tier 4 (Team members — PR 3). Override-able fetch + Clerk config so
 * tests don't hit api.clerk.com. Both nullable: when CLERK_SECRET_KEY
 * is missing the route still records the invitation locally (the user
 * can resend via Clerk dashboard or accept via direct sign-up).
 */
export interface UsersRouteDeps {
  pendingInvitationRepo?: PendingInvitationRepository;
  clerkSecretKey?: string;
  /** Defaults to global fetch. Tests inject a stub. */
  clerkFetch?: typeof fetch;
  /** Public web URL used as the redirect target after accept. */
  appBaseUrl?: string;
}

/**
 * Tier 4 (Team members — PR 1). GET /api/users for the Team members
 * sheet on Settings. Returns the tenant's user list, optionally
 * filtered by role. The frontend's pre-existing ReassignDialog also
 * consumes this endpoint (and was 404'ing until now — the dialog had
 * a graceful fallback so the bug was latent).
 *
 * PR 2 will add PATCH /api/users/:id for role + name edits.
 * PR 3 will add POST /api/users for invitations.
 */
export function createUsersRouter(
  userRepo: UserRepository,
  deps: UsersRouteDeps = {},
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('users:list'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roleParam = typeof req.query.role === 'string' ? req.query.role : undefined;
        const role: UserRole | undefined =
          roleParam && (USER_ROLES as readonly string[]).includes(roleParam)
            ? (roleParam as UserRole)
            : undefined;

        const users = await listUsers(req.auth!.tenantId, userRepo, { role });
        res.json({ data: users });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('users:edit_role'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = updateUserSchema.parse(req.body ?? {});
        const updated = await updateUser(
          req.auth!.tenantId,
          req.params.id,
          parsed,
          userRepo,
        );
        if (!updated) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
          return;
        }
        res.json(updated);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Tier 4 (Team members — PR 3). List pending invitations for the
   * Settings → Team members sheet. Read-only; returns the same
   * `{ data: [...] }` envelope used by the user list above.
   */
  router.get(
    '/invitations',
    requireAuth,
    requireTenant,
    requirePermission('users:list'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.pendingInvitationRepo) {
          res.json({ data: [] });
          return;
        }
        const data = await deps.pendingInvitationRepo.findByTenant(
          req.auth!.tenantId,
        );
        res.json({ data });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Tier 4 (Team members — PR 3). Create an invitation. Calls Clerk's
   * /v1/invitations API (when CLERK_SECRET_KEY is configured) and
   * persists a local row so the UI can show pending invites + the
   * webhook can join the invitee to the right tenant on acceptance.
   *
   * Local persistence happens FIRST (idempotent unique-on-pending
   * index catches double-clicks), then the Clerk call. If the Clerk
   * call fails the local row stays but with a null clerk_invitation_id
   * — the operator can re-send via the Clerk dashboard, and the
   * webhook still joins them on accept because lookup is by email.
   */
  router.post(
    '/invitations',
    requireAuth,
    requireTenant,
    requirePermission('users:invite'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.pendingInvitationRepo) {
          throw new ValidationError('Invitations are not configured for this tenant');
        }
        const parsed = inviteUserSchema.parse(req.body ?? {});

        // Persist the local row first so a Clerk-side outage doesn't
        // wipe our intent. Unique-on-pending index throws ValidationError
        // (re-mapped from 23505) for a duplicate pending invite.
        const local = await deps.pendingInvitationRepo.create({
          tenantId: req.auth!.tenantId,
          email: parsed.email,
          role: parsed.role,
          invitedBy: req.auth!.userId,
        });

        // Best-effort Clerk call. We keep going even on failure so the
        // local row stands; the operator can retry via dashboard.
        let clerkInvitationId: string | null = null;
        if (deps.clerkSecretKey) {
          try {
            const fetchFn = deps.clerkFetch ?? fetch;
            const redirectUrl =
              `${deps.appBaseUrl ?? ''}/accept-invitation?invitation_id=${encodeURIComponent(local.id)}`;
            const clerkRes = await fetchFn('https://api.clerk.com/v1/invitations', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${deps.clerkSecretKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                email_address: parsed.email,
                public_metadata: {
                  invitation_id: local.id,
                  tenant_id: req.auth!.tenantId,
                  role: parsed.role,
                },
                redirect_url: redirectUrl,
              }),
            });
            if (clerkRes.ok) {
              const data = (await clerkRes.json()) as { id?: string };
              clerkInvitationId = data.id ?? null;
            }
          } catch {
            // Best-effort. Local row stays; UI surfaces "Invited" on
            // it regardless. Re-send is via Clerk dashboard.
          }
        }

        res.status(201).json({ ...local, clerkInvitationId });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
