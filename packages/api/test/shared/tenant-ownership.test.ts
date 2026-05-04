import { describe, it, expect, beforeEach } from 'vitest';
import { createTenantOwnership } from '../../src/shared/tenant-ownership';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { NotFoundError } from '../../src/shared/errors';

const TENANT = 'tenant-own-1';

describe('TenantOwnership.requireExistsAndLoad', () => {
  let customerRepo: InMemoryCustomerRepository;
  let leadRepo: InMemoryLeadRepository;
  let ownership: ReturnType<typeof createTenantOwnership>;

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
    leadRepo = new InMemoryLeadRepository();
    ownership = createTenantOwnership({
      customerRepo,
      locationRepo: new InMemoryLocationRepository(),
      jobRepo: new InMemoryJobRepository(),
      estimateRepo: new InMemoryEstimateRepository(),
      invoiceRepo: new InMemoryInvoiceRepository(),
      appointmentRepo: new InMemoryAppointmentRepository(),
      leadRepo,
    });
  });

  it('returns the loaded entity when it exists', async () => {
    await customerRepo.create({
      id: 'cust-1',
      tenantId: TENANT,
      firstName: 'A',
      lastName: 'B',
      displayName: 'A B',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      originatingLeadId: 'lead-xyz',
      createdBy: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const loaded = await ownership.requireExistsAndLoad(TENANT, 'customer', 'cust-1');
    expect((loaded as { originatingLeadId: string }).originatingLeadId).toBe('lead-xyz');
  });

  it('throws NotFoundError when the entity does not exist', async () => {
    await expect(
      ownership.requireExistsAndLoad(TENANT, 'customer', 'missing')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not return cross-tenant rows', async () => {
    await customerRepo.create({
      id: 'cust-other',
      tenantId: 'tenant-other',
      firstName: 'X',
      lastName: 'Y',
      displayName: 'X Y',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      ownership.requireExistsAndLoad(TENANT, 'customer', 'cust-other')
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
