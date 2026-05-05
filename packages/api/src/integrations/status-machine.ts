import { AuditRepository, createAuditEvent } from '../audit/audit';

export type TenantIntegrationStatus =
  | 't0_requested'
  | 'partial_readiness'
  | 'pending_compliance_dns'
  | 'full_readiness'
  | 'failed'
  | 'compensating'
  | 'failed_compensated'
  | 'suspended'
  | 'terminated'
  | 'releasing';

const ALLOWED_TRANSITIONS: Record<TenantIntegrationStatus, TenantIntegrationStatus[]> = {
  t0_requested: ['partial_readiness', 'failed'],
  partial_readiness: ['pending_compliance_dns', 'failed'],
  pending_compliance_dns: ['full_readiness', 'failed'],
  full_readiness: ['suspended', 'releasing', 'terminated'],
  failed: ['compensating', 'failed_compensated'],
  compensating: ['failed_compensated'],
  failed_compensated: [],
  suspended: ['full_readiness', 'terminated'],
  terminated: [],
  releasing: ['terminated', 'failed'],
};

export async function attemptIntegrationTransition(input: {
  tenantId: string;
  integrationId: string;
  provider: string;
  actorId: string;
  actorRole: string;
  from: TenantIntegrationStatus;
  to: TenantIntegrationStatus;
  auditRepo: AuditRepository;
  metadata?: Record<string, unknown>;
}): Promise<{ allowed: boolean }> {
  const allowed = ALLOWED_TRANSITIONS[input.from]?.includes(input.to) ?? false;
  await input.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      eventType: allowed
        ? 'tenant_integration.transition_attempt'
        : 'tenant_integration.transition_rejected',
      entityType: 'tenant_integration',
      entityId: input.integrationId,
      metadata: { provider: input.provider, from: input.from, to: input.to, ...input.metadata },
    }),
  );
  return { allowed };
}

export async function recordTransitionResult(input: {
  tenantId: string;
  integrationId: string;
  provider: string;
  actorId: string;
  actorRole: string;
  to: TenantIntegrationStatus;
  auditRepo: AuditRepository;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await input.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      eventType: input.success
        ? 'tenant_integration.transition_succeeded'
        : 'tenant_integration.transition_failed',
      entityType: 'tenant_integration',
      entityId: input.integrationId,
      metadata: {
        provider: input.provider,
        to: input.to,
        ...(input.error ? { error: input.error } : {}),
        ...input.metadata,
      },
    }),
  );
}
