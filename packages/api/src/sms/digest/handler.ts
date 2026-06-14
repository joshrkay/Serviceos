import { InboundSmsContext, HandlerResult } from '../inbound-dispatch';
import { UserRepository } from '../../users/user';
import type { SettingsRepository } from '../../settings/settings';
import {
  DigestEntryRepository,
  handleOwnerReply,
} from '../../workers/digest-worker';

/**
 * P5-020 — digest acknowledgement via SMS ("LOOKS GOOD").
 *
 * This is the SMS transport for the digest owner-reply: it verifies the sender
 * is the tenant owner, recognizes the ack phrase, then delegates to main's
 * `handleOwnerReply`, which marks the tenant's digest for its local date
 * `acked` and records the reply. The tenant timezone is resolved here (from
 * settings) so the ack lands on the digest the sweep wrote for the tenant's
 * local date rather than a hardcoded zone.
 */
export interface DigestAckHandlerDeps {
  userRepo: UserRepository;
  digestRepo: DigestEntryRepository;
  settingsRepo: SettingsRepository;
}

export async function handleDigestAckSms(
  ctx: InboundSmsContext,
  deps: DigestAckHandlerDeps,
): Promise<HandlerResult> {
  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user || user.role !== 'owner') {
    return { handled: false, handler: 'digest-ack', reason: 'unknown_mobile' };
  }

  const token = ctx.body.trim().toLowerCase();
  if (!token.includes('looks') || !token.includes('good')) {
    return { handled: false, handler: 'digest-ack', reason: 'unrecognized' };
  }

  const settings = await deps.settingsRepo.findByTenant(ctx.tenantId);
  const tz = settings?.timezone ?? 'America/New_York';
  await handleOwnerReply(ctx.tenantId, ctx.body.trim(), deps.digestRepo, tz);

  return { handled: true, handler: 'digest-ack', reason: 'acked' };
}
