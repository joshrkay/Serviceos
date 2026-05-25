import type { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';

export type GoLiveSource = 'manual' | 'auto_test_call';

export async function loadVoiceAgentLiveAt(pool: Pool, tenantId: string): Promise<Date | null> {
  const res = await pool.query<{ voice_agent_live_at: Date | null }>(
    `SELECT voice_agent_live_at FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return res.rows[0]?.voice_agent_live_at ?? null;
}

export async function subscriptionAllowsVoice(pool: Pool, tenantId: string): Promise<boolean> {
  const res = await pool.query<{ subscription_status: string | null }>(
    `SELECT subscription_status FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const status = res.rows[0]?.subscription_status;
  return status === 'trialing' || status === 'active';
}

export async function enableVoiceAgentLive(
  deps: { pool: Pool; auditRepo: AuditRepository },
  input: { tenantId: string; actorId: string; source: GoLiveSource },
): Promise<{ voiceAgentLive: boolean; voiceAgentLiveAt: string | null }> {
  await deps.pool.query(
    `UPDATE tenant_settings
        SET voice_agent_live_at = COALESCE(voice_agent_live_at, NOW()), updated_at = NOW()
      WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const liveAt = await loadVoiceAgentLiveAt(deps.pool, input.tenantId);
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.source === 'manual' ? 'owner' : 'system',
      eventType: 'tenant.voice_agent_live',
      entityType: 'tenant_settings',
      entityId: input.tenantId,
      metadata: { source: input.source },
    }),
  );
  return {
    voiceAgentLive: liveAt != null,
    voiceAgentLiveAt: liveAt?.toISOString() ?? null,
  };
}

export async function pauseVoiceAgentLive(
  deps: { pool: Pool; auditRepo: AuditRepository },
  input: { tenantId: string; actorId: string },
): Promise<{ voiceAgentLive: false }> {
  await deps.pool.query(
    `UPDATE tenant_settings SET voice_agent_live_at = NULL, updated_at = NOW() WHERE tenant_id = $1`,
    [input.tenantId],
  );
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: 'owner',
      eventType: 'tenant.voice_agent_paused',
      entityType: 'tenant_settings',
      entityId: input.tenantId,
      metadata: {},
    }),
  );
  return { voiceAgentLive: false };
}

export async function maybeAutoGoLiveOnInboundEnd(
  deps: { pool: Pool; auditRepo: AuditRepository },
  input: { tenantId: string; channel: string },
): Promise<void> {
  if (input.channel !== 'voice_inbound') return;
  if (!(await subscriptionAllowsVoice(deps.pool, input.tenantId))) return;
  if (await loadVoiceAgentLiveAt(deps.pool, input.tenantId)) return;
  try {
    await enableVoiceAgentLive(deps, {
      tenantId: input.tenantId,
      actorId: 'system',
      source: 'auto_test_call',
    });
  } catch {
    // Must not block session end — same bar as upgrade nudge.
  }
}
