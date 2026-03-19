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
import { createPackActivationRouter } from './routes/pack-activation';
import { createVoiceRouter } from './routes/voice';

// In-memory repositories (fallback for dev without DATABASE_URL)
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
import { InMemoryEstimateTemplateRepository } from './templates/estimate-template';
import { InMemoryServiceBundleRepository } from './verticals/bundles';
import { InMemoryQualityMetricsRepository } from './quality/metrics';
import { InMemoryVoiceRepository } from './voice/voice-service';
import { InMemoryQueue, processMessage } from './queues/queue';
import { InMemoryApprovalRepository } from './estimates/approval';
import { InMemoryEditDeltaRepository } from './estimates/edit-delta';
import { InMemoryPackActivationRepository } from './settings/pack-activation';
import { InMemoryVerticalPackRegistry as InMemoryCanonicalVerticalPackRegistry } from './shared/vertical-pack-registry';

// Postgres-backed repositories (production)
import { PgCustomerRepository } from './customers/pg-customer';
import { PgLocationRepository } from './locations/pg-location';
import { PgJobRepository } from './jobs/pg-job';
import { PgJobTimelineRepository } from './jobs/pg-job-lifecycle';
import { PgAppointmentRepository } from './appointments/pg-appointment';
import { PgEstimateRepository } from './estimates/pg-estimate';
import { PgInvoiceRepository } from './invoices/pg-invoice';
import { PgPaymentRepository } from './invoices/pg-payment';
import { PgNoteRepository } from './notes/pg-note';
import { PgConversationRepository } from './conversations/pg-conversation';
import { PgSettingsRepository } from './settings/pg-settings';
import { PgAuditRepository } from './audit/pg-audit';
import { PgEstimateTemplateRepository } from './templates/pg-estimate-template';
import { PgServiceBundleRepository } from './verticals/pg-bundles';
import { PgQualityMetricsRepository } from './quality/pg-metrics';
import { PgVoiceRepository } from './voice/pg-voice';
import { PgApprovalRepository } from './estimates/pg-approval';
import { PgEditDeltaRepository } from './estimates/pg-edit-delta';
import { PgPackActivationRepository } from './settings/pg-pack-activation';
import { PgVerticalPackRegistry } from './shared/pg-vertical-pack-registry';
import { PgFileRepository } from './files/pg-file';
import { PgWebhookRepository } from './webhooks/pg-webhook';
import { PgQueue } from './queues/pg-queue';

import { seedCanonicalVerticalPacks } from './shared/canonical-vertical-packs';
import { createTranscriptionWorker } from './workers/transcription';
import { createLogger } from './logging/logger';

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
          // Treat database outages as degraded on /health so platform liveness checks
          // do not force restart loops while dependencies recover.
          return { status: 'degraded', message: 'Database connection failed' };
        }
      },
    });
  }
  const healthRouter = createHealthRouter('1.0.0', process.env.NODE_ENV || 'development', checks);
  app.use('/', healthRouter);

  // Auth middleware for API routes
  // In dev without CLERK_SECRET_KEY, verifyClerkSession handles dev-mode bypass.
  // In prod/staging, loadConfig() enforces CLERK_SECRET_KEY is present.
  const clerkSecret = process.env.CLERK_SECRET_KEY ?? '';
  app.use('/api', verifyClerkSession(clerkSecret));

  // Initialize repositories — use Postgres when DATABASE_URL is set, otherwise
  // fall back to in-memory for local development without a database.
  const usePostgres = !!process.env.DATABASE_URL;
  const pool = usePostgres ? createPool() : undefined;

  const customerRepo       = pool ? new PgCustomerRepository(pool)       : new InMemoryCustomerRepository();
  const locationRepo       = pool ? new PgLocationRepository(pool)       : new InMemoryLocationRepository();
  const jobRepo            = pool ? new PgJobRepository(pool)            : new InMemoryJobRepository();
  const timelineRepo       = pool ? new PgJobTimelineRepository(pool)    : new InMemoryJobTimelineRepository();
  const appointmentRepo    = pool ? new PgAppointmentRepository(pool)    : new InMemoryAppointmentRepository();
  const estimateRepo       = pool ? new PgEstimateRepository(pool)       : new InMemoryEstimateRepository();
  const invoiceRepo        = pool ? new PgInvoiceRepository(pool)        : new InMemoryInvoiceRepository();
  const paymentRepo        = pool ? new PgPaymentRepository(pool)        : new InMemoryPaymentRepository();
  const noteRepo           = pool ? new PgNoteRepository(pool)           : new InMemoryNoteRepository();
  const conversationRepo   = pool ? new PgConversationRepository(pool)   : new InMemoryConversationRepository();
  const settingsRepo       = pool ? new PgSettingsRepository(pool)       : new InMemorySettingsRepository();
  const auditRepo          = pool ? new PgAuditRepository(pool)          : new InMemoryAuditRepository();
  const templateRepo       = pool ? new PgEstimateTemplateRepository(pool) : new InMemoryEstimateTemplateRepository();
  const bundleRepo         = pool ? new PgServiceBundleRepository(pool)  : new InMemoryServiceBundleRepository();
  const qualityMetricsRepo = pool ? new PgQualityMetricsRepository(pool) : new InMemoryQualityMetricsRepository();
  const voiceRepo          = pool ? new PgVoiceRepository(pool)          : new InMemoryVoiceRepository();
  const approvalRepo       = pool ? new PgApprovalRepository(pool)       : new InMemoryApprovalRepository();
  const deltaRepo          = pool ? new PgEditDeltaRepository(pool)      : new InMemoryEditDeltaRepository();
  const packActivationRepo = pool ? new PgPackActivationRepository(pool) : new InMemoryPackActivationRepository();
  const queue              = pool ? new PgQueue(pool)                    : new InMemoryQueue();

  const canonicalPackRegistry = pool
    ? new PgVerticalPackRegistry(pool)
    : new InMemoryCanonicalVerticalPackRegistry();
  seedCanonicalVerticalPacks(canonicalPackRegistry);

  // Transcription provider — use OpenAI Whisper API when API key is configured,
  // otherwise fall back to a no-op provider for dev.
  const transcriptionProvider = process.env.AI_PROVIDER_API_KEY
    ? {
        async transcribe(audioUrl: string): Promise<{ transcript: string; metadata: Record<string, unknown> }> {
          // Real implementation would call OpenAI Whisper API here.
          // For now, this signals intent — replace with actual Whisper call.
          const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.AI_PROVIDER_API_KEY}` },
            body: (() => {
              const fd = new FormData();
              fd.append('file', audioUrl);
              fd.append('model', 'whisper-1');
              return fd;
            })(),
          });
          const data = await res.json();
          return {
            transcript: data.text || '',
            metadata: { provider: 'openai-whisper', processedAt: new Date().toISOString() },
          };
        },
      }
    : {
        async transcribe(audioUrl: string): Promise<{ transcript: string; metadata: Record<string, unknown> }> {
          return {
            transcript: `[Dev mode] Transcription not available. Audio: ${audioUrl}`,
            metadata: { provider: 'dev-fallback', processedAt: new Date().toISOString() },
          };
        },
      };
  const transcriptionWorker = createTranscriptionWorker(voiceRepo, transcriptionProvider);
  const workerLogger = createLogger({
    service: 'transcription-worker',
    environment: process.env.NODE_ENV || 'development',
    level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  });

  setInterval(async () => {
    const message = await queue.receive();
    if (!message) return;
    const processed = await processMessage(message, transcriptionWorker, workerLogger);
    if (processed) {
      await queue.delete(message.id);
    }
  }, 250);

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
  app.use('/api/settings', createSettingsRouter(settingsRepo));
  app.use('/api/settings/packs', createPackActivationRouter(packActivationRepo, canonicalPackRegistry));
  app.use('/api/verticals', createVerticalRouter(canonicalPackRegistry));
  app.use('/api/templates', createTemplateRouter(templateRepo));
  app.use('/api/bundles', createBundleRouter(bundleRepo));
  app.use('/api/quality', createQualityRouter({ metricsRepo: qualityMetricsRepo, approvalRepo, deltaRepo }));
  app.use('/api/voice', createVoiceRouter(voiceRepo, queue));

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  });

  return app;
}
