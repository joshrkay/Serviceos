/**
 * RV-070 — owner-line recognition. True when the inbound caller-ID matches
 * `tenant_settings.owner_phone` or the backup supervisor's mobile (normalized
 * E.164 comparison — the SAME identity logic as the SMS reply transport, via
 * `proposals/approver-identity.ts`). Best effort and fail-closed: a
 * settings/user lookup failure returns false so a degraded dependency can
 * never mint an owner session.
 *
 * #1601 step 2 — the one copy. `telephony/twilio-adapter.ts` (production)
 * and the Layer 1 `text-mode-driver.ts` each resolved this themselves; the
 * driver's copy never threaded `userRepo`, so the backup supervisor's mobile
 * was a stranger on the harness and an owner line in production. Both now
 * call this. Transport-level recognition, not identity proof: the Gather
 * adapter still ANDs the result with STIR/SHAKEN A-attestation (#1223).
 *
 * B1 — the Gather adapter also needs WHO the line approves as (the owner, or
 * the backup supervisor as their own role), so it resolves the approver
 * itself (`resolveOwnerLineApprover`) and carries it on the session; the
 * boolean is that approver's presence.
 */
import type { SettingsRepository } from '../../../settings/settings';
import type { UserRepository } from '../../../users/user';
import { resolveApproverRole, type ResolvedApprover } from '../../../proposals/approver-identity';
import { createLogger } from '../../../logging/logger';

const logger = createLogger({
  service: 'ai.voice-turn.owner-session',
  environment: process.env.NODE_ENV || 'development',
});

export interface OwnerSessionDeps {
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  /** Resolves the backup supervisor's mobile. Optional — owner_phone still works. */
  userRepo?: Pick<UserRepository, 'findById'>;
}

/** The approver this caller-ID is (owner / backup as their role), or null. Fail closed. */
export async function resolveOwnerLineApprover(
  deps: OwnerSessionDeps,
  tenantId: string,
  from: string | undefined,
): Promise<ResolvedApprover | null> {
  if (!deps.settingsRepo || !from) return null;
  try {
    return await resolveApproverRole(
      {
        settingsRepo: deps.settingsRepo,
        ...(deps.userRepo ? { userRepo: deps.userRepo } : {}),
      },
      tenantId,
      from,
    );
  } catch (err) {
    logger.warn('resolveOwnerSession failed — treating caller as non-owner', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function resolveOwnerSession(
  deps: OwnerSessionDeps,
  tenantId: string,
  from: string | undefined,
): Promise<boolean> {
  return (await resolveOwnerLineApprover(deps, tenantId, from)) !== null;
}
