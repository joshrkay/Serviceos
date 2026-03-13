import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './swagger/spec';
import { createHealthRouter, HealthCheck } from './health/health';
import { toErrorResponse } from './shared/errors';
import { createPool } from './db/pool';

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
import { verifyClerkSession } from './auth/clerk';

export function createApp() {
  const app = express();

  // Body parsing
  app.use(express.json());

  // CORS
  const corsOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : true);
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));

  // Swagger UI — no auth required
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  // Health checks — no auth required
  const checks: HealthCheck[] = [];
  if (process.env.DATABASE_URL) {
    const pool = createPool();
    checks.push({
      name: 'database',
      check: async () => {
        try {
          await pool.query('SELECT 1');
          return { status: 'ok' };
        } catch {
          return { status: 'down', message: 'Database connection failed' };
        }
      },
    });
  }
  const healthRouter = createHealthRouter('1.0.0', process.env.NODE_ENV || 'development', checks);
  app.use('/', healthRouter);

  // Auth middleware for API routes
  const clerkSecret = process.env.CLERK_SECRET_KEY || 'dev-secret-key';
  app.use('/api', verifyClerkSession(clerkSecret));

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
