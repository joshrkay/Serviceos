/**
 * Per-tenant WS connection registry.
 *
 * Counts open connections per tenant and per surface so the upgrade /
 * start path can reject when a tenant exceeds its cap. The registry is
 * a process-local in-memory map; horizontally scaled deployments need
 * either sticky routing or a shared backend.
 */
import { wsConnections } from '../monitoring/metrics';

export interface ConnectionRegistryConfig {
  /** Max concurrent connections per tenant, per surface. */
  perTenantMax: number;
}

export const DEFAULT_REGISTRY_CONFIG: ConnectionRegistryConfig = {
  perTenantMax: 50,
};

export class ConnectionRegistry {
  private counts: Map<string, number> = new Map();

  constructor(private readonly cfg: ConnectionRegistryConfig = DEFAULT_REGISTRY_CONFIG) {}

  private key(surface: string, tenantId: string): string {
    return `${surface}|${tenantId}`;
  }

  /** Returns false if the tenant is at or over the cap. */
  tryAcquire(surface: string, tenantId: string, tier: string = 'standard'): boolean {
    const k = this.key(surface, tenantId);
    const cur = this.counts.get(k) ?? 0;
    if (cur >= this.cfg.perTenantMax) return false;
    this.counts.set(k, cur + 1);
    wsConnections.inc({ surface, tenant_tier: tier });
    return true;
  }

  release(surface: string, tenantId: string, tier: string = 'standard'): void {
    const k = this.key(surface, tenantId);
    const cur = this.counts.get(k) ?? 0;
    if (cur <= 1) {
      this.counts.delete(k);
    } else {
      this.counts.set(k, cur - 1);
    }
    wsConnections.dec({ surface, tenant_tier: tier });
  }

  count(surface: string, tenantId: string): number {
    return this.counts.get(this.key(surface, tenantId)) ?? 0;
  }
}

/** Process-wide singleton; tests can construct their own. */
export const globalConnectionRegistry = new ConnectionRegistry();
