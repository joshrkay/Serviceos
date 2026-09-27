/**
 * #1233 review — the owner alert for the tenant-wide voice money-approval PIN
 * lock is CLAIMED before it is sent. A claim is an insert-if-absent keyed by
 * (tenant, lock episode): the first caller to claim an episode sends the one
 * alert; every other caller — a concurrent call, a later refusal, a retry after
 * a failed send — loses the claim and sends nothing. Backed in Postgres by
 * `voice_approval_pin_lock_alerts` (migration 279, primary key
 * (tenant_id, episode_key)).
 */

export interface VoiceApprovalPinLockAlertClaim {
  tenantId: string;
  /** Identifies the lock episode: the attempt that engaged it (voice-approval-tenant-lock.ts). */
  episodeKey: string;
  /** Voice session that claimed it, for the trail. */
  sessionId?: string;
  /** Counted attempts when the claim was made. */
  strikeCount: number;
}

export interface VoiceApprovalPinLockAlertRepository {
  /** True when this call won the claim (and so must send the alert); false when it was already taken. */
  claim(input: VoiceApprovalPinLockAlertClaim): Promise<boolean>;
  /**
   * #1238 — stamp the claim as delivered (idempotent; no-op when there is no
   * such claim for this tenant). Unsent claims are what the retry worker re-sends.
   */
  markSent(tenantId: string, episodeKey: string): Promise<void>;
  /** #1238 — true once the alert for this claim was delivered. */
  isSent(tenantId: string, episodeKey: string): Promise<boolean>;
}

export class InMemoryVoiceApprovalPinLockAlertRepository implements VoiceApprovalPinLockAlertRepository {
  private readonly rows: Array<VoiceApprovalPinLockAlertClaim & { createdAt: Date; sentAt?: Date }> = [];

  async claim(input: VoiceApprovalPinLockAlertClaim): Promise<boolean> {
    if (this.rows.some((r) => r.tenantId === input.tenantId && r.episodeKey === input.episodeKey)) {
      return false;
    }
    this.rows.push({ ...input, createdAt: new Date() });
    return true;
  }

  async markSent(tenantId: string, episodeKey: string): Promise<void> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.episodeKey === episodeKey);
    if (row && !row.sentAt) row.sentAt = new Date();
  }

  async isSent(tenantId: string, episodeKey: string): Promise<boolean> {
    return !!this.rows.find((r) => r.tenantId === tenantId && r.episodeKey === episodeKey)?.sentAt;
  }

  getAll(): Array<VoiceApprovalPinLockAlertClaim & { createdAt: Date; sentAt?: Date }> {
    return this.rows.map((r) => ({ ...r }));
  }
}
