import { InboundSmsContext, HandlerResult } from '../inbound-dispatch';
import type { DigestEntryRepository } from '../../digest/repository';
import { UserRepository } from '../../users/user';

/**
 * P5-020 — digest acknowledgement via SMS ("LOOKS GOOD").
 */
export interface DigestAckHandlerDeps {
  userRepo: UserRepository;
  digestRepo: DigestEntryRepository;
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

  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const entry = await deps.digestRepo.findByTenantDate(ctx.tenantId, localDate);
  if (entry) {
    await deps.digestRepo.markAcked(ctx.tenantId, entry.id);
  }

  return { handled: true, handler: 'digest-ack', reason: 'acked' };
}
