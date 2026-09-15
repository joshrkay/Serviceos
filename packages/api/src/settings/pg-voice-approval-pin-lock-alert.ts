import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type {
  VoiceApprovalPinLockAlertClaim,
  VoiceApprovalPinLockAlertRepository,
} from './voice-approval-pin-lock-alert';

/**
 * #1233 review — Postgres claim for the tenant PIN-lock owner alert. The
 * primary key (tenant_id, episode_key) makes the insert the arbiter: under any
 * concurrency exactly one INSERT for an episode returns a row. Tenant-scoped
 * (RLS FORCE on the table, migration 279).
 */
export class PgVoiceApprovalPinLockAlertRepository
  extends PgBaseRepository
  implements VoiceApprovalPinLockAlertRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async claim(input: VoiceApprovalPinLockAlertClaim): Promise<boolean> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_approval_pin_lock_alerts (tenant_id, episode_key, session_id, strike_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, episode_key) DO NOTHING
         RETURNING tenant_id`,
        [input.tenantId, input.episodeKey, input.sessionId ?? null, input.strikeCount],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
