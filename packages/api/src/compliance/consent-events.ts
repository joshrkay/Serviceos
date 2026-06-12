/**
 * RV-130 — append-only consent ledger (migration 168).
 *
 * Every consent-relevant moment appends ONE immutable event:
 *
 *   - the recording disclosure played and the caller stayed on the line
 *     → { kind: 'recording', state: 'implicit', source: 'voice' }
 *   - the caller objects ("stop recording")
 *     → { kind: 'recording', state: 'revoked', source: 'voice' }
 *   - SMS opt-in / STOP, portal toggles, manual operator changes
 *     → kind 'sms' | 'marketing' with state granted/revoked.
 *
 * Rows are never updated or deleted — the ledger IS the audit trail. The
 * mutable rollup lives on `customers.consent_status` (migration 132) and is
 * maintained by `updateDerivedConsentStatus` below.
 *
 * All queries carry an explicit `tenant_id = $n` predicate in addition to the
 * RLS GUC — belt and braces, matching the repo convention.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export type ConsentKind = 'recording' | 'sms' | 'marketing';
export type ConsentState = 'granted' | 'revoked' | 'implicit';
export type ConsentSource = 'voice' | 'sms' | 'portal' | 'manual';

export interface ConsentEventInput {
  tenantId: string;
  customerId?: string | null;
  /** Any phone formatting accepted; normalized to digits before persist. */
  phone: string;
  kind: ConsentKind;
  state: ConsentState;
  source: ConsentSource;
  voiceSessionId?: string | null;
}

export interface ConsentEventRow {
  id: string;
  tenantId: string;
  customerId: string | null;
  phoneNormalized: string;
  kind: ConsentKind;
  state: ConsentState;
  source: ConsentSource;
  voiceSessionId: string | null;
  createdAt: Date;
}

/** Digits-only normalization so lookups survive formatting drift. */
export function normalizeConsentPhone(phone: string): string {
  return (phone ?? '').replace(/\D/g, '');
}

export interface ConsentEventRepository {
  /** Append-only — there is intentionally no update/delete surface. */
  append(input: ConsentEventInput): Promise<ConsentEventRow>;
  /** Ledger for a phone, newest first. */
  listByPhone(tenantId: string, phone: string): Promise<ConsentEventRow[]>;
}

export class PgConsentEventRepository
  extends PgBaseRepository
  implements ConsentEventRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async append(input: ConsentEventInput): Promise<ConsentEventRow> {
    const phoneNormalized = normalizeConsentPhone(input.phone);
    return this.withTenant(input.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO consent_events
           (tenant_id, customer_id, phone_normalized, kind, state, source, voice_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_id, customer_id, phone_normalized, kind, state,
                   source, voice_session_id, created_at`,
        [
          input.tenantId,
          input.customerId ?? null,
          phoneNormalized,
          input.kind,
          input.state,
          input.source,
          input.voiceSessionId ?? null,
        ],
      );
      return mapRow(rows[0]);
    });
  }

  async listByPhone(tenantId: string, phone: string): Promise<ConsentEventRow[]> {
    const phoneNormalized = normalizeConsentPhone(phone);
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, customer_id, phone_normalized, kind, state,
                source, voice_session_id, created_at
           FROM consent_events
          WHERE tenant_id = $1 AND phone_normalized = $2
          ORDER BY created_at DESC`,
        [tenantId, phoneNormalized],
      );
      return rows.map(mapRow);
    });
  }
}

/** In-memory implementation for unit tests / no-pool dev. */
export class InMemoryConsentEventRepository implements ConsentEventRepository {
  public rows: ConsentEventRow[] = [];
  private seq = 0;

  async append(input: ConsentEventInput): Promise<ConsentEventRow> {
    const row: ConsentEventRow = {
      id: `consent_${++this.seq}`,
      tenantId: input.tenantId,
      customerId: input.customerId ?? null,
      phoneNormalized: normalizeConsentPhone(input.phone),
      kind: input.kind,
      state: input.state,
      source: input.source,
      voiceSessionId: input.voiceSessionId ?? null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async listByPhone(tenantId: string, phone: string): Promise<ConsentEventRow[]> {
    const phoneNormalized = normalizeConsentPhone(phone);
    return this.rows
      .filter(
        (r) => r.tenantId === tenantId && r.phoneNormalized === phoneNormalized,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }
}

// ─── Derived customers.consent_status updater ───────────────────────────────

/**
 * Map a ledger event to the `customers.consent_status` value (migration 132)
 * it should roll up to, or null when the event must NOT touch the derived
 * status:
 *
 *   - 'implicit' recording consent never upgrades a customer to 'granted' —
 *     consent_status gates OUTBOUND contact under the TCPA; staying on an
 *     inbound line is not prior express consent for outbound calls.
 *   - explicit 'granted'/'revoked' (any kind) move the rollup. A recording
 *     objection is treated as a revocation signal too: the safest posture is
 *     to stop outbound automation for a caller who objected on a call.
 */
export function deriveConsentStatus(
  event: Pick<ConsentEventInput, 'state'>,
): 'granted' | 'revoked' | null {
  if (event.state === 'granted') return 'granted';
  if (event.state === 'revoked') return 'revoked';
  return null;
}

/**
 * Roll the latest explicit ledger event up onto the customer row. No-op when
 * the event is implicit or no customer was matched. Uses a direct UPDATE with
 * explicit tenant predicate (the customers repo has no consent-field surface;
 * consent columns are owned by the compliance layer).
 */
export async function updateDerivedConsentStatus(
  pool: Pool,
  event: ConsentEventInput,
): Promise<boolean> {
  const status = deriveConsentStatus(event);
  if (!status || !event.customerId) return false;
  const repo = new (class extends PgBaseRepository {
    async run(tenantId: string, customerId: string): Promise<boolean> {
      return this.withTenant(tenantId, async (client) => {
        const result = await client.query(
          `UPDATE customers
              SET consent_status = $3,
                  consent_recorded_at = now(),
                  consent_recorded_by = 'consent-ledger',
                  consent_method = $4,
                  updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, customerId, status, event.source],
        );
        return (result.rowCount ?? 0) > 0;
      });
    }
  })(pool);
  return repo.run(event.tenantId, event.customerId);
}

function mapRow(row: Record<string, unknown>): ConsentEventRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    customerId: row.customer_id === null ? null : String(row.customer_id),
    phoneNormalized: String(row.phone_normalized),
    kind: String(row.kind) as ConsentKind,
    state: String(row.state) as ConsentState,
    source: String(row.source) as ConsentSource,
    voiceSessionId: (row.voice_session_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}
