import { describe, it, expect } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  attemptIntegrationTransition,
  recordTransitionResult,
} from '../../src/integrations/status-machine';

describe('tenant integration status transitions', () => {
  it('allows valid progression and audits attempt + success', async () => {
    const audit = new InMemoryAuditRepository();
    const attempt = await attemptIntegrationTransition({
      tenantId: '11111111-1111-1111-1111-111111111111',
      integrationId: 'int-1',
      provider: 'twilio',
      actorId: 'system',
      actorRole: 'system',
      from: 't0_requested',
      to: 'partial_readiness',
      auditRepo: audit,
    });
    expect(attempt.allowed).toBe(true);
    await recordTransitionResult({
      tenantId: '11111111-1111-1111-1111-111111111111',
      integrationId: 'int-1',
      provider: 'twilio',
      actorId: 'system',
      actorRole: 'system',
      to: 'partial_readiness',
      success: true,
      auditRepo: audit,
    });
    expect(audit.getAll().map((e) => e.eventType)).toEqual([
      'tenant_integration.transition_attempt',
      'tenant_integration.transition_succeeded',
    ]);
  });

  it('rejects invalid transition and supports compensation audit trail', async () => {
    const audit = new InMemoryAuditRepository();
    const attempt = await attemptIntegrationTransition({
      tenantId: '11111111-1111-1111-1111-111111111111',
      integrationId: 'int-2',
      provider: 'sendgrid',
      actorId: 'system',
      actorRole: 'system',
      from: 't0_requested',
      to: 'full_readiness',
      auditRepo: audit,
    });
    expect(attempt.allowed).toBe(false);
    await recordTransitionResult({
      tenantId: '11111111-1111-1111-1111-111111111111',
      integrationId: 'int-2',
      provider: 'sendgrid',
      actorId: 'system',
      actorRole: 'system',
      to: 'failed_compensated',
      success: false,
      error: 'dns setup timed out, rolled back',
      auditRepo: audit,
      metadata: { compensation: true },
    });
    expect(audit.getAll().map((e) => e.eventType)).toEqual([
      'tenant_integration.transition_rejected',
      'tenant_integration.transition_failed',
    ]);
  });
});
