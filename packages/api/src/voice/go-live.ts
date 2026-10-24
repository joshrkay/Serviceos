import type { Pool, PoolClient } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { withTenantClient } from '../db/tenant-transaction';

export type GoLiveSource = 'manual' | 'auto_test_call';

// The tenant_settings statements here run under the tenant's context
// (`rls_app_runtime`, raw-pg audit 2026-10-23 §4 P1.5) via `withTenantClient`:
// inside POST /go-live and /pause that is the request's own client, so the
// stamp commits or rolls back with its audit row; on the session-end auto path
// it is one short tenant transaction, committed before the audit write.

/** voice_agent_live_at, read on a client already scoped to the tenant. */
export async function loadVoiceAgentLiveAt(client: PoolClient, tenantId: string): Promise<Date | null> {
  const res = await client.query<{ voice_agent_live_at: Date | null }>(
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
  // Check-and-set on the WHERE clause (same pattern as activation.ts's
  // once-only guard): the stored value was already idempotent via COALESCE,
  // but the audit emission below was not — it fired unconditionally even
  // when the tenant was already live. #1605 makes the auto-go-live path
  // (maybeAutoGoLiveOnInboundEnd) reachable for the first time, so a manual
  // "Turn on AI answering" click racing — or simply following — that auto
  // flip must not emit a second, conflicting `tenant.voice_agent_live` row
  // for the one real transition.
  const { newlyWentLive, liveAt } = await withTenantClient(deps.pool, input.tenantId, async (client) => {
    const updateRes = await client.query<{ voice_agent_live_at: Date }>(
      `UPDATE tenant_settings
          SET voice_agent_live_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1 AND voice_agent_live_at IS NULL
        RETURNING voice_agent_live_at`,
      [input.tenantId],
    );
    const newly = (updateRes.rowCount ?? 0) > 0;
    return {
      newlyWentLive: newly,
      liveAt: newly ? updateRes.rows[0]!.voice_agent_live_at : await loadVoiceAgentLiveAt(client, input.tenantId),
    };
  });
  if (newlyWentLive) {
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
  }
  return {
    voiceAgentLive: liveAt != null,
    voiceAgentLiveAt: liveAt?.toISOString() ?? null,
  };
}

export async function pauseVoiceAgentLive(
  deps: { pool: Pool; auditRepo: AuditRepository },
  input: { tenantId: string; actorId: string },
): Promise<{ voiceAgentLive: false }> {
  await withTenantClient(deps.pool, input.tenantId, (client) =>
    client.query(
      `UPDATE tenant_settings SET voice_agent_live_at = NULL, updated_at = NOW() WHERE tenant_id = $1`,
      [input.tenantId],
    ),
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
  if (await withTenantClient(deps.pool, input.tenantId, (client) => loadVoiceAgentLiveAt(client, input.tenantId))) {
    return;
  }
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
