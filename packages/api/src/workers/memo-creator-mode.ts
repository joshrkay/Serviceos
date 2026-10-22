/**
 * C-1698-P1 — the voice-memo worker's creator-mode lookup (OVAS-04's
 * `resolveMemberMode`: the memo creator's `users.current_mode` sets the
 * auto-approve threshold).
 *
 * Deliberately NOT the request path's mode loader (middleware/auth.ts,
 * behind `req.auth.mode`), which this worker used to share: there mode is not
 * a security boundary, so a missing user or a DB error becomes 'supervisor' —
 * the most permissive per-mode threshold — and is cached for 60 seconds. On
 * this path the mode decides whether a memo executes without a human, so it
 * must fail closed:
 *   - no users row for (tenant, Clerk subject) → null;
 *   - a DB error → rejects (the error is preserved).
 * Either way memoCreator.mode() (workers/voice-action-router.ts) resolves
 * undefined — logging the error — and resolveAutoApproveThreshold applies the
 * documented fallback: the strictest defined tenant override. A real row's
 * 'supervisor' (the column's NOT NULL default) is the member's real mode.
 *
 * `getService` is read at call time: app.ts builds the UserModeService after
 * the worker is constructed, and the lookup only runs once the app serves.
 */
import type { Mode } from '../proposals/auto-approve';
import type { UserModeService } from '../routes/me';

export function createMemoCreatorModeLoader(
  getService: () => Pick<UserModeService, 'getUser'>,
): (tenantId: string, userId: string) => Promise<Mode | null> {
  return async (tenantId, userId) => (await getService().getUser(tenantId, userId))?.current_mode ?? null;
}
