import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import {
  UserRepository,
  USER_ROLES,
  listUsers,
  updateUser,
  UserRole,
} from '../users/user';

const updateUserSchema = z.object({
  role: z.enum(['owner', 'dispatcher', 'technician']).optional(),
  firstName: z.string().trim().max(200).optional(),
  lastName: z.string().trim().max(200).optional(),
  canFieldServe: z.boolean().optional(),
});

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
export function createUsersRouter(userRepo: UserRepository): Router {
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

  return router;
}
