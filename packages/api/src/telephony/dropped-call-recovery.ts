/**
 * B5 MVP — SMS the caller ~60s after a mid-intake hangup with a resume cue.
 * Template-only (brand-voice composer deferred). Not durable across restarts.
 */
import { createLogger } from '../logging/logger';
import { registerDroppedCallSession } from './dropped-call-session-bridge';

const logger = createLogger({
  service: 'telephony.dropped-call-recovery',
  environment: process.env.NODE_ENV || 'development',
});

const RECOVERY_DELAY_MS = 60_000;

export interface DroppedCallRecoveryInput {
  tenantId: string;
  sessionId: string;
  callerE164: string;
  shopName: string;
  sendSms: (args: { to: string; body: string }) => Promise<unknown>;
}

const scheduled = new Set<string>();

export function scheduleDroppedCallRecovery(input: DroppedCallRecoveryInput): void {
  const key = `${input.tenantId}:${input.sessionId}`;
  if (scheduled.has(key)) return;
  scheduled.add(key);
  registerDroppedCallSession(input.tenantId, input.callerE164, input.sessionId);

  const timer = setTimeout(() => {
    scheduled.delete(key);
    const body =
      `Hi — this is ${input.shopName}. We got cut off on your call. ` +
      `Reply to this text and we'll pick up where we left off.`;
    void input
      .sendSms({ to: input.callerE164, body })
      .catch((err) => {
        logger.warn('dropped-call-recovery: SMS failed', {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, RECOVERY_DELAY_MS);

  if (typeof timer.unref === 'function') timer.unref();
}
