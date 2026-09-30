/**
 * #1402 §18 — per-recipient outbound SMS volume ledger.
 *
 * Backs the volume cap in GatedMessageDelivery: at most `maxPerWindow`
 * customer texts to one phone number per tenant in any rolling
 * `windowHours`. The ledger's one operation is an ATOMIC reserve — count the
 * sends in the window and, if under the cap, record this one — so two
 * concurrent sends can never both slip past the last slot. A reservation is
 * released when the provider send then fails, so a carrier error does not
 * burn the customer's allowance.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export interface RecipientVolumeReservation {
  /** True when this send fits under the cap and has been recorded. */
  allowed: boolean;
  /** Sends already recorded in the window BEFORE this attempt. */
  sentInWindow: number;
  /** Present when allowed — pass to `release` if the send then fails. */
  reservationId?: string;
}

export interface RecipientSmsVolumeLedger {
  reserve(
    tenantId: string,
    normalizedPhone: string,
    limits: { maxPerWindow: number; windowHours: number },
  ): Promise<RecipientVolumeReservation>;
  release(tenantId: string, reservationId: string): Promise<void>;
  /**
   * #1524 — read-only count of the sends recorded to this number in the
   * rolling window. Reserves nothing: it answers "would the next text be
   * capped?" before a human approves one.
   */
  sentInWindow(tenantId: string, normalizedPhone: string, windowHours: number): Promise<number>;
}

/** In-process ledger for tests and no-DB dev. `now` is injectable for window tests. */
export class InMemoryRecipientSmsVolumeLedger implements RecipientSmsVolumeLedger {
  private rows: Array<{ id: string; tenantId: string; phone: string; sentAt: number }> = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async reserve(
    tenantId: string,
    normalizedPhone: string,
    limits: { maxPerWindow: number; windowHours: number },
  ): Promise<RecipientVolumeReservation> {
    const nowMs = this.now().getTime();
    const since = nowMs - limits.windowHours * 3_600_000;
    const sentInWindow = this.rows.filter(
      (r) => r.tenantId === tenantId && r.phone === normalizedPhone && r.sentAt > since,
    ).length;
    if (sentInWindow >= limits.maxPerWindow) return { allowed: false, sentInWindow };
    this.seq += 1;
    const id = `mem-${this.seq}`;
    this.rows.push({ id, tenantId, phone: normalizedPhone, sentAt: nowMs });
    return { allowed: true, sentInWindow, reservationId: id };
  }

  async release(tenantId: string, reservationId: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.tenantId === tenantId && r.id === reservationId));
  }

  async sentInWindow(tenantId: string, normalizedPhone: string, windowHours: number): Promise<number> {
    const since = this.now().getTime() - windowHours * 3_600_000;
    return this.rows.filter((r) => r.tenantId === tenantId && r.phone === normalizedPhone && r.sentAt > since)
      .length;
  }
}

/**
 * Postgres ledger over `sms_recipient_sends` (migration 300). The reserve is
 * serialized per (tenant, number) with a transaction-scoped advisory lock, so
 * concurrent sends to one number queue behind each other while sends to
 * different numbers never contend. Rows older than a week are pruned for the
 * number being reserved, which keeps the table bounded without a sweep.
 */
export class PgRecipientSmsVolumeLedger extends PgBaseRepository implements RecipientSmsVolumeLedger {
  constructor(pool: Pool) {
    super(pool);
  }

  async reserve(
    tenantId: string,
    normalizedPhone: string,
    limits: { maxPerWindow: number; windowHours: number },
  ): Promise<RecipientVolumeReservation> {
    return this.withTenantTransaction(tenantId, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `sms-volume:${tenantId}:${normalizedPhone}`,
      ]);
      await client.query(
        `DELETE FROM sms_recipient_sends
          WHERE tenant_id = $1 AND phone = $2 AND sent_at < NOW() - INTERVAL '7 days'`,
        [tenantId, normalizedPhone],
      );
      const counted = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sms_recipient_sends
          WHERE tenant_id = $1 AND phone = $2
            AND sent_at > NOW() - ($3::int * INTERVAL '1 hour')`,
        [tenantId, normalizedPhone, limits.windowHours],
      );
      const sentInWindow = Number(counted.rows[0]?.n ?? 0);
      if (sentInWindow >= limits.maxPerWindow) return { allowed: false, sentInWindow };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO sms_recipient_sends (tenant_id, phone) VALUES ($1, $2) RETURNING id`,
        [tenantId, normalizedPhone],
      );
      return { allowed: true, sentInWindow, reservationId: inserted.rows[0].id };
    });
  }

  async sentInWindow(tenantId: string, normalizedPhone: string, windowHours: number): Promise<number> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const counted = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sms_recipient_sends
          WHERE tenant_id = $1 AND phone = $2
            AND sent_at > NOW() - ($3::int * INTERVAL '1 hour')`,
        [tenantId, normalizedPhone, windowHours],
      );
      return Number(counted.rows[0]?.n ?? 0);
    });
  }

  async release(tenantId: string, reservationId: string): Promise<void> {
    await this.withTenantTransaction(tenantId, (client) =>
      client.query(`DELETE FROM sms_recipient_sends WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        reservationId,
      ]),
    );
  }
}
