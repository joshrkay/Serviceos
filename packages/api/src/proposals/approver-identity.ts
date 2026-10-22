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
 * B1 — and on WHAT that approver may do. Recognising the phone is not
 * authority: the owner phone approves as the owner, the backup supervisor
 * approves as the role they actually hold (a dispatcher backup must not clear
 * the owner-only settings:update gate, nor stamp 'owner' on the correction
 * lessons their edits cascade into the price book). `resolveApproverRole`
 * returns that identity; every phone-identified approval channel (SMS reply,
 * voice owner line, the one-tap link minted for the backup) acts with it.
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
import type { User, UserRepository } from '../users/user';
import { findActiveTenantMember } from '../users/tenant-member';
import { isValidRole, type Role } from '../auth/rbac';
import { normalizePhone } from '../shared/phone';
import { createLogger, type Logger } from '../logging/logger';

const logger = createLogger({
  service: 'approver-identity',
  environment: process.env.NODE_ENV || 'development',
});

export interface ApproverIdentityDeps {
  /** Only `findByTenant` is read (owner_phone + backupSupervisorUserId). */
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  /**
   * Resolves the backup supervisor's mobile and role. Optional — owner_phone
   * still works. Only `findById` is read (#1601 step 2 narrowed the type so
   * the Layer 1 driver's partial repo qualifies; no runtime change).
   */
  userRepo?: Pick<UserRepository, 'findById'>;
}

/** B1 — the identity a phone-identified approval acts with. */
export interface ResolvedApprover {
  role: Role;
  /**
   * The backup supervisor's user subject — the Clerk subject when they have
   * one, else the users row id (the phone-actor convention,
   * telephony/phone-actor.ts, so an approval attributes to the same id a
   * dashboard tap would). Absent for the owner phone: those approvals keep
   * the channel's synthetic actor (SMS_REPLY_ACTOR_ID, VOICE_APPROVAL_ACTOR_ID,
   * the one-tap actor) exactly as before.
   */
  userId?: string;
  via: 'owner_phone' | 'backup_supervisor';
}

/**
 * Who `fromE164` approves as for this tenant:
 *   - it matches `tenant_settings.owner_phone` → the owner (checked first,
 *     so a backup who shares the owner's phone is the owner);
 *   - it matches the backup supervisor's mobile, that user is an active
 *     member (#1402 §13 — a deactivated backup approves nothing), and their
 *     role is a real role → that role and their subject;
 *   - otherwise null. Fail closed: an unknown role is no authority at all.
 * The role is not checked for `proposals:approve` here — the approval
 * actions refuse it with the role in hand, and each channel says so plainly.
 */
export async function resolveApproverRole(
  deps: ApproverIdentityDeps,
  tenantId: string,
  fromE164: string,
): Promise<ResolvedApprover | null> {
  const from = normalizePhone(fromE164);
  if (!from) return null;
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  if (settings?.ownerPhone && normalizePhone(settings.ownerPhone) === from) {
    return { role: 'owner', via: 'owner_phone' };
  }
  const backup = await activeBackup(deps, tenantId, settings?.backupSupervisorUserId);
  if (!backup?.mobileNumber || normalizePhone(backup.mobileNumber) !== from) return null;
  return backupApprover(backup);
}

/**
 * B1 — the tenant's backup supervisor as an approver RIGHT NOW (an active
 * member with a real role), whatever phone is asking; null otherwise. The
 * one-tap route re-checks a link minted for the backup against this when it
 * is tapped, so a backup who was replaced, deactivated or re-roled after the
 * text went out approves as who they are now — or not at all.
 */
export async function resolveBackupSupervisorApprover(
  deps: ApproverIdentityDeps,
  tenantId: string,
): Promise<ResolvedApprover | null> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const backup = await activeBackup(deps, tenantId, settings?.backupSupervisorUserId);
  return backup ? backupApprover(backup) : null;
}

/** The backup supervisor's users row when they are an active member with a real role. */
async function activeBackup(
  deps: ApproverIdentityDeps,
  tenantId: string,
  backupUserId: string | null | undefined,
): Promise<(User & { role: Role }) | null> {
  if (!backupUserId || !deps.userRepo) return null;
  // #1402 §13 — a deactivated (or deleted, or other-tenant) backup is nobody.
  const backup = await findActiveTenantMember(deps.userRepo, tenantId, backupUserId);
  return backup && isValidRole(backup.role) ? (backup as User & { role: Role }) : null;
}

function backupApprover(backup: User & { role: Role }): ResolvedApprover {
  return { role: backup.role, userId: backup.clerkUserId ?? backup.id, via: 'backup_supervisor' };
}

export interface ApprovalSmsRecipientDeps extends ApproverIdentityDeps {
  /** Where the skipped-backup line goes; defaults to this module's logger. */
  logger?: Pick<Logger, 'warn'>;
}

/** B3-2 — where an approval SMS goes, and whose phone that is. */
export interface ApprovalSmsRecipient {
  phone: string;
  /**
   * `owner_phone` — the owner by definition: the router needs no approver
   * lookup (one that fails would turn the owner's approval text into the
   * for-your-info form). `backup_supervisor` — the backup's mobile; the
   * router looks up who they approve as and fails closed if it cannot.
   */
  via: ResolvedApprover['via'];
}

/**
 * B1 follow-up — where an approval SMS goes (the unsupervised routing SMS,
 * the voice one-tap fallback, the owner close chain): `owner_phone`, else the
 * backup supervisor's mobile — only while that backup is an active member of
 * this tenant (#1402 §13, the same check `resolveApproverRole` makes). A
 * deactivated, removed or other-tenant backup is no recipient: null, so the
 * caller's no-phone path applies (the card waits in the queue, the routing
 * audit records smsSent: false), and the skip is logged. The role is NOT
 * checked here — a backup who cannot approve still hears about the work, as
 * a for-your-info text (renderProposalSms `recipientCannotApprove`).
 * B3-2 — it says which of the two the phone is, from this same read.
 */
export async function resolveApprovalSmsRecipient(
  deps: ApprovalSmsRecipientDeps,
  tenantId: string,
): Promise<ApprovalSmsRecipient | null> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  if (settings?.ownerPhone) return { phone: settings.ownerPhone, via: 'owner_phone' };
  const backupUserId = settings?.backupSupervisorUserId;
  if (!backupUserId || !deps.userRepo) return null;
  const backup = await findActiveTenantMember(deps.userRepo, tenantId, backupUserId);
  if (!backup) {
    (deps.logger ?? logger).warn(
      'backup supervisor is not an active member of this tenant — no approval SMS sent',
      { tenantId, backupSupervisorUserId: backupUserId },
    );
    return null;
  }
  return backup.mobileNumber ? { phone: backup.mobileNumber, via: 'backup_supervisor' } : null;
}

/** The approval SMS phone alone (`resolveApprovalSmsRecipient`), for the owner alerts that only need a number. */
export async function resolveApprovalSmsPhone(
  deps: ApprovalSmsRecipientDeps,
  tenantId: string,
): Promise<string | null> {
  return (await resolveApprovalSmsRecipient(deps, tenantId))?.phone ?? null;
}

/**
 * Convenience composition: is this inbound caller/sender phone an approver
 * for the tenant? Used by the voicemail → action-router gate. Matching is
 * transport-level (caller-ID / SMS From) — not identity-proof.
 */
export async function isApproverPhone(
  deps: ApproverIdentityDeps,
  tenantId: string,
  fromE164: string | undefined | null,
): Promise<boolean> {
  if (!fromE164) return false;
  return (await resolveApproverRole(deps, tenantId, fromE164)) !== null;
}
