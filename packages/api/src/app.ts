import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './swagger/spec';
import { createHealthRouter } from './health/health';
import { toErrorResponse } from './shared/errors';

// Route factories
import { createCustomerRouter } from './routes/customers';
import { createLocationRouter } from './routes/locations';
import { createJobRouter } from './routes/jobs';
import { createAppointmentRouter } from './routes/appointments';
import { createEstimateRouter } from './routes/estimates';
import { createInvoiceRouter } from './routes/invoices';
import { createPaymentRouter } from './routes/payments';
import { createNoteRouter } from './routes/notes';
import { createConversationRouter } from './routes/conversations';
import { createSettingsRouter } from './routes/settings';

// In-memory repositories
import { InMemoryCustomerRepository } from './customers/customer';
import { InMemoryLocationRepository } from './locations/location';
import { InMemoryJobRepository } from './jobs/job';
import { InMemoryJobTimelineRepository } from './jobs/job-lifecycle';
import { InMemoryAppointmentRepository } from './appointments/appointment';
import { InMemoryEstimateRepository } from './estimates/estimate';
import { InMemoryInvoiceRepository } from './invoices/invoice';
import { InMemoryPaymentRepository } from './invoices/payment';
import { InMemoryNoteRepository } from './notes/note';
import { InMemoryConversationRepository } from './conversations/conversation-service';
import { InMemorySettingsRepository } from './settings/settings';
import { InMemoryAuditRepository } from './audit/audit';

// Auth middleware
import { verifyClerkSession, AuthenticatedRequest } from './auth/clerk';

const DEV_MODE = !process.env.CLERK_SECRET_KEY;

export function createApp() {
  const app = express();

  // Body parsing
  app.use(express.json());

  // Swagger UI — no auth required
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  // Health checks — no auth required
  const healthRouter = createHealthRouter('1.0.0', process.env.NODE_ENV || 'development');
  app.use('/', healthRouter);

  // Auth middleware for API routes
  if (DEV_MODE) {
    console.warn('[DEV MODE] No CLERK_SECRET_KEY set — auto-injecting dev auth context on all /api routes');
    app.use('/api', (req: AuthenticatedRequest, _res, next) => {
      req.auth = {
        userId: 'dev-user-001',
        sessionId: 'dev-session',
        tenantId: 'dev-tenant-001',
        role: 'owner',
      };
      next();
    });
  } else {
    app.use('/api', verifyClerkSession(process.env.CLERK_SECRET_KEY!));
  }

  // Initialize in-memory repositories
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const jobRepo = new InMemoryJobRepository();
  const timelineRepo = new InMemoryJobTimelineRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();
  const noteRepo = new InMemoryNoteRepository();
  const conversationRepo = new InMemoryConversationRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const auditRepo = new InMemoryAuditRepository();

  // Seed dev tenant settings so estimate/invoice number generation works
  if (DEV_MODE) {
    settingsRepo.create({
      id: 'dev-settings-001',
      tenantId: 'dev-tenant-001',
      businessName: 'Dev Company',
      timezone: 'America/New_York',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Mount API routes
  app.use('/api/v1/customers', createCustomerRouter(customerRepo, auditRepo));
  app.use('/api/v1/locations', createLocationRouter(locationRepo));
  app.use('/api/v1/jobs', createJobRouter(jobRepo, timelineRepo, auditRepo));
  app.use('/api/v1/appointments', createAppointmentRouter(appointmentRepo));
  app.use('/api/v1/estimates', createEstimateRouter(estimateRepo, settingsRepo, auditRepo));
  app.use('/api/v1/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo));
  app.use('/api/v1/payments', createPaymentRouter(paymentRepo, invoiceRepo));
  app.use('/api/v1/notes', createNoteRouter(noteRepo));
  app.use('/api/v1/conversations', createConversationRouter(conversationRepo));
  app.use('/api/v1/settings', createSettingsRouter(settingsRepo));

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  });

  return app;
}
