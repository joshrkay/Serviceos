/**
 * TenantOwnership — cross-entity tenant isolation guard.
 *
 * Background: every entity create handler that references a parent id
 * (locations.customerId, jobs.customerId/locationId, appointments.jobId,
 * notes.entityId, estimates.jobId, invoices.jobId/estimateId) must
 * validate that the referenced parent belongs to the same tenant as
 * the requesting JWT. Without this check, a tenant B request can
 * create a child entity that references a tenant A parent — the
 * server stamps the new row with tenant B but leaks tenant A's
 * parent UUID through the persisted reference field.
 *
 * The adversarial tenant-isolation suite at
 * `packages/api/test/decisions/tenant-isolation.test.ts` proved this
 * gap was real on createJob first; this module is the fix.
 *
 * The check lives in one place — this interface — so route handlers
 * can call a single method instead of each one importing every parent
 * repo. It also makes the invariant easy to test in isolation: the
 * adversarial suite hits the route handlers, but unit tests for the
 * ownership impl can prove the lookup is tenant-scoped without
 * spinning up an HTTP layer.
 *
 * Throws NotFoundError on missing references — that's what the
 * route handlers' toErrorResponse already maps to a clean 404, which
 * is the correct shape for an idor-avoidance response.
 */

import { NotFoundError } from './errors';
import { CustomerRepository } from '../customers/customer';
import { LocationRepository } from '../locations/location';
import { JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository } from '../invoices/invoice';
import { AppointmentRepository } from '../appointments/appointment';
import { LeadRepository } from '../leads/lead';

export type OwnedEntityType =
  | 'customer'
  | 'location'
  | 'job'
  | 'estimate'
  | 'invoice'
  | 'appointment'
  | 'lead';

export interface TenantOwnership {
  /**
   * Throw NotFoundError if `entityId` does not exist within `tenantId`.
   * The label fields on NotFoundError use the entity type so error
   * bodies stay consistent across handlers.
   */
  requireExists(
    tenantId: string,
    entityType: OwnedEntityType,
    entityId: string
  ): Promise<void>;
  /**
   * Same as `requireExists` but returns the loaded row so callers can
   * read fields off it (e.g. customer.originatingLeadId for attribution
   * propagation) without paying for a second findById round-trip.
   * Returns `unknown` so the entity type doesn't leak into the
   * interface; callers cast at the call site.
   */
  requireExistsAndLoad(
    tenantId: string,
    entityType: OwnedEntityType,
    entityId: string
  ): Promise<unknown>;
}

export interface TenantOwnershipDeps {
  customerRepo: CustomerRepository;
  locationRepo: LocationRepository;
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  appointmentRepo: AppointmentRepository;
  /**
   * Optional — only required when a route validates an `originatingLeadId`
   * override (currently jobs.ts). Older callers built before P9 attribution
   * landed don't need to pass it.
   */
  leadRepo?: LeadRepository;
}

/**
 * Permissive ownership stub for unit-level route shape tests.
 *
 * Test fixtures in `packages/api/test/routes/*.route.test.ts` use
 * literal string ids like `'cust-1'` and `'loc-1'` without seeding
 * the parent entities first. They prove field shapes and HTTP status
 * codes, not security. Use this stub in those tests so the cross-
 * entity guard does not return 404 on an unseeded id.
 *
 * The HTTP-level adversarial coverage that proves the guard actually
 * works lives in
 * `packages/api/test/decisions/tenant-isolation.test.ts`, which uses
 * the real `createApp()` and the real `createTenantOwnership` impl.
 *
 * Do NOT use this in production wiring.
 */
export function permissiveTenantOwnership(): TenantOwnership {
  return {
    async requireExists() {
      // intentionally a no-op
    },
    async requireExistsAndLoad() {
      return undefined;
    },
  };
}

export function createTenantOwnership(deps: TenantOwnershipDeps): TenantOwnership {
  async function load(
    tenantId: string,
    entityType: OwnedEntityType,
    entityId: string
  ): Promise<unknown> {
    switch (entityType) {
      case 'customer':
        return deps.customerRepo.findById(tenantId, entityId);
      case 'location':
        return deps.locationRepo.findById(tenantId, entityId);
      case 'job':
        return deps.jobRepo.findById(tenantId, entityId);
      case 'estimate':
        return deps.estimateRepo.findById(tenantId, entityId);
      case 'invoice':
        return deps.invoiceRepo.findById(tenantId, entityId);
      case 'appointment':
        return deps.appointmentRepo.findById(tenantId, entityId);
      case 'lead':
        if (!deps.leadRepo) {
          throw new Error(
            "TenantOwnership requires deps.leadRepo to load 'lead' entities"
          );
        }
        return deps.leadRepo.findById(tenantId, entityId);
    }
  }

  function notFound(entityType: OwnedEntityType, entityId: string): NotFoundError {
    // Capitalize the entity type so the error label reads naturally
    // ("Customer not found", not "customer not found").
    const label = entityType.charAt(0).toUpperCase() + entityType.slice(1);
    return new NotFoundError(label, entityId);
  }

  return {
    async requireExists(tenantId, entityType, entityId) {
      const found = await load(tenantId, entityType, entityId);
      if (!found) throw notFound(entityType, entityId);
    },
    async requireExistsAndLoad(tenantId, entityType, entityId) {
      const found = await load(tenantId, entityType, entityId);
      if (!found) throw notFound(entityType, entityId);
      return found;
    },
  };
}
