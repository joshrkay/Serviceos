/**
 * Vapi inbound-call webhook handler.
 *
 * Vapi POSTs call lifecycle events (status-update / end-of-call-report) to the
 * per-tenant `/webhooks/vapi/:tenantId` route. This handler:
 *
 *   1. Verifies the Vapi signature (fails closed → 403).
 *   2. Dedups by call id via the shared webhook_events store (idempotent on
 *      replay — Vapi retries deliveries).
 *   3. On an ended inbound call, records a voice_sessions row so the existing
 *      derive-status test-call detection flips test_call → done (which makes
 *      the browser fire test_call_succeeded).
 *   4. Runs identity-based activation: if the caller is NOT one of the
 *      tenant's verified phones, fires first_real_call_received exactly once.
 *
 * VOX-04 — the dedup receipt (step 2) is committed to `webhook_events`
 * BEFORE steps 3/4 run, but it must not be treated as "done" until steps
 * 3/4 actually succeed. Otherwise a transient failure in step 3/4 (e.g. a
 * DB blip) leaves the receipt row present-but-unprocessed; Vapi's retry
 * would see `inserted:false` and short-circuit to a 200 duplicate ack,
 * permanently swallowing the voice_sessions write and the activation.
 * We mirror the Twilio webhook's recordReceipt/markProcessed pattern
 * (see `recordTwilio` in webhooks/routes.ts): short-circuit ONLY when the
 * existing receipt is already marked `processedAt` (genuine duplicate —
 * the work already ran); an unprocessed receipt falls through and
 * reprocesses. `markProcessed` is stamped only after steps 3/4 both
 * succeed. `recordInboundSession` is itself made idempotent (checks for
 * an existing row before inserting) so a reprocess after a step-3-success/
 * step-4-failure split can't double-insert a voice_sessions row.
 */
import type { Pool } from 'pg';
import type { AuditRepository } from '../../audit/audit';
import type { SendEmailFn } from '../../voice/check-upgrade-nudge';
import { verifyVapiSignature } from './signature';
import { maybeFireActivationForInboundCall } from '../../voice/activation';

export interface VapiWebhookRepository {
  recordReceipt(
    provider: string,
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<{ inserted: boolean; record?: { processedAt?: Date | null } }>;
  /**
   * Stamps the receipt as fully processed. Called only after steps 3/4
   * both succeed, so a crash/error anywhere before this point leaves the
   * receipt unprocessed and a retry reprocesses (see file header).
   */
  markProcessed(provider: string, eventId: string): Promise<void>;
}

export interface VapiWebhookDeps {
  pool: Pool;
  auditRepo: AuditRepository;
  webhookRepo: VapiWebhookRepository;
  /**
   * The tenant's per-tenant Vapi `serverUrlSecret` (from
   * `tenant_settings.vapi_webhook_secret`). Empty string when the tenant has no
   * provisioned secret — verification then fails closed (403). The global
   * `VAPI_WEBHOOK_SECRET` fallback was removed in QUALITY-2026-07-12 WS4.
   */
  secret: string;
  sendEmail?: SendEmailFn;
}

export interface VapiWebhookRequest {
  tenantId: string;
  rawBody: string;
  signatureHeader?: string | null;
  sharedSecretHeader?: string | null;
}

export interface VapiWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

interface ParsedCall {
  callId: string | null;
  fromE164: string | null;
  ended: boolean;
}

function parseVapiEvent(rawBody: string): ParsedCall {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { callId: null, fromE164: null, ended: false };
  }
  const msg = (parsed.message ?? parsed) as Record<string, unknown>;
  const type = msg.type as string | undefined;
  const status = msg.status as string | undefined;
  const call = (msg.call ?? {}) as Record<string, unknown>;
  const customer = (msg.customer ?? call.customer ?? {}) as Record<string, unknown>;

  const callId =
    (call.id as string | undefined) ??
    (msg.callId as string | undefined) ??
    (parsed.id as string | undefined) ??
    null;
  const fromE164 =
    (customer.number as string | undefined) ??
    (call.from as string | undefined) ??
    (msg.from as string | undefined) ??
    null;
  const ended =
    type === 'end-of-call-report' ||
    type === 'call.ended' ||
    (type === 'status-update' && status === 'ended');

  return { callId, fromE164, ended };
}

/**
 * Record an ended inbound voice_session, tenant-scoped (RLS-safe).
 *
 * Idempotent by (tenant_id, channel, external_id): the dedup receipt in
 * `handleVapiCallEvent` is only committed-as-done AFTER this succeeds, so a
 * retry that reprocesses (step 3/4 failed the first time) would otherwise
 * insert a second voice_sessions row for the same call. `voice_sessions`
 * has no unique constraint on external_id, so we guard here rather than via
 * ON CONFLICT.
 */
async function recordInboundSession(pool: Pool, tenantId: string, callId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const existing = await client.query(
      `SELECT 1 FROM voice_sessions
        WHERE tenant_id = $1 AND channel = 'voice_inbound' AND external_id = $2
        LIMIT 1`,
      [tenantId, callId],
    );
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO voice_sessions (tenant_id, channel, state, external_id, ended_at)
           VALUES ($1, 'voice_inbound', 'ended', $2, now())`,
        [tenantId, callId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function handleVapiCallEvent(
  deps: VapiWebhookDeps,
  req: VapiWebhookRequest,
): Promise<VapiWebhookResult> {
  // 1. Signature — fail closed.
  const ok = verifyVapiSignature({
    rawBody: req.rawBody,
    secret: deps.secret,
    signatureHeader: req.signatureHeader ?? null,
    sharedSecretHeader: req.sharedSecretHeader ?? null,
  });
  if (!ok) {
    return { status: 403, body: { error: 'INVALID_SIGNATURE' } };
  }

  const { callId, fromE164, ended } = parseVapiEvent(req.rawBody);
  if (!ended || !callId) {
    // Non-terminal event (ringing, in-progress, etc.) — ack and ignore.
    return { status: 200, body: { ignored: true } };
  }

  // 2. Idempotency — dedup on call id. Short-circuit ONLY on a fully-processed
  // duplicate; a receipt row that exists but was never marked processed means
  // an earlier delivery died between receipt and dispatch (crash, transient
  // DB error in step 3/4) — Vapi's retry is our only chance to run the
  // handler, so it must fall through and reprocess. Mirrors the Twilio
  // webhook's recordReceipt/markProcessed pattern (see `recordTwilio` in
  // webhooks/routes.ts).
  const receipt = await deps.webhookRepo.recordReceipt(
    'vapi',
    callId,
    'call.ended',
    { tenantId: req.tenantId, fromE164 },
  );
  if (!receipt.inserted && receipt.record?.processedAt) {
    return { status: 200, body: { duplicate: true } };
  }

  // 3. Record the inbound session so test-call detection flips test_call→done.
  await recordInboundSession(deps.pool, req.tenantId, callId);

  // 4. Identity-based activation (no-op for verified/test callers, idempotent).
  const activation = await maybeFireActivationForInboundCall(
    { pool: deps.pool, auditRepo: deps.auditRepo, ...(deps.sendEmail ? { sendEmail: deps.sendEmail } : {}) },
    { tenantId: req.tenantId, fromE164 },
  );

  // Processing complete — stamp the receipt so a crash anywhere above leaves
  // it unprocessed and a retry reprocesses (see step 2).
  await deps.webhookRepo.markProcessed('vapi', callId);

  return {
    status: 200,
    body: { ok: true, callId, activated: activation.fired, reason: activation.reason ?? null },
  };
}
