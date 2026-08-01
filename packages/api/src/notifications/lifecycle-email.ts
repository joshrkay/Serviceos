/**
 * At-most-once send path for onboarding lifecycle emails (welcome,
 * setup-reminder, trial-ending). Shared by the event-driven welcome worker
 * and the setup/trial sweeps so all three go through one idempotency gate.
 *
 * The `lifecycle_emails` table (migration 204) is the gate: one row per
 * (tenant, kind). We CLAIM the row with INSERT … ON CONFLICT DO NOTHING and
 * only send when we created it — so the welcome event firing, a sweep, and a
 * webhook/queue retry can never double-send. If the transport throws, we
 * RELEASE the claim so the next attempt can re-send; if it succeeds we leave
 * the row as the permanent "already sent" marker.
 */
import type { Pool } from 'pg';
import type { MessageDeliveryProvider } from './delivery-provider';
import type { RenderedEmail } from './templates';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { Logger } from '../logging/logger';

export type LifecycleEmailKind =
  | 'welcome'
  | 'setup_reminder'
  | 'trial_3d'
  | 'trial_1d'
  | 'trial_0d';

const ACTOR = 'system:lifecycle_email';

export interface LifecycleEmailDeps {
  /** Null in dev/test without a DB → the send path no-ops (parity with sweeps). */
  pool: Pool | null;
  /** Null when no provider is configured → no-op. */
  delivery: MessageDeliveryProvider | null;
  auditRepo?: AuditRepository;
  logger: Logger;
}

export interface SendLifecycleEmailInput {
  tenantId: string;
  kind: LifecycleEmailKind;
  to: string;
  rendered: RenderedEmail;
}

export type SendLifecycleEmailOutcome = 'sent' | 'duplicate' | 'skipped';

/**
 * Claims the (tenant, kind) ledger row. Returns true iff this call created it
 * (i.e. the caller now owns the right to act). Also used by the setup-reminder
 * sweep to "stamp without sending" tenants that turned out already complete, so
 * the sweep stops re-evaluating them.
 */
export async function claimLifecycleEmail(
  pool: Pool,
  tenantId: string,
  kind: LifecycleEmailKind,
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO lifecycle_emails (tenant_id, kind)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, kind) DO NOTHING
     RETURNING tenant_id`,
    [tenantId, kind],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Releases a previously-claimed row so a later attempt can re-claim + send. */
async function releaseLifecycleEmail(
  pool: Pool,
  tenantId: string,
  kind: LifecycleEmailKind,
): Promise<void> {
  await pool.query(`DELETE FROM lifecycle_emails WHERE tenant_id = $1 AND kind = $2`, [
    tenantId,
    kind,
  ]);
}

export async function sendLifecycleEmail(
  deps: LifecycleEmailDeps,
  input: SendLifecycleEmailInput,
): Promise<SendLifecycleEmailOutcome> {
  const { pool, delivery } = deps;
  if (!pool || !delivery) {
    // No DB or no provider — mirror the no-op posture of the SMS sweeps so the
    // app boots and tests run without credentials.
    deps.logger.info('Lifecycle email skipped (no pool/provider)', {
      tenantId: input.tenantId,
      kind: input.kind,
    });
    return 'skipped';
  }

  const claimed = await claimLifecycleEmail(pool, input.tenantId, input.kind);
  if (!claimed) return 'duplicate';

  try {
    await delivery.sendEmail({
      to: input.to,
      subject: input.rendered.subject,
      text: input.rendered.text,
      html: input.rendered.html,
      tenantId: input.tenantId,
      idempotencyKey: `lifecycle:${input.kind}:${input.tenantId}`,
    });
  } catch (err) {
    // Roll back the claim so the next sweep / retry can re-send.
    await releaseLifecycleEmail(pool, input.tenantId, input.kind).catch(() => undefined);
    throw err;
  }

  if (deps.auditRepo) {
    await deps.auditRepo
      .create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: ACTOR,
          actorRole: 'system',
          eventType: 'notification.lifecycle_email.sent',
          entityType: 'tenant',
          entityId: input.tenantId,
          metadata: { kind: input.kind },
        }),
      )
      // Email already sent — never re-throw on an audit write failure.
      .catch((err) =>
        deps.logger.warn('Lifecycle email audit write failed', {
          tenantId: input.tenantId,
          kind: input.kind,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  return 'sent';
}
