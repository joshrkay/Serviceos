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
  ): Promise<{ inserted: boolean }>;
}

export interface VapiWebhookDeps {
  pool: Pool;
  auditRepo: AuditRepository;
  webhookRepo: VapiWebhookRepository;
  /** VAPI_WEBHOOK_SECRET — the serverUrlSecret configured on the assistant. */
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

/** Record an ended inbound voice_session, tenant-scoped (RLS-safe). */
async function recordInboundSession(pool: Pool, tenantId: string, callId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO voice_sessions (tenant_id, channel, state, external_id, ended_at)
         VALUES ($1, 'voice_inbound', 'ended', $2, now())`,
      [tenantId, callId],
    );
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

  // 2. Idempotency — dedup on call id.
  const { inserted } = await deps.webhookRepo.recordReceipt(
    'vapi',
    callId,
    'call.ended',
    { tenantId: req.tenantId, fromE164 },
  );
  if (!inserted) {
    return { status: 200, body: { duplicate: true } };
  }

  // 3. Record the inbound session so test-call detection flips test_call→done.
  await recordInboundSession(deps.pool, req.tenantId, callId);

  // 4. Identity-based activation (no-op for verified/test callers, idempotent).
  const activation = await maybeFireActivationForInboundCall(
    { pool: deps.pool, auditRepo: deps.auditRepo, ...(deps.sendEmail ? { sendEmail: deps.sendEmail } : {}) },
    { tenantId: req.tenantId, fromE164 },
  );

  return {
    status: 200,
    body: { ok: true, callId, activated: activation.fired, reason: activation.reason ?? null },
  };
}
