import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  commitRequestTransactionAndBegin,
  runAfterCommit,
  runOutsideRequestTransaction,
  withRequestSavepoint,
} from '../middleware/tenant-context';
import { toErrorResponse, ValidationError } from '../shared/errors';
import {
  User,
  UserRepository,
  USER_ROLES,
  listUsers,
  updateUser,
  UserRole,
} from '../users/user';
import { PendingInvitationRepository } from '../users/pending-invitation';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { normalizeMobileE164 } from '../shared/phone/normalize';

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

const setPhoneSchema = z.object({
  // Loose at the schema boundary (free-form entry); normalized to E.164 in the
  // handler. `null` clears the number.
  mobileNumber: z.string().max(40).nullable(),
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
  /**
   * Account deletion purges the user's push tokens server-side — the
   * client's own sign-out cleanup can't run once its credentials are dead.
   */
  deviceTokenRepo?: { removeAllForUser(tenantId: string, userId: string): Promise<number> };
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
  auditRepo?: AuditRepository,
): Router {
  const router = Router();

  /**
   * Resolve the actor + target for the phone endpoints.
   *
   * `req.auth.userId` is the Clerk subject (auth/clerk.ts), NOT a `users.id`
   * UUID — so the phone endpoints (which look users up by internal id) must
   * (1) map the actor's Clerk id to their internal user row, and (2) reject an
   * explicit non-UUID `:id` up front so it can never reach a uuid column (a
   * raw Clerk id would otherwise 500 with "invalid input syntax for type
   * uuid"). `:id = 'me'` resolves to the actor's own internal id. Returns the
   * already-fetched tenant user list so the read path needn't re-query.
   */
  async function resolvePhoneTarget(
    req: AuthenticatedRequest,
  ): Promise<
    | { ok: true; tenantId: string; actor: User; targetId: string; users: User[] }
    | { ok: false; status: number; error: string; message: string }
  > {
    const tenantId = req.auth!.tenantId;
    const clerkUserId = req.auth!.userId;
    if (req.params.id !== 'me' && !z.string().uuid().safeParse(req.params.id).success) {
      return { ok: false, status: 400, error: 'BAD_REQUEST', message: 'Invalid user id.' };
    }
    const users = await userRepo.findByTenant(tenantId);
    const actor = users.find((u) => u.clerkUserId === clerkUserId);
    if (!actor) {
      return { ok: false, status: 404, error: 'NOT_FOUND', message: 'User not found' };
    }
    const targetId = req.params.id === 'me' ? actor.id : req.params.id;
    return { ok: true, tenantId, actor, targetId, users };
  }

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

        // D2-1c — audit-log role / name / canFieldServe edits. Role changes
        // are RBAC-critical so this row is the timeline anchor that lets
        // the operator-history view answer "who promoted whom and when".
        // We emit `changedFields` (key list only) rather than before/after
        // so PII (name fields) doesn't land in the audit log payload.
        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'user.updated',
              entityType: 'user',
              entityId: updated.id,
              metadata: { changedFields: Object.keys(parsed) },
            }),
          );
        }

        res.json(updated);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Read the current user's escalation number (`:id` = `me` or a userId).
   * Self-or-owner gated like the PUT below; powers the technician phone sheet.
   */
  router.get(
    '/:id/phone',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const resolved = await resolvePhoneTarget(req);
        if (!resolved.ok) {
          res.status(resolved.status).json({ error: resolved.error, message: resolved.message });
          return;
        }
        const { actor, targetId, users } = resolved;
        if (targetId !== actor.id && req.auth!.role !== 'owner') {
          res
            .status(403)
            .json({ error: 'FORBIDDEN', message: 'You can only view your own phone number.' });
          return;
        }
        const user = targetId === actor.id ? actor : users.find((u) => u.id === targetId);
        if (!user) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
          return;
        }
        res.json({ mobileNumber: user.mobileNumber ?? null });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Self-service mobile number for escalation routing. A technician sets
   * their OWN number (`:id` = `me` or their userId); an owner may set any
   * teammate's. The on-call escalation path (dispatcher-phone-resolver) dials
   * this number, so a tradesperson controls where their calls ring. PII-safe
   * audit: we record that a number changed, never the digits.
   */
  router.put(
    '/:id/phone',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const resolved = await resolvePhoneTarget(req);
        if (!resolved.ok) {
          res.status(resolved.status).json({ error: resolved.error, message: resolved.message });
          return;
        }
        const { tenantId, actor, targetId } = resolved;

        // A user may set their own number; only an owner may set someone else's.
        if (targetId !== actor.id && req.auth!.role !== 'owner') {
          res
            .status(403)
            .json({ error: 'FORBIDDEN', message: 'You can only set your own phone number.' });
          return;
        }

        const parsed = setPhoneSchema.parse(req.body ?? {});
        // Normalize at the boundary; a null/blank value clears the number.
        let e164: string | null = null;
        if (parsed.mobileNumber !== null) {
          const trimmed = parsed.mobileNumber.trim();
          if (trimmed !== '') {
            try {
              e164 = normalizeMobileE164(trimmed);
            } catch (err) {
              throw new ValidationError(
                err instanceof Error ? err.message : 'Invalid mobile number',
                { field: 'mobileNumber' },
              );
            }
          }
        }

        let updated;
        try {
          updated = await userRepo.setMobileNumber(tenantId, targetId, e164);
        } catch (err) {
          // (tenant_id, mobile_number) partial-unique index — two teammates
          // can't share a number. Surface a clean 409 rather than a 500.
          if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
            res.status(409).json({
              error: 'CONFLICT',
              message: 'That number is already assigned to another teammate.',
            });
            return;
          }
          throw err;
        }
        if (!updated) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
          return;
        }

        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'user.mobile_number.updated',
              entityType: 'user',
              entityId: updated.id,
              metadata: { set: e164 !== null, self: targetId === actor.id },
            }),
          );
        }

        res.json(updated);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Guideline 5.1.1(v) — in-app account deletion, initiated from the mobile
   * Settings screen. Self-only (`/me`): any authenticated member may delete
   * their OWN account; nobody can delete a teammate through this route.
   *
   * Semantics follow the established 16D soft-delete model (migration 093 +
   * the Clerk user.deleted webhook): revoke access, retain rows for audit
   * and billing, never purge tenant data or release the Twilio subaccount.
   *
   * Order of operations (the LOCAL soft-delete is the serialization point —
   * it must succeed BEFORE the irreversible Clerk delete, so two owners
   * racing each other cannot both revoke their Clerk users and orphan the
   * workspace; the atomic last-owner guard admits at most one of them):
   *   1. Last-owner pre-check → clean 409 without touching anything.
   *   2. Local soft-delete (atomic guard, authoritative). Guard-blocked
   *      owner → 409; already-deleted row → idempotent 200.
   *   3. Delete the Clerk user (bounded to 10s like the Clerk calls in
   *      webhooks/routes.ts — a stalled upstream must not pin this
   *      request's transaction/pool client). Outcome is three-way:
   *      confirmed-deleted → proceed; confirmed-alive (definite 4xx, or a
   *      verification GET finds the user) → restoreAccount + 502;
   *      unconfirmable → the stamp STAYS (deactivated, support-reversible)
   *      because blindly restoring a possibly-Clerk-deleted user would
   *      create a ghost owner after its webhook already no-op'd. Without
   *      CLERK_SECRET_KEY (dev/tests) this step is skipped.
   *   4. Purge the user's push tokens — the client's own sign-out cleanup
   *      can no longer authenticate, so the server must do it or the
   *      deleted user's device keeps receiving tenant pushes.
   *   5. Audit event (all mutations emit audit events).
   *
   * Durability: after the guarded soft-delete succeeds, the request
   * transaction is COMMITTED EARLY (commitRequestTransactionAndBegin) so
   * the reservation is durable BEFORE the irreversible Clerk call — a
   * crash or failed response-time COMMIT after Clerk accepts can no
   * longer roll the stamp back and let the deleted user transiently count
   * as a live owner for someone else's demotion guard. The failure path
   * compensates in the restarted transaction (restoreAccount) and sets
   * res.locals.forceCommit so the 502 response still commits the restore.
   * Steps 4-5 stay best-effort + SAVEPOINT-isolated; the Clerk
   * user.deleted webhook remains a belt-and-braces reconciler (its
   * unconditional stamp is now benign for this path — the local stamp is
   * already durable whenever Clerk deletion succeeded).
   */
  router.delete(
    '/me',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const clerkUserId = req.auth!.userId;

        // If the mobile client disconnects during the long Clerk sequence,
        // the /api middleware rolls back and RELEASES the request client on
        // res 'close' while this handler keeps running — from that moment
        // any write through the AsyncLocalStorage client would hit a
        // released (possibly re-borrowed) connection. Writes that must
        // survive the disconnect go through runDurable: fresh-connection
        // path once closed, and a re-run if 'close' raced the in-flight
        // in-transaction write (the write fns used here are idempotent).
        let responseClosed = false;
        res.once('close', () => {
          responseClosed = true;
        });
        const runDurable = async (fn: () => Promise<unknown>): Promise<void> => {
          if (responseClosed) {
            await runOutsideRequestTransaction(fn);
            return;
          }
          await fn();
          if (responseClosed) {
            await runOutsideRequestTransaction(fn);
            return;
          }
          // The write above sits in the request transaction until the
          // response-time COMMIT — which is asynchronous and can itself
          // fail even after `finish` fires. Suppress the out-of-band retry
          // only on CONFIRMED commit (runAfterCommit fires post-COMMIT
          // only). On `close` without that confirmation — client
          // disconnect, rollback, or a failed COMMIT — re-run the
          // idempotent write on a fresh connection (the request client has
          // been released by then, so the checkout cannot deadlock). A
          // spurious re-run when the commit merely raced this listener is
          // a harmless no-op for these write fns.
          let committed = false;
          runAfterCommit(res, () => {
            committed = true;
          });
          res.once('close', () => {
            if (!committed) {
              void runOutsideRequestTransaction(fn).catch(() => undefined);
            }
          });
        };

        const users = await userRepo.findByTenant(tenantId);
        const actor = users.find((u) => u.clerkUserId === clerkUserId);
        if (!actor) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
          return;
        }

        // Purge the user's push tokens (best-effort, disconnect-safe). Used
        // on every terminal-deactivation path — success AND unconfirmable —
        // because the client can no longer authenticate its own device-token
        // DELETE once the membership row is stamped.
        const purgeTokens = async (): Promise<void> => {
          if (!deps.deviceTokenRepo || !actor.clerkUserId) return;
          const clerkId = actor.clerkUserId;
          try {
            await runDurable(() =>
              withRequestSavepoint(() => deps.deviceTokenRepo!.removeAllForUser(tenantId, clerkId)),
            );
          } catch {
            // Never turn a completed deactivation into an error; a stale
            // token is also displaced on the device's next register().
          }
        };

        if (actor.role === 'owner') {
          const anotherOwner = users.some((u) => u.id !== actor.id && u.role === 'owner');
          if (!anotherOwner) {
            res.status(409).json({
              error: 'LAST_OWNER',
              message:
                'You are the only owner. Transfer ownership to a teammate first, ' +
                'or contact support to close the whole workspace.',
            });
            return;
          }
        }

        // Reserve the deletion locally FIRST. The atomic guard is the only
        // serialization point: of two owners deleting concurrently, exactly
        // one UPDATE passes the EXISTS check — the loser must NOT reach the
        // irreversible Clerk delete below.
        const stamped = await userRepo.softDeleteSelf(tenantId, actor.id);
        if (!stamped) {
          if (actor.role === 'owner') {
            // Guard blocked between the pre-check and the UPDATE (raced
            // with another owner's deletion) — same clean 409 as above.
            res.status(409).json({
              error: 'LAST_OWNER',
              message:
                'You are the only owner. Transfer ownership to a teammate first, ' +
                'or contact support to close the whole workspace.',
            });
          } else {
            // Row already deleted (double-tap) — idempotent success.
            res.json({ deleted: true });
          }
          return;
        }

        // Make the reservation DURABLE before the irreversible external
        // call (see the Durability note above). Also releases the tenant
        // lock — correctly: the guard was already evaluated under it
        // against committed state, and from here the stamp is permanent
        // unless we explicitly compensate below.
        try {
          await commitRequestTransactionAndBegin();
        } catch {
          // Post-COMMIT failure (e.g. connection dropped at the COMMIT/BEGIN
          // boundary): the stamp may already be durable while the request
          // client is unusable — without compensation the caller would be
          // locked out locally with their Clerk identity intact. Restore on
          // a FRESH connection outside the request context.
          try {
            await runOutsideRequestTransaction(() =>
              userRepo.restoreAccount(tenantId, actor.id, actor.mobileNumber ?? null),
            );
            res.status(502).json({
              error: 'ACCOUNT_DELETE_FAILED',
              message: 'Could not delete the account right now. Please try again.',
            });
          } catch {
            res.status(500).json({
              error: 'ACCOUNT_DELETE_INCONSISTENT',
              message:
                'Deletion could not be completed. Your account may be deactivated — please contact support.',
            });
          }
          return;
        }

        if (deps.clerkSecretKey && actor.clerkUserId) {
          const fetchFn = deps.clerkFetch ?? fetch;
          const clerkUrl = `https://api.clerk.com/v1/users/${encodeURIComponent(actor.clerkUserId)}`;
          const clerkHeaders = { Authorization: `Bearer ${deps.clerkSecretKey}` };
          let del: { ok: boolean; status: number } | null = null;
          try {
            del = await fetchFn(clerkUrl, {
              method: 'DELETE',
              headers: clerkHeaders,
              // fetch has no default timeout; a stalled Clerk upstream
              // would pin this request's transaction and pool client.
              signal: AbortSignal.timeout(10_000),
            });
          } catch {
            del = null;
          }

          // Three-way outcome. 'unknown' matters: on a timeout/network
          // error/5xx Clerk may have PROCESSED the delete even though we
          // never saw the response — restoring blindly would resurrect a
          // ghost account whose user.deleted webhook no-op'd against our
          // durable stamp, and whose live-looking owner row corrupts
          // last-owner guards. Confirm actual state before deciding.
          let outcome: 'deleted' | 'alive' | 'unknown';
          if (del && (del.ok || del.status === 404)) {
            outcome = 'deleted'; // 404 = already gone upstream
          } else if (del && del.status < 500) {
            outcome = 'alive'; // definite 4xx (auth/config) — nothing was deleted
          } else {
            outcome = 'unknown';
            try {
              const check = await fetchFn(clerkUrl, {
                headers: clerkHeaders,
                signal: AbortSignal.timeout(10_000),
              });
              if (check.status === 404) outcome = 'deleted';
              else if (check.ok) outcome = 'alive';
            } catch {
              // stays unknown
            }
          }

          if (outcome === 'alive') {
            // Compensate: the account must stay fully usable after a failed
            // attempt. Disconnect-safe (runDurable): if the client dropped
            // during the Clerk sequence the request client is already
            // released, so the restore self-commits on a fresh connection.
            // Otherwise forceCommit opts the >=400 response out of the
            // middleware's rollback-on-error. (If the freed mobile number
            // was reclaimed meanwhile, restoreAccount still restores access
            // and only drops the number.)
            await runDurable(() =>
              userRepo.restoreAccount(tenantId, actor.id, actor.mobileNumber ?? null),
            );
            res.locals.forceCommit = true;
            res.status(502).json({
              error: 'ACCOUNT_DELETE_FAILED',
              message: 'Could not delete the account right now. Please try again.',
            });
            return;
          }
          if (outcome === 'unknown') {
            // Tenant integrity over single-account availability: we could
            // not confirm Clerk's state, so the durable stamp stays (a
            // wrongly-restored ghost owner would corrupt owner guards).
            // Support can restore the row if Clerk turns out to be intact.
            // This is a terminal deactivation — the device's push tokens
            // must die here too, exactly like the success path.
            await purgeTokens();
            // Terminal deactivation needs its own audit record: the webhook
            // may never fire in exactly this scenario, and even when it does
            // its deleted_at IS NULL update no-ops against our stamp and
            // writes nothing — support would otherwise be asked to reverse a
            // deactivation with no trail. Best-effort + savepoint-isolated
            // like every post-Clerk write.
            if (auditRepo) {
              try {
                await runDurable(() =>
                  withRequestSavepoint(() =>
                    auditRepo.create(
                      createAuditEvent({
                        tenantId,
                        actorId: clerkUserId,
                        actorRole: req.auth!.role,
                        eventType: 'user.account_deletion_unconfirmed',
                        entityType: 'user',
                        entityId: actor.id,
                        metadata: {
                          self: true,
                          role: actor.role,
                          note:
                            'Deletion reserved locally but Clerk state unconfirmable ' +
                            '(DELETE and verification GET both ambiguous). Account left ' +
                            'deactivated; support may finish or reverse it.',
                        },
                      }),
                    ),
                  ),
                );
              } catch {
                // Never fail the terminal response over the audit write.
              }
            }
            res.locals.forceCommit = true;
            res.status(502).json({
              error: 'ACCOUNT_DELETE_FAILED',
              message:
                'We could not confirm the deletion with the sign-in provider. ' +
                'Your account is deactivated; contact support to finish or reverse it.',
            });
            return;
          }
          // outcome === 'deleted' → proceed to cleanup + success.
        }

        // Push tokens must die with the account (best-effort, SAVEPOINT-
        // isolated, disconnect-safe — see purgeTokens).
        await purgeTokens();

        // Best-effort, SAVEPOINT-isolated, AND disconnect/commit-durable
        // (runDurable) like the token purge: the deletion stamp committed
        // early, so if this insert is lost to a disconnect rollback or a
        // failed response-time COMMIT, the webhook's no-op stamp would never
        // write a replacement record and the completed deletion would have
        // no audit trail.
        if (auditRepo) {
          try {
            await runDurable(() =>
              withRequestSavepoint(() =>
                auditRepo.create(
                  createAuditEvent({
                    tenantId,
                    actorId: clerkUserId,
                    actorRole: req.auth!.role,
                    eventType: 'user.account_deleted',
                    entityType: 'user',
                    entityId: actor.id,
                    metadata: {
                      self: true,
                      role: actor.role,
                      note:
                        'Self-service account deletion (guideline 5.1.1(v)). Row soft-deleted; ' +
                        'tenant data retained per 16D.',
                    },
                  }),
                ),
              ),
            );
          } catch {
            // Never fail a completed deletion over the audit write.
          }
        }

        res.json({ deleted: true });
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

        // D2-1c — audit-log the invitation. Entity id is the local pending
        // invitation row (matches the eventual users.id that the Clerk
        // webhook stamps on accept; until then, the pending row is the
        // only durable id we can reference).
        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'user.invited',
              entityType: 'pending_invitation',
              entityId: local.id,
              metadata: {
                invitedEmail: parsed.email,
                invitedRole: parsed.role,
              },
            }),
          );
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
