/**
 * Shared test helper: builds an Express app wired with in-memory repositories
 * and a fake auth middleware that injects a standard owner context.
 *
 * Each call to buildTestApp() returns a fresh set of repos so tests are
 * completely isolated from each other.
 */
import express, { Request, Response, NextFunction } from 'express';
import { createJobRouter } from '../../src/routes/jobs';
import { createCustomerRouter } from '../../src/routes/customers';
import { createEstimateRouter } from '../../src/routes/estimates';
import { createInvoiceRouter } from '../../src/routes/invoices';
import { createAppointmentRouter } from '../../src/routes/appointments';
import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';

export const TEST_TENANT_ID = 'tenant-test-1';
export const TEST_USER_ID = 'user-test-1';

function makeSeedSettings(tenantId: string): TenantSettings {
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export interface TestApp {
  app: express.Express;
  jobRepo: InMemoryJobRepository;
  customerRepo: InMemoryCustomerRepository;
  estimateRepo: InMemoryEstimateRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  paymentRepo: InMemoryPaymentRepository;
  appointmentRepo: InMemoryAppointmentRepository;
  proposalRepo: InMemoryProposalRepository;
  settingsRepo: InMemorySettingsRepository;
  auditRepo: InMemoryAuditRepository;
}

export async function buildTestApp(): Promise<TestApp> {
  const app = express();
  app.use(express.json());

  // Inject fake auth for all requests — owner role has all permissions
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER_ID,
      sessionId: 'session-test-1',
      tenantId: TEST_TENANT_ID,
      role: 'owner',
    };
    next();
  });

  const jobRepo = new InMemoryJobRepository();
  const timelineRepo = new InMemoryJobTimelineRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const auditRepo = new InMemoryAuditRepository();

  // Estimates and invoices need settings for number generation
  await settingsRepo.create(makeSeedSettings(TEST_TENANT_ID));

  // Route shape tests use literal string ids without seeding parents,
  // so the cross-entity ownership guard is stubbed permissively here.
  // The real impl is exercised via createApp() in
  // packages/api/test/decisions/tenant-isolation.test.ts.
  const ownership = permissiveTenantOwnership();

  app.use('/api/jobs', createJobRouter(jobRepo, timelineRepo, auditRepo, ownership));
  app.use('/api/customers', createCustomerRouter(customerRepo, auditRepo));
  app.use('/api/estimates', createEstimateRouter(estimateRepo, settingsRepo, auditRepo, ownership));
  app.use('/api/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo, ownership, paymentRepo));
  app.use('/api/appointments', createAppointmentRouter(appointmentRepo, ownership, jobRepo, timelineRepo));
  app.use('/api/proposals', createProposalsRouter(proposalRepo));

  return { app, jobRepo, customerRepo, estimateRepo, invoiceRepo, appointmentRepo, proposalRepo, settingsRepo, auditRepo };
}
