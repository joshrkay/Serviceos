/**
 * P20-002 — Pg-backed dunning config + event repositories.
 *
 * The DB UNIQUE (tenant_id) on invoice_dunning_configs and UNIQUE
 * (tenant_id, invoice_id, kind, step_key) on invoice_dunning_events are
 * the source of truth. Event inserts that lose a race surface as code 23505
 * to the worker, which treats them as "another sweep already did this step".
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DunningChannel,
  DunningConfig,
  DunningConfigRepository,
  DunningEvent,
  DunningEventKind,
  DunningEventRepository,
  LateFeeType,
  ReminderStep,
} from './dunning-config';

function mapConfig(row: Record<string, unknown>): DunningConfig {
  const steps = row.reminder_steps;
  const reminderSteps: ReminderStep[] = Array.isArray(steps)
    ? (steps as ReminderStep[])
    : typeof steps === 'string'
      ? (JSON.parse(steps) as ReminderStep[])
      : [];
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    enabled: row.enabled as boolean,
    reminderSteps,
    lateFeeType: row.late_fee_type as LateFeeType,
    lateFeeValueCents: Number(row.late_fee_value_cents),
    lateFeeGraceDays: Number(row.late_fee_grace_days),
    lateFeeMaxCents:
      row.late_fee_max_cents === null || row.late_fee_max_cents === undefined
        ? undefined
        : Number(row.late_fee_max_cents),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapEvent(row: Record<string, unknown>): DunningEvent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    invoiceId: row.invoice_id as string,
    kind: row.kind as DunningEventKind,
    stepKey: row.step_key as string,
    amountCents:
      row.amount_cents === null || row.amount_cents === undefined
        ? undefined
        : Number(row.amount_cents),
    channel: (row.channel as DunningChannel) ?? undefined,
    sentAt: new Date(row.sent_at as string),
  };
}

export class PgDunningConfigRepository
  extends PgBaseRepository
  implements DunningConfigRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async findByTenant(tenantId: string): Promise<DunningConfig | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM invoice_dunning_configs WHERE tenant_id = $1',
        [tenantId],
      );
      return result.rows.length > 0 ? mapConfig(result.rows[0]) : null;
    });
  }

  async upsert(config: DunningConfig): Promise<DunningConfig> {
    return this.withTenant(config.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO invoice_dunning_configs (
          id, tenant_id, enabled, reminder_steps, late_fee_type,
          late_fee_value_cents, late_fee_grace_days, late_fee_max_cents,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (tenant_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          reminder_steps = EXCLUDED.reminder_steps,
          late_fee_type = EXCLUDED.late_fee_type,
          late_fee_value_cents = EXCLUDED.late_fee_value_cents,
          late_fee_grace_days = EXCLUDED.late_fee_grace_days,
          late_fee_max_cents = EXCLUDED.late_fee_max_cents,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
        [
          config.id,
          config.tenantId,
          config.enabled,
          JSON.stringify(config.reminderSteps),
          config.lateFeeType,
          config.lateFeeValueCents,
          config.lateFeeGraceDays,
          config.lateFeeMaxCents ?? null,
          config.createdAt,
          config.updatedAt,
        ],
      );
      return mapConfig(result.rows[0]);
    });
  }
}

export class PgDunningEventRepository
  extends PgBaseRepository
  implements DunningEventRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(event: DunningEvent): Promise<DunningEvent> {
    return this.withTenant(event.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO invoice_dunning_events (
          id, tenant_id, invoice_id, kind, step_key, amount_cents, channel, sent_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          event.id,
          event.tenantId,
          event.invoiceId,
          event.kind,
          event.stepKey,
          event.amountCents ?? null,
          event.channel ?? null,
          event.sentAt,
        ],
      );
      return mapEvent(result.rows[0]);
    });
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<DunningEvent[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM invoice_dunning_events
         WHERE tenant_id = $1 AND invoice_id = $2
         ORDER BY sent_at ASC`,
        [tenantId, invoiceId],
      );
      return result.rows.map(mapEvent);
    });
  }

  async deleteByInvoiceStep(
    tenantId: string,
    invoiceId: string,
    kind: DunningEvent['kind'],
    stepKey: string,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `DELETE FROM invoice_dunning_events
         WHERE tenant_id = $1 AND invoice_id = $2 AND kind = $3 AND step_key = $4`,
        [tenantId, invoiceId, kind, stepKey],
      );
    });
  }
}
