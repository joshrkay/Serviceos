/**
 * I12′ (§5.0b tier 2, #1020 / #1052) — the audit-outage double shared by the
 * real-Postgres swallow-site suites.
 */
import type { AuditEvent, AuditRepository } from '../../src/audit/audit';
import type { PgAuditRepository } from '../../src/audit/pg-audit';

/**
 * A real `PgAuditRepository` with ONE event type knocked out. `create` throws
 * for `failEventType` (the handler's tier-2 domain event, e.g.
 * `callback.acknowledged`) and delegates everything else, so the executor's
 * tier-1 write is genuinely a real-Postgres write on the real code path.
 * Generalised by event type for #1052 so every swallow-site handler can be
 * driven through the same double.
 */
export class Tier2FailingAuditRepository implements AuditRepository {
  public attemptedTier2 = 0;

  /**
   * `failForTenantId` scopes the outage to one tenant. The T1 test runs BOTH
   * tenants through a single failure-injected executor — one wired handler
   * instance serving many tenants, which is the production shape — so that a
   * process-wide outage could not pass as tenant isolation.
   */
  constructor(
    private readonly inner: PgAuditRepository,
    private readonly failEventType: string,
    private readonly failForTenantId?: string,
  ) {}

  async create(event: AuditEvent): Promise<AuditEvent> {
    const inScope =
      this.failForTenantId === undefined || event.tenantId === this.failForTenantId;
    if (event.eventType === this.failEventType && inScope) {
      this.attemptedTier2 += 1;
      throw new Error('audit store unavailable (I12′ simulated tier-2 outage)');
    }
    return this.inner.create(event);
  }

  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]> {
    return this.inner.findByEntity(tenantId, entityType, entityId);
  }

  findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]> {
    return this.inner.findByCorrelation(tenantId, correlationId);
  }
}

