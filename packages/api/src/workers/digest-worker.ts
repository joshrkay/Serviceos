/**
 * P5-020 — End-of-day digest worker.
 *
 * Sweeps all tenants hourly; for each tenant whose local time is in the
 * 6–9pm delivery window, builds the digest (via digest-builder) and sends
 * it to the owner's phone via SMS. Idempotency is enforced by a
 * UNIQUE(tenant_id, date) constraint on digest_entries. Owner reply
 * tracking via handleOwnerReply.
 *
 * Mirrors the P0-009 cross-tenant sweep pattern (overdue-invoice-worker).
 */
import { DateTime } from 'luxon';
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { buildDigestData } from '../digest/digest-builder';
import { renderDigest } from '../digest/digest-renderer';
import type { Logger } from '../logging/logger';
import type { SettingsRepository } from '../settings/settings';
import type { DigestEntry, DigestStatus, DigestSourceData } from '../digest/digest-types';

// ─────────────────────────────────────────────────────────────────────────────
// Repository interface + Pg implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestEntryRepository {
  findByTenantAndDate(tenantId: string, date: string): Promise<DigestEntry | null>;
  insert(tenantId: string, date: string, renderedText: string, sourceData: DigestSourceData): Promise<DigestEntry>;
  update(
    tenantId: string,
    date: string,
    patch: Partial<Pick<DigestEntry, 'status' | 'attemptCount' | 'deliveredAt' | 'ownerReply'>>,
  ): Promise<DigestEntry | null>;
}

function mapRow(row: Record<string, unknown>): DigestEntry {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    date: row.date as string,
    status: row.status as DigestStatus,
    attemptCount: row.attempt_count as number,
    renderedText: row.rendered_text as string,
    sourceData: row.source_data as DigestSourceData,
    ...(row.delivered_at != null ? { deliveredAt: new Date(row.delivered_at as string) } : {}),
    ...(row.owner_reply != null ? { ownerReply: row.owner_reply as string } : {}),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

const COLUMNS =
  'id, tenant_id, date::text AS date, status, attempt_count, rendered_text, source_data, delivered_at, owner_reply, created_at, updated_at';

export class PgDigestEntryRepository extends PgBaseRepository implements DigestEntryRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async findByTenantAndDate(tenantId: string, date: string): Promise<DigestEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM digest_entries WHERE tenant_id = $1 AND date = $2::date`,
        [tenantId, date],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async insert(
    tenantId: string,
    date: string,
    renderedText: string,
    sourceData: DigestSourceData,
  ): Promise<DigestEntry> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO digest_entries (tenant_id, date, rendered_text, source_data)
         VALUES ($1, $2::date, $3, $4::jsonb)
         ON CONFLICT (tenant_id, date) DO NOTHING
         RETURNING ${COLUMNS}`,
        [tenantId, date, renderedText, JSON.stringify(sourceData)],
      );
      if (rows.length > 0) return mapRow(rows[0]);
      // Conflict: another insert already owns this row — fetch it.
      const { rows: existing } = await client.query(
        `SELECT ${COLUMNS} FROM digest_entries WHERE tenant_id = $1 AND date = $2::date`,
        [tenantId, date],
      );
      if (existing.length === 0) {
        throw new Error(`digest_entries insert: conflict but no row for tenant ${tenantId} date ${date}`);
      }
      return mapRow(existing[0]);
    });
  }

  async update(
    tenantId: string,
    date: string,
    patch: Partial<Pick<DigestEntry, 'status' | 'attemptCount' | 'deliveredAt' | 'ownerReply'>>,
  ): Promise<DigestEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      const sets: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [tenantId, date];
      let idx = 3;
      if (patch.status !== undefined) {
        sets.push(`status = $${idx++}`);
        values.push(patch.status);
      }
      if (patch.attemptCount !== undefined) {
        sets.push(`attempt_count = $${idx++}`);
        values.push(patch.attemptCount);
      }
      if (patch.deliveredAt !== undefined) {
        sets.push(`delivered_at = $${idx++}`);
        values.push(patch.deliveredAt);
      }
      if (patch.ownerReply !== undefined) {
        sets.push(`owner_reply = $${idx++}`);
        values.push(patch.ownerReply);
      }
      if (sets.length === 1) return null; // nothing to update
      const { rows } = await client.query(
        `UPDATE digest_entries SET ${sets.join(', ')}
         WHERE tenant_id = $1 AND date = $2::date
         RETURNING ${COLUMNS}`,
        values,
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery window: 6pm–9pm local time
// ─────────────────────────────────────────────────────────────────────────────

const DELIVERY_HOUR_START = 18; // 6pm
const DELIVERY_HOUR_END = 21; // 9pm (exclusive)
const MAX_ATTEMPTS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Worker deps
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestSweepDeps {
  digestEntryRepo: DigestEntryRepository;
  settingsRepo: SettingsRepository;
  pool: Pool | null | undefined;
  listTenantIds: () => Promise<string[]>;
  sendSms?: (args: { to: string; body: string }) => Promise<unknown>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface DigestSweepResult {
  tenants: number;
  sent: number;
  skipped: number;
  failed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main sweep
// ─────────────────────────────────────────────────────────────────────────────

export async function runDigestSweep(deps: DigestSweepDeps): Promise<DigestSweepResult> {
  const now = (deps.now ?? (() => new Date()))();

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Digest sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, sent: 0, skipped: 0, failed: 0 };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const outcome = await processTenant(tenantId, now, deps);
      if (outcome === 'sent') sent++;
      else skipped++;
    } catch (err) {
      failed++;
      deps.logger.warn('Digest sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Digest sweep completed', {
    tenants: tenantIds.length,
    sent,
    skipped,
    failed,
  });

  return { tenants: tenantIds.length, sent, skipped, failed };
}

async function processTenant(
  tenantId: string,
  now: Date,
  deps: DigestSweepDeps,
): Promise<'sent' | 'skipped'> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  if (!settings) return 'skipped';

  const timezone = settings.timezone || 'America/New_York';
  const ownerPhone = settings.ownerPhone;
  if (!ownerPhone) return 'skipped';

  // Convert current UTC time to local time using luxon
  const localNow = DateTime.fromJSDate(now, { zone: timezone });
  const localHour = localNow.hour;

  // Only deliver in 6pm–9pm local window
  if (localHour < DELIVERY_HOUR_START || localHour >= DELIVERY_HOUR_END) {
    return 'skipped';
  }

  const localDate = localNow.toISODate(); // YYYY-MM-DD
  if (!localDate) return 'skipped';

  // Check idempotency: if digest already delivered/acked, skip
  const existing = await deps.digestEntryRepo.findByTenantAndDate(tenantId, localDate);
  if (existing) {
    if (existing.status === 'delivered' || existing.status === 'acked') {
      return 'skipped';
    }
    // Failed before — check attempt count
    if (existing.attemptCount >= MAX_ATTEMPTS) {
      return 'skipped';
    }
    // Retry
    return retryDigest(tenantId, localDate, existing, settings, deps, timezone, now);
  }

  // First attempt: build and insert
  return buildAndSendDigest(tenantId, localDate, settings, deps, timezone, now);
}

async function buildAndSendDigest(
  tenantId: string,
  localDate: string,
  settings: Awaited<ReturnType<SettingsRepository['findByTenant']>>,
  deps: DigestSweepDeps,
  timezone: string,
  now: Date,
): Promise<'sent' | 'skipped'> {
  // Compute UTC boundaries for the local date using luxon
  const localDt = DateTime.fromISO(localDate, { zone: timezone });
  const utcDayStart = localDt.startOf('day').toUTC().toJSDate();
  const utcDayEnd = localDt.endOf('day').toUTC().toJSDate();
  const localTomorrow = localDt.plus({ days: 1 });
  const utcTomorrowStart = localTomorrow.startOf('day').toUTC().toJSDate();
  const utcTomorrowEnd = localTomorrow.endOf('day').toUTC().toJSDate();

  if (!deps.pool) {
    deps.logger.info('Digest sweep: no pool, skipping build', { tenantId, localDate });
    return 'skipped';
  }

  const { sections, sourceData } = await buildDigestData(
    deps.pool,
    tenantId,
    localDate,
    utcDayStart,
    utcDayEnd,
    utcTomorrowStart,
    utcTomorrowEnd,
    timezone,
  );

  const businessName = settings?.businessName ?? 'Your ServiceOS';
  const signOff = businessName || 'Your ServiceOS';
  const messages = renderDigest(sections, signOff);
  const renderedText = messages.join('\n---\n');

  // Insert (idempotent: ON CONFLICT DO NOTHING returns existing row)
  const entry = await deps.digestEntryRepo.insert(tenantId, localDate, renderedText, sourceData);

  // If another worker already delivered this digest, skip
  if (entry.status === 'delivered' || entry.status === 'acked') {
    return 'skipped';
  }

  return sendAndRecord(tenantId, localDate, entry, messages, settings?.ownerPhone ?? '', deps);
}

async function retryDigest(
  tenantId: string,
  localDate: string,
  entry: DigestEntry,
  settings: Awaited<ReturnType<SettingsRepository['findByTenant']>>,
  deps: DigestSweepDeps,
  timezone: string,
  now: Date,
): Promise<'sent' | 'skipped'> {
  const messages = entry.renderedText.split('\n---\n');
  return sendAndRecord(tenantId, localDate, entry, messages, settings?.ownerPhone ?? '', deps);
}

async function sendAndRecord(
  tenantId: string,
  localDate: string,
  entry: DigestEntry,
  messages: string[],
  ownerPhone: string,
  deps: DigestSweepDeps,
): Promise<'sent' | 'skipped'> {
  if (!deps.sendSms || !ownerPhone) {
    deps.logger.info('Digest sweep: no SMS transport or owner phone, stored only', {
      tenantId,
      localDate,
    });
    return 'skipped';
  }

  try {
    // Send all message parts
    for (const body of messages) {
      await deps.sendSms({ to: ownerPhone, body });
    }
    await deps.digestEntryRepo.update(tenantId, localDate, {
      status: 'delivered',
      deliveredAt: new Date(),
      attemptCount: entry.attemptCount + 1,
    });
    deps.logger.info('Digest sweep: delivered', { tenantId, localDate });
    return 'sent';
  } catch (err) {
    // Increment attempt count and mark failed
    await deps.digestEntryRepo.update(tenantId, localDate, {
      status: 'failed',
      attemptCount: entry.attemptCount + 1,
    });
    deps.logger.warn('Digest sweep: SMS send failed', {
      tenantId,
      localDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'skipped';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner reply handler
// ─────────────────────────────────────────────────────────────────────────────

export async function handleOwnerReply(
  tenantId: string,
  body: string,
  digestEntryRepo: DigestEntryRepository,
  timezone: string,
  now: Date = new Date(),
): Promise<void> {
  const localDate = DateTime.fromJSDate(now, { zone: timezone }).toISODate();
  if (!localDate) return;

  const entry = await digestEntryRepo.findByTenantAndDate(tenantId, localDate);
  if (!entry) return;

  await digestEntryRepo.update(tenantId, localDate, {
    status: 'acked',
    ownerReply: body,
  });
}
