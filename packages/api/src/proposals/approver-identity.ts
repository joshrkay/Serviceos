/**
 * RV-070 — shared approver-identity check.
 *
 * One trust model, two transports: the SMS reply handler (P2-034) and the
 * voice owner-line recognition (RV-070) must agree on WHO counts as an
 * approver — `tenant_settings.owner_phone` plus the backup supervisor's
 * mobile — and on the phone normalization that makes '+1 (512) 555-0100'
 * and '15125550100' the same identity. Extracted from
 * `proposals/sms/reply-handler.ts` (which now imports it) so the two
 * channels can never drift.
 *
 * Caller-ID / SMS From are spoofable; this is deliberately the same trust
 * level as the existing SMS approval channel (plan D1 — one trust model,
 * two transports). Money/irreversible voice approvals therefore additionally
 * require the spoken challenge.
 *
 * Identity is ALWAYS the transport-level phone (inbound SMS `From`, or
 * telephony caller-ID), never message/utterance content. This provides
 * transport-level identification, not cryptographic identity proof.
 */
import type { SettingsRepository } from '../settings/settings';
import type { UserRepository } from '../users/user';
import { normalizePhone } from '../shared/phone';

export interface ApproverIdentityDeps {
  settingsRepo: SettingsRepository;
  /** Resolves the backup supervisor's mobile. Optional — owner_phone still works. */
  userRepo?: UserRepository;
}

/**
 * The phones allowed to approve for a tenant: `tenant_settings.owner_phone`
 * first, then the backup supervisor's mobile (when configured and a
 * userRepo is wired). Raw values — callers compare via `isApprover`,
 * which normalizes both sides.
 */
export async function resolveApproverPhones(
  deps: ApproverIdentityDeps,
  tenantId: string,
): Promise<string[]> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const phones: string[] = [];
  if (settings?.ownerPhone) phones.push(settings.ownerPhone);
  if (settings?.backupSupervisorUserId && deps.userRepo) {
    const backup = await deps.userRepo.findById(tenantId, settings.backupSupervisorUserId);
    if (backup?.mobileNumber) phones.push(backup.mobileNumber);
  }
  return phones;
}

/** True when `fromE164` normalizes to one of the approver phones. */
export function isApprover(phones: string[], fromE164: string): boolean {
  const from = normalizePhone(fromE164);
  if (!from) return false;
  return phones.some((p) => normalizePhone(p) === from);
}

/**
 * Convenience composition: is this inbound caller/sender phone an approver
 * for the tenant? Used by the telephony adapters to stamp
 * `ownerSession: true` on the FSM session context (RV-070).
 * Note: matching is transport-level (caller-ID / SMS From) — not
 * identity-proof.
 */
export async function isApproverPhone(
  deps: ApproverIdentityDeps,
  tenantId: string,
  fromE164: string | undefined | null,
): Promise<boolean> {
  if (!fromE164) return false;
  const phones = await resolveApproverPhones(deps, tenantId);
  return isApprover(phones, fromE164);
}
