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

export type OwnedEntityType =
  | 'customer'
  | 'location'
  | 'job'
  | 'estimate'
  | 'invoice'
  | 'appointment';

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
}

export interface TenantOwnershipDeps {
  customerRepo: CustomerRepository;
  locationRepo: LocationRepository;
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  appointmentRepo: AppointmentRepository;
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
  };
}

export function createTenantOwnership(deps: TenantOwnershipDeps): TenantOwnership {
  return {
    async requireExists(tenantId, entityType, entityId) {
      let found: unknown = null;
      switch (entityType) {
        case 'customer':
          found = await deps.customerRepo.findById(tenantId, entityId);
          break;
        case 'location':
          found = await deps.locationRepo.findById(tenantId, entityId);
          break;
        case 'job':
          found = await deps.jobRepo.findById(tenantId, entityId);
          break;
        case 'estimate':
          found = await deps.estimateRepo.findById(tenantId, entityId);
          break;
        case 'invoice':
          found = await deps.invoiceRepo.findById(tenantId, entityId);
          break;
        case 'appointment':
          found = await deps.appointmentRepo.findById(tenantId, entityId);
          break;
      }
      if (!found) {
        // Capitalize the entity type so the error label reads naturally
        // ("Customer not found", not "customer not found").
        const label = entityType.charAt(0).toUpperCase() + entityType.slice(1);
        throw new NotFoundError(label, entityId);
      }
    },
  };
}
