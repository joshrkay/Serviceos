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
import { createVerticalRouter } from './routes/verticals';
import { createTemplateRouter } from './routes/templates';
import { createBundleRouter } from './routes/bundles';
import { createQualityRouter } from './routes/quality';

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
import { InMemoryVerticalPackRepository } from './verticals/registry';
import { InMemoryEstimateTemplateRepository } from './templates/estimate-template';
import { InMemoryServiceBundleRepository } from './verticals/bundles';
import { InMemoryQualityMetricsRepository } from './quality/metrics';
import { InMemoryVerticalPackRegistry as InMemorySharedVerticalPackRegistry } from './shared/vertical-pack-registry';
import { InMemoryPackActivationRepository } from './settings/pack-activation';

// Auth middleware
import { verifyClerkSession } from './auth/clerk';

export function createApp() {
  const app = express();

  // Body parsing
  app.use(express.json());

  // CORS
  // Allow explicit origin override, or fall back to allowing all origins.
  // Credentials require an explicit origin (not '*'), so in prod set CORS_ORIGIN to the web URL.
  const corsOrigin = process.env.CORS_ORIGIN || true;
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
  const templateRepo = new InMemoryEstimateTemplateRepository();
  const bundleRepo = new InMemoryServiceBundleRepository();
  const qualityMetricsRepo = new InMemoryQualityMetricsRepository();
  const sharedVerticalPackRegistry = new InMemorySharedVerticalPackRegistry();
  const packActivationRepo = new InMemoryPackActivationRepository();

  // Mount API routes
  app.use('/api/customers', createCustomerRouter(customerRepo, auditRepo));
  app.use('/api/locations', createLocationRouter(locationRepo));
  app.use('/api/jobs', createJobRouter(jobRepo, timelineRepo, auditRepo));
  app.use('/api/appointments', createAppointmentRouter(appointmentRepo));
  app.use('/api/estimates', createEstimateRouter(estimateRepo, settingsRepo, auditRepo));
  app.use('/api/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo));
  app.use('/api/payments', createPaymentRouter(paymentRepo, invoiceRepo));
  app.use('/api/notes', createNoteRouter(noteRepo));
  app.use('/api/conversations', createConversationRouter(conversationRepo));
  app.use('/api/settings', createSettingsRouter(settingsRepo, {
    activationRepo: packActivationRepo,
    verticalPackRegistry: sharedVerticalPackRegistry,
  }));
  app.use('/api/verticals', createVerticalRouter(new InMemoryVerticalPackRepository()));
  app.use('/api/templates', createTemplateRouter(templateRepo));
  app.use('/api/bundles', createBundleRouter(bundleRepo));
  app.use('/api/quality', createQualityRouter(qualityMetricsRepo));

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  });

  return app;
}
