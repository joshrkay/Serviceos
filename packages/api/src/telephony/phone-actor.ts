/**
 * Caller-ID → actor for the live phone (#866, closes #843's auth question).
 *
 * The phone surface has only ever carried a boolean identity — `ownerSession`
 * (RV-070: caller-ID matched the owner phone or the backup supervisor's
 * mobile). The shared lookup dispatch (`workers/voice-lookup-answer.ts`)
 * authorises by ACTOR: it resolves the asking user's DB-authoritative role
 * and fails closed. `lookup_my_day` also needs the speaker's identity to
 * self-scope. So the phone resolves an actor, ONCE, where the session is
 * established, and stamps it on the session as `actorUserId`.
 *
 * Resolution order — every step tenant-scoped, none from utterance content:
 *   1. the tenant user whose registered mobile matches the caller-ID
 *      (`users.mobile_number`, P1-022). Covers technicians, dispatchers,
 *      owners with a mobile on their profile, and the backup supervisor.
 *   2. otherwise, if this is the owner line (`ownerSession`), the tenant's
 *      SINGLE active owner-role user. This bridges owners whose mobile is set
 *      in business settings (`tenant_settings.owner_phone`) but not on their
 *      team profile — without it the RBAC gate would REGRESS every such
 *      owner's revenue / digest / pending lookups from answered to refused.
 *      Two or more active owners is ambiguous → no actor (fail closed) and a
 *      warning, because the tenant can fix it on the team-members screen.
 *   3. otherwise no actor.
 *
 * Fail-soft: a repository error resolves nothing and never blocks the call.
 *
 * The returned `userId` is the Clerk subject when the user has one, else the
 * users row id — `resolveVoiceMemberRole` (app.ts) accepts either on the
 * in-memory path and keys on clerk_user_id on the Pg path, so a user who
 * never signed up cannot pass the owner-grade gate. That is correct.
 */
import { createLogger } from '../logging/logger';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import type { User, UserRepository } from '../users/user';

export interface PhoneActorDeps {
  userRepo?: Pick<UserRepository, 'findByMobileNumber' | 'findByTenant'>;
}

export interface PhoneActor {
  userId: string;
  via: 'mobile' | 'owner_phone';
}

const logger = createLogger({
  service: 'telephony.phone-actor',
  environment: process.env.NODE_ENV || 'development',
});

function isActive(u: User): boolean {
  return !u.deletedAt && u.status !== 'suspended';
}

function subjectOf(u: User): string {
  return u.clerkUserId ?? u.id;
}

export async function resolvePhoneActor(
  deps: PhoneActorDeps,
  tenantId: string,
  from: string | undefined,
  ownerSession: boolean,
): Promise<PhoneActor | null> {
  if (!deps.userRepo || !from) return null;

  let e164: string;
  try {
    e164 = normalizeMobileE164(from);
  } catch {
    return null; // withheld / non-numeric caller-ID — nothing to match on
  }

  try {
    const byMobile = await deps.userRepo.findByMobileNumber(tenantId, e164);
    if (byMobile && isActive(byMobile)) {
      return { userId: subjectOf(byMobile), via: 'mobile' };
    }

    if (!ownerSession) return null;

    const owners = (await deps.userRepo.findByTenant(tenantId, { role: 'owner' })).filter(isActive);
    if (owners.length === 1) {
      return { userId: subjectOf(owners[0]!), via: 'owner_phone' };
    }
    logger.warn('owner line could not be resolved to a single owner user — owner-grade lookups will refuse', {
      tenantId,
      activeOwners: owners.length,
      hint: 'add the owner\'s mobile number on their team-member profile',
    });
    return null;
  } catch (err) {
    logger.warn('resolvePhoneActor failed — treating caller as unresolved', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
