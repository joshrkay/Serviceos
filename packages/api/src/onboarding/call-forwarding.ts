/**
 * D-044 / #1765 — the owner's call-forwarding setup: which carrier they use
 * and whether they forward missed calls only or every call
 * (`tenant_settings.call_forwarding_*`, migration 332). The codes themselves
 * live in @ai-service-os/shared (call-forwarding).
 *
 * `checkPassedAt` is the last passing forwarding check (#1766). It is cleared
 * whenever the carrier or mode changes: a different setup is a different
 * forward, so the old pass says nothing about it.
 */
import type { Pool } from 'pg';
import type { CallForwardingCarrier, CallForwardingMode } from '@ai-service-os/shared';
import { PgBaseRepository } from '../db/pg-base';

export interface CallForwardingChoice {
  carrier: CallForwardingCarrier;
  mode: CallForwardingMode;
}

export interface CallForwardingSetup extends CallForwardingChoice {
  checkPassedAt: Date | null;
}

export interface CallForwardingRepository {
  /** Null until the owner has picked a carrier. */
  get(tenantId: string): Promise<CallForwardingSetup | null>;
  /**
   * Returns the previous setup (null if none), or `undefined` when the tenant
   * has no settings row to record it on. Clears the last passing check when
   * the carrier or mode differs from what was stored.
   */
  save(
    tenantId: string,
    choice: CallForwardingChoice,
  ): Promise<CallForwardingSetup | null | undefined>;
  /**
   * Records a pass for a check placed from `rivetNumber`. False when no setup
   * exists to record it on, or when the tenant's Rivet number is no longer
   * that one: a number change voids the proof, and a check from the released
   * number must not restore it.
   */
  recordCheckPassed(tenantId: string, at: Date, rivetNumber: string): Promise<boolean>;
}

export class InMemoryCallForwardingRepository implements CallForwardingRepository {
  private readonly rows = new Map<string, CallForwardingSetup>();

  async get(tenantId: string): Promise<CallForwardingSetup | null> {
    return this.rows.get(tenantId) ?? null;
  }

  async save(tenantId: string, choice: CallForwardingChoice) {
    const previous = this.rows.get(tenantId) ?? null;
    const unchanged =
      previous !== null && previous.carrier === choice.carrier && previous.mode === choice.mode;
    this.rows.set(tenantId, {
      ...choice,
      checkPassedAt: unchanged ? previous.checkPassedAt : null,
    });
    return previous;
  }

  async recordCheckPassed(tenantId: string, at: Date, _rivetNumber: string): Promise<boolean> {
    const row = this.rows.get(tenantId);
    if (!row) return false;
    this.rows.set(tenantId, { ...row, checkPassedAt: at });
    return true;
  }
}

interface Row {
  call_forwarding_carrier: CallForwardingCarrier | null;
  call_forwarding_mode: CallForwardingMode | null;
  call_forwarding_verified_at: Date | null;
}

function toSetup(row: Row | undefined): CallForwardingSetup | null {
  if (!row?.call_forwarding_carrier) return null;
  return {
    carrier: row.call_forwarding_carrier,
    mode: row.call_forwarding_mode ?? 'missed',
    checkPassedAt: row.call_forwarding_verified_at,
  };
}

const COLUMNS = `call_forwarding_carrier, call_forwarding_mode, call_forwarding_verified_at`;

export class PgCallForwardingRepository
  extends PgBaseRepository
  implements CallForwardingRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async get(tenantId: string): Promise<CallForwardingSetup | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<Row>(
        `SELECT ${COLUMNS} FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      return toSetup(result.rows[0]);
    });
  }

  async save(tenantId: string, choice: CallForwardingChoice) {
    return this.withTenant(tenantId, async (client) => {
      const previous = await client.query<Row>(
        `SELECT ${COLUMNS} FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      if (previous.rows.length === 0) return undefined;
      await client.query(
        `UPDATE tenant_settings
            SET call_forwarding_verified_at = CASE
                  WHEN call_forwarding_carrier IS NOT DISTINCT FROM $2
                   AND call_forwarding_mode IS NOT DISTINCT FROM $3
                  THEN call_forwarding_verified_at ELSE NULL END,
                call_forwarding_carrier = $2,
                call_forwarding_mode = $3,
                updated_at = NOW()
          WHERE tenant_id = $1`,
        [tenantId, choice.carrier, choice.mode],
      );
      return toSetup(previous.rows[0]);
    });
  }

  async recordCheckPassed(tenantId: string, at: Date, rivetNumber: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      // The locked read of the Twilio line serialises against the number-change
      // worker's repoint: a pass recorded first is voided by the repoint, and a
      // pass that waits on the repoint sees the new number and records nothing.
      const result = await client.query(
        `WITH line AS (
           SELECT 1 FROM tenant_integrations
            WHERE tenant_id = $1 AND provider = 'twilio' AND provider_data->>'phoneE164' = $3
            FOR SHARE
         )
         UPDATE tenant_settings
            SET call_forwarding_verified_at = $2, updated_at = NOW()
          WHERE tenant_id = $1 AND call_forwarding_carrier IS NOT NULL
            AND EXISTS (SELECT 1 FROM line)`,
        [tenantId, at, rivetNumber],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
