/**
 * U5 — audit → PostHog forwarding decorator.
 *
 * Wraps any `AuditRepository` and, after the inner `create()` resolves,
 * forwards the persisted event to PostHog as a product event (via the pure
 * `auditEventToProductEvent` mapper + `recordProductEvent`). Installed once at
 * the composition root (`app.ts`) so every mutation's audit write — ~270 call
 * sites across all domains — is covered by a single edit.
 *
 * Invariants:
 *   - Off-by-default: skips all mapping/forwarding when analytics is disabled.
 *   - Never breaks a mutation: forwarding runs AFTER the awaited inner write
 *     and is wrapped in try/catch. If `inner.create` rejects, nothing
 *     persisted, so nothing forwards. The inner result is returned verbatim.
 *   - Read methods delegate unchanged.
 *
 * Deps are injectable so the unit + integration tests can substitute a spy
 * without mocking the module graph; they default to the real functions.
 */
import type { AuditEvent, AuditRepository } from './audit';
import {
  auditEventToProductEvent,
  type ProductEvent,
} from '../analytics/audit-event-mapping';
import {
  isProductAnalyticsEnabled,
  recordProductEvent,
  type ProductEventPayload,
} from '../analytics/posthog';
import type { ProductEventName } from '../analytics/product-events';

export interface ForwardingDeps {
  isEnabled?: () => boolean;
  map?: (event: AuditEvent) => ProductEvent | null;
  record?: (name: ProductEventName, payload: ProductEventPayload) => void;
}

export class ForwardingAuditRepository implements AuditRepository {
  private readonly isEnabled: () => boolean;
  private readonly map: (event: AuditEvent) => ProductEvent | null;
  private readonly record: (name: ProductEventName, payload: ProductEventPayload) => void;

  constructor(
    private readonly inner: AuditRepository,
    deps: ForwardingDeps = {},
  ) {
    this.isEnabled = deps.isEnabled ?? isProductAnalyticsEnabled;
    this.map = deps.map ?? auditEventToProductEvent;
    this.record = deps.record ?? recordProductEvent;

    // `findRecentByTenant` is optional on the interface — mirror the inner
    // repo's capability exactly so the activity-feed reporter's presence check
    // (`if (!auditRepo.findRecentByTenant)`) stays accurate through the wrap.
    if (this.inner.findRecentByTenant) {
      this.findRecentByTenant = (tenantId, opts) => this.inner.findRecentByTenant!(tenantId, opts);
    }
  }

  async create(event: AuditEvent): Promise<AuditEvent> {
    const saved = await this.inner.create(event);
    if (this.isEnabled()) {
      try {
        const productEvent = this.map(saved);
        if (productEvent) {
          this.record(productEvent.name, {
            tenantId: productEvent.tenantId,
            distinctId: productEvent.distinctId,
            insertId: productEvent.insertId,
            properties: productEvent.properties,
          });
        }
      } catch {
        // Analytics must never break a mutation. `saved` is already persisted.
      }
    }
    return saved;
  }

  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]> {
    return this.inner.findByEntity(tenantId, entityType, entityId);
  }

  findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]> {
    return this.inner.findByCorrelation(tenantId, correlationId);
  }

  // Assigned in the constructor only when the inner repo supports it, so the
  // decorator advertises the same optional capability as what it wraps.
  findRecentByTenant?: (
    tenantId: string,
    opts?: { limit?: number },
  ) => Promise<AuditEvent[]>;
}
