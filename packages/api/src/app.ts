import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './swagger/spec';
import { createHealthRouter, HealthCheck } from './health/health';
import { toErrorResponse } from './shared/errors';
import { createPool } from './db/pool';
import { loadConfig } from './shared/config';
import { createWebhookRouter } from './webhooks/routes';
import { createTelephonyRouter } from './routes/telephony';
import { TwilioGatherAdapter } from './telephony/twilio-adapter';
import { attachMediaStreamServer } from './telephony/media-streams';
import { DeepgramStreamingProvider } from './voice/transcription-providers';
import { PgTenantRepository } from './auth/pg-tenant';

// Route factories
import { createCustomerRouter } from './routes/customers';
import { createLeadsRouter } from './routes/leads';
import { createLocationRouter } from './routes/locations';
import { createJobRouter } from './routes/jobs';
import { createAppointmentRouter } from './routes/appointments';
import { createEstimateRouter } from './routes/estimates';
import { createInvoiceRouter } from './routes/invoices';
import { createPaymentRouter } from './routes/payments';
import { createNoteRouter } from './routes/notes';
import {
  createMeRouter,
  InMemoryUserModeService,
  type MeUserRecord,
  type MeTenantSettings,
  type UserModeService,
} from './routes/me';
import { setUserModeLoader } from './middleware/auth';
import {
  setSupervisorPresenceLoader,
  pgSupervisorPresenceLoader,
} from './ai/supervisor-presence';
import { createConversationRouter } from './routes/conversations';
import { createSettingsRouter } from './routes/settings';
import { createVerticalRouter } from './routes/verticals';
import { createTemplateRouter } from './routes/templates';
import { createBundleRouter } from './routes/bundles';
import { createQualityRouter } from './routes/quality';
import { createPackActivationRouter } from './routes/pack-activation';
import { createVoiceRouter } from './routes/voice';
import { createAssistantRouter } from './routes/assistant';
import { createProposalsRouter } from './routes/proposals';
import { createTechnicianLocationRouter } from './routes/technician-location';
import { createCatalogItemsRouter } from './routes/catalog-items';
import { createFilesRouter, createDevStorageRouter } from './routes/files';
import { createJobFilesRouter } from './routes/job-files';
import { createJobPhotosRouter } from './routes/job-photos';
import { JobPhotoService } from './jobs/job-photo-service';
import { InMemoryJobPhotoRepository } from './jobs/job-photo';
import { PgJobPhotoRepository } from './jobs/pg-job-photo';
import { createDispatchRoutes } from './dispatch/routes';
import { createPublicFeedbackRouter } from './routes/public-feedback';
import { createPublicIntakeRouter } from './routes/public-intake';
import { createReportsRouter } from './routes/reports';
import { createTimeEntriesRouter } from './routes/time-entries';
import { InMemoryTimeEntryRepository } from './time-tracking/time-entry';
import { PgTimeEntryRepository } from './time-tracking/pg-time-entry';
import {
  PgRevenueBySourceRepository,
  InMemoryRevenueBySourceRepository,
} from './reports/revenue-by-source';
import { createFeedbackResponsesRouter } from './routes/feedback';

// In-memory repositories (fallback for dev without DATABASE_URL)
import { InMemoryCustomerRepository } from './customers/customer';
import { InMemoryLeadRepository } from './leads/lead';
import { InMemoryLocationRepository } from './locations/location';
import { InMemoryJobRepository } from './jobs/job';
import { InMemoryJobTimelineRepository } from './jobs/job-lifecycle';
import { InMemoryAppointmentRepository } from './appointments/appointment';
import { InMemoryAssignmentRepository } from './appointments/assignment';
import { InMemoryEstimateRepository } from './estimates/estimate';
import { InMemoryInvoiceRepository } from './invoices/invoice';
import { InMemoryPaymentRepository } from './invoices/payment';
import { InMemoryPaymentReadinessRepository } from './invoices/payment-readiness';
import { createPaymentLinkProvider } from './payments/payment-link-provider';
import { InMemoryNoteRepository } from './notes/note';
import { InMemoryConversationRepository } from './conversations/conversation-service';
import { InMemorySettingsRepository } from './settings/settings';
import { InMemoryAuditRepository } from './audit/audit';
import { InMemoryLookupEventRepository } from './lookup-events/lookup-event';
import { PgLookupEventRepository } from './lookup-events/pg-lookup-event';
import { LookupEventService } from './lookup-events/lookup-event-service';
import { InMemoryEstimateTemplateRepository } from './templates/estimate-template';
import { InMemoryServiceBundleRepository } from './verticals/bundles';
import { InMemoryQualityMetricsRepository } from './quality/metrics';
import { InMemoryVoiceRepository } from './voice/voice-service';
import { createTranscriptionProvider } from './voice/transcription-providers';
import { InMemoryDispatchAnalyticsRepository } from './dispatch/analytics';
import {
  InMemoryFeatureFlagStore,
  InMemoryFeatureFlagRepository,
  hydrateStoreFromRepository,
  FeatureFlagRepository,
} from './flags/feature-flags';
import { PgFeatureFlagRepository } from './flags/pg-feature-flags';
import { createFeatureFlagsRouter } from './routes/feature-flags';
import { InMemoryTechnicianLocationPingRepository } from './telemetry/technician-location-ping';
import {
  InMemoryTechnicianLocationAuthorizer,
  PgTechnicianLocationAuthorizer,
} from './telemetry/technician-location-authz';
import { InMemoryQueue, processMessage } from './queues/queue';
import { InMemoryApprovalRepository } from './estimates/approval';
import { InMemoryEditDeltaRepository } from './estimates/edit-delta';
import { InMemoryPackActivationRepository } from './settings/pack-activation';
import { InMemoryVerticalPackRegistry as InMemoryCanonicalVerticalPackRegistry } from './shared/vertical-pack-registry';

// Postgres-backed repositories (production)
import { PgCustomerRepository } from './customers/pg-customer';
import { PgLeadRepository } from './leads/pg-lead';
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
import { PgTechnicianLocationPingRepository } from './telemetry/pg-technician-location-ping';
import { PgApprovalRepository } from './estimates/pg-approval';
import { PgEditDeltaRepository } from './estimates/pg-edit-delta';
import { PgPackActivationRepository } from './settings/pg-pack-activation';
import { PgVerticalPackRegistry } from './shared/pg-vertical-pack-registry';
import { InMemoryFileRepository } from './files/file-service';
import { InMemoryJobFileRepository } from './files/job-file-repository';
import { PgFileRepository } from './files/pg-file';
import { PgJobFileRepository } from './files/pg-job-file';
import { InMemoryCatalogItemRepository } from './catalog/catalog-item';
import { PgCatalogItemRepository } from './catalog/pg-catalog-item';
import { createStorageProvider } from './files/storage-provider';
import { PgWebhookRepository } from './webhooks/pg-webhook';
import { PgWebhookEventRepository } from './webhooks/pg-webhook-event';
import { PgAssignmentRepository } from './appointments/pg-assignment';
import { PgDocumentRevisionRepository } from './ai/pg-document-revision';
import { PgDiffAnalysisRepository } from './ai/pg-diff-analysis';
import { PgDispatchAnalyticsRepository } from './dispatch/pg-analytics';
import { PgDelayNoticeStateRepository } from './notifications/pg-delay-notice-state';
import { PgQueue } from './queues/pg-queue';
import {
  InMemoryFeedbackRequestRepository,
} from './feedback/feedback-request';
import {
  InMemoryFeedbackResponseRepository,
} from './feedback/feedback-response';
import { PgFeedbackRequestRepository } from './feedback/pg-feedback-request';
import { PgFeedbackResponseRepository } from './feedback/pg-feedback-response';
import { NoopFeedbackDispatcher, SmsProviderFeedbackDispatcher } from './feedback/dispatcher';
import {
  MessageDeliveryProvider,
  InMemoryDeliveryProvider,
} from './notifications/delivery-provider';
import { TwilioDeliveryProvider } from './notifications/twilio-delivery-provider';
import { SendService } from './notifications/send-service';
import {
  InMemoryDispatchRepository,
  PgDispatchRepository,
} from './notifications/dispatch-repository';
import { SendServiceInvoiceDeliveryProvider } from './notifications/invoice-delivery-adapter';
import { PublicEstimateService } from './estimates/public-estimate-service';
import { createPublicEstimatesRouter } from './routes/public-estimates';
import { PublicInvoiceService } from './invoices/public-invoice-service';
import { createPublicInvoicesRouter } from './routes/public-invoices';
import { createPublicPaymentsRouter } from './routes/public-payments';
import { createFeedbackSendWorker } from './workers/feedback-send';
import { runRecurringAgreementsSweep } from './workers/recurring-agreements-worker';
import { InMemoryAgreementRepository } from './agreements/agreement';
import { PgAgreementRepository } from './agreements/pg-agreement';
import { InMemoryAgreementRunRepository } from './agreements/agreement-run';
import { PgAgreementRunRepository } from './agreements/pg-agreement-run';
import { createAgreementsRouter } from './routes/agreements';
import {
  InMemoryPortalSessionRepository,
  PortalSessionRepository,
} from './portal/portal-session';
import { PgPortalSessionRepository } from './portal/pg-portal-session';
import { createPortalRouter } from './routes/portal';
import { createPublicPortalRouter } from './routes/public-portal';
import { createJob as createJobDomain } from './jobs/job';
import { createInvoice as createInvoiceDomain } from './invoices/invoice';

import { seedCanonicalVerticalPacks } from './shared/canonical-vertical-packs';
import { createTenantOwnership } from './shared/tenant-ownership';
import { createTranscriptionWorker } from './workers/transcription';
import { createTranscriptIngestionWorker } from './workers/transcript-ingestion-worker';
import { createProposalCorrectionWorker } from './workers/proposal-correction-worker';
import { createRetrieveAdapter } from './ai/orchestration/retrieve-adapter';
import { FrancLanguageDetector } from './voice/language-detector';
import type { RetrieveAdapter } from './ai/orchestration/context-builder';
import {
  PgKnowledgeChunkRepository,
  InMemoryKnowledgeChunkRepository,
} from './ai/training/knowledge-chunks';
import { InMemoryRetrievalEvalRunRepository } from './ai/training/retrieval-eval-run';
import { PgRetrievalEvalRunRepository } from './ai/training/pg-retrieval-eval-run';
import { InMemoryProposalExecutionRepository } from './proposals/proposal-execution';
import { PgProposalExecutionRepository } from './proposals/pg-proposal-execution';
import { PgCallTranscriptTurnRepository } from './voice/pg-call-transcript-turn';
import { InMemoryCallTranscriptTurnRepository } from './voice/call-transcript-turn';
import {
  OpenAICompatibleProvider,
  type EmbeddingProvider,
} from './ai/providers/openai-compatible';
import { createVoiceActionRouterWorker, VoiceActionRouterPayload } from './workers/voice-action-router';
import { DefaultSlotConflictChecker } from './ai/tasks/slot-conflict-checker';
import { DefaultAvailabilityFinder } from './ai/tasks/availability-finder';
import { runExecutionSweep } from './workers/execution-worker';
import { createLLMGateway, createMockLLMGateway } from './ai/gateway/factory';
import { createTtsProvider } from './ai/tts/tts-provider';
import { InAppVoiceAdapter } from './ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from './ai/agents/customer-calling/voice-session-store';
import { createVoiceSessionsRouter } from './routes/voice-sessions';
import { InMemoryOnCallRepository, PgOnCallRepository } from './oncall/rotation';
import { InMemoryProposalRepository } from './proposals/proposal';
import { PgProposalRepository } from './proposals/pg-proposal';
import { ProposalExecutor } from './proposals/execution/executor';
import { createExecutionHandlerRegistry } from './proposals/execution/handlers';
import { NoopInvoiceDeliveryProvider } from './proposals/execution/voice-extended-handlers';
import {
  createDiffAnalysisWorker,
  InMemoryDiffAnalysisRepository,
} from './ai/diff-analysis';
import { InMemoryDocumentRevisionRepository } from './ai/document-revision';
import { createLogger } from './logging/logger';
import {
  createDelayNotificationWorker,
  DelayNotificationCoordinator,
  InMemoryDelayNoticeStateRepository,
  NextCustomerSelector,
  NoopDelayNotificationService,
} from './notifications/delay-notifications';

// Auth middleware
import { verifyClerkSession } from './auth/clerk';
import {
  devAuthBypass,
  isDevAuthBypassEnabled,
  DevInMemoryTenantRepository,
} from './auth/dev-auth-bypass';
import { requireAuth } from './middleware/auth';
import { withTenantTransaction } from './middleware/tenant-context';

/**
 * In-memory dev fallback for the WebhookEvent idempotency repo.
 *
 * The Pg-backed variant (PgWebhookEventRepository, P0-020) sits on top of the
 * `webhook_events` table. There is no shared interface declaration in the
 * webhook-event source (only the Pg class), and per the P0-023 hard rules we
 * cannot edit any pg-* source file. To keep the `pool ? Pg : InMemory`
 * wiring pattern consistent across all six newly wired entities, a minimal
 * Map-backed stub lives here. It mirrors PgWebhookEventRepository's public
 * surface (recordReceipt / markProcessed / markFailed / findById /
 * findUnprocessed) so dev runs without DATABASE_URL still type-check.
 *
 * Production and staging ALWAYS use the Pg variant — `createApp()` throws
 * above if DATABASE_URL is missing in those environments. So this stub is a
 * dev-only fallback by construction.
 */
class InMemoryWebhookEventRepository {
  private events = new Map<string, {
    id: string;
    provider: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    receivedAt: Date;
    processedAt: Date | null;
    processingError: string | null;
  }>();

  private key(provider: string, eventId: string): string {
    return `${provider}:${eventId}`;
  }

  async recordReceipt(
    provider: string,
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<{ inserted: boolean; record: {
    id: string;
    provider: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    receivedAt: Date;
    processedAt: Date | null;
    processingError: string | null;
  } }> {
    if (!provider) throw new Error('provider is required');
    if (!eventId) throw new Error('eventId is required');
    const k = this.key(provider, eventId);
    const existing = this.events.get(k);
    if (existing) {
      return { inserted: false, record: { ...existing } };
    }
    const record = {
      id: `${k}:${this.events.size + 1}`,
      provider,
      eventId,
      eventType,
      payload,
      receivedAt: new Date(),
      processedAt: null,
      processingError: null,
    };
    this.events.set(k, record);
    return { inserted: true, record: { ...record } };
  }

  async markProcessed(provider: string, eventId: string): Promise<void> {
    const r = this.events.get(this.key(provider, eventId));
    if (r) {
      r.processedAt = new Date();
      r.processingError = null;
    }
  }

  async markFailed(provider: string, eventId: string, error: string): Promise<void> {
    const r = this.events.get(this.key(provider, eventId));
    if (r) {
      r.processingError = error;
    }
  }

  async findById(provider: string, eventId: string) {
    const r = this.events.get(this.key(provider, eventId));
    return r ? { ...r } : null;
  }

  async findUnprocessed(limit = 100) {
    return Array.from(this.events.values())
      .filter((r) => r.processedAt === null && r.processingError === null)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export function createApp(): express.Express {
  const app = express();

  // Stripe webhook needs the raw body for signature verification.
  // Mount with express.raw() BEFORE express.json() so this path gets a Buffer
  // and the global json() middleware skips it (body-parser sets req._body = true).
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

  // Body parsing for all other routes
  app.use(express.json());

  // Load validated config — must happen before CORS so validateProductionConfig()
  // can throw on missing CORS_ORIGIN before we wire the middleware.
  const config = loadConfig();

  // Swagger UI — no auth required
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  // CORS — use explicit origin in prod/staging (validated by config), wildcard in dev/test.
  app.use(cors({
    origin: config.CORS_ORIGIN ?? true,
    credentials: true,
  }));

  // Rate limiting — applied before auth to protect all routes
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,                  // per IP
    standardHeaders: true,
    legacyHeaders: false,
  }));
  app.use('/webhooks', rateLimit({
    windowMs: 60 * 1000,      // 1 minute
    max: 30,
  }));
  // Public invoice/estimate pages are unauthenticated but token-gated.
  // Limit aggressively to slow token brute-force and view-count inflation.
  app.use('/public', rateLimit({
    windowMs: 60 * 1000,      // 1 minute
    max: 30,                  // per IP
  }));

  // Initialize repositories — use Postgres when DATABASE_URL is set, otherwise
  // fall back to in-memory for local development without a database.
  const pool = process.env.DATABASE_URL ? createPool() : undefined;

  // In production, in-memory repositories lose all data on restart — crash fast.
  if (!pool && (config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging')) {
    throw new Error('DATABASE_URL is required in production and staging environments');
  }

  // Health checks — no auth required. Reuse the main pool (no duplicate connections).
  const checks: HealthCheck[] = [];
  if (pool) {
    checks.push({
      name: 'database',
      check: async () => {
        try {
          await pool.query('SELECT 1');
          return { status: 'ok' };
        } catch {
          return { status: 'degraded', message: 'Database connection failed' };
        }
      },
    });
  }
  const healthRouter = createHealthRouter('1.0.0', process.env.NODE_ENV || 'development', checks);
  app.use('/', healthRouter);

  // Webhook routes — mounted before Clerk JWT middleware because webhooks
  // use their own signature verification (svix for Clerk, stripe-signature for Stripe).
  // The settings repo is constructed early so the Clerk webhook tenant
  // bootstrap can seed a default TenantSettings row alongside the new
  // tenant — closes the onboarding hole where a new operator would 500
  // on their first POST /api/estimates.
  const tenantRepo = pool ? new PgTenantRepository(pool) : undefined;
  const webhookSettingsRepo = pool
    ? new PgSettingsRepository(pool)
    : new InMemorySettingsRepository();
  // Constructed early so the Stripe webhook handler can record payments.
  const webhookInvoiceRepo = pool ? new PgInvoiceRepository(pool) : new InMemoryInvoiceRepository();
  const webhookPaymentRepo = pool ? new PgPaymentRepository(pool) : new InMemoryPaymentRepository();
  app.use(
    '/webhooks',
    createWebhookRouter(config, {
      tenantRepo,
      settingsRepo: webhookSettingsRepo,
      invoiceRepo: webhookInvoiceRepo,
      paymentRepo: webhookPaymentRepo,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    })
  );

  // Dev-only storage PUT receiver for DevStorageProvider upload URLs.
  // Mounted before /api Clerk auth so unauthenticated presigned-style PUTs
  // succeed in local development. In prod/staging, createStorageProvider
  // refuses to return a DevStorageProvider, so this route is dormant.
  if (config.NODE_ENV !== 'prod' && config.NODE_ENV !== 'staging') {
    app.use('/storage-dev', createDevStorageRouter());
  }

  const customerRepo       = pool ? new PgCustomerRepository(pool)       : new InMemoryCustomerRepository();
  const leadRepo           = pool ? new PgLeadRepository(pool)           : new InMemoryLeadRepository();
  const locationRepo       = pool ? new PgLocationRepository(pool)       : new InMemoryLocationRepository();
  const jobRepo            = pool ? new PgJobRepository(pool)            : new InMemoryJobRepository();
  const timelineRepo       = pool ? new PgJobTimelineRepository(pool)    : new InMemoryJobTimelineRepository();
  const appointmentRepo    = pool ? new PgAppointmentRepository(pool)    : new InMemoryAppointmentRepository();
  const assignmentRepo     = pool ? new PgAssignmentRepository(pool)     : new InMemoryAssignmentRepository();
  const estimateRepo       = pool ? new PgEstimateRepository(pool)       : new InMemoryEstimateRepository();
  const invoiceRepo        = pool ? new PgInvoiceRepository(pool)        : new InMemoryInvoiceRepository();
  const paymentRepo        = pool ? new PgPaymentRepository(pool)        : new InMemoryPaymentRepository();
  // P5-017: Resolve the payment-link provider via the factory so the mock
  // is hard-blocked in production. The factory throws at boot if
  // STRIPE_SECRET_KEY (or STRIPE_API_KEY) is missing while NODE_ENV=production,
  // and emits a loud dev-mode warning when the mock is used.
  const paymentReadinessRepo = new InMemoryPaymentReadinessRepository();
  const paymentLinkProvider = createPaymentLinkProvider(process.env, {
    readinessRepo: paymentReadinessRepo,
  });
  // Reference the variable so TS doesn't drop it; the provider will be
  // wired into routes/workers in a follow-up. The factory call itself is
  // load-bearing — it asserts the production guard at boot time.
  void paymentLinkProvider;
  const noteRepo           = pool ? new PgNoteRepository(pool)           : new InMemoryNoteRepository();
  const conversationRepo   = pool ? new PgConversationRepository(pool)   : new InMemoryConversationRepository();
  const settingsRepo       = pool ? new PgSettingsRepository(pool)       : new InMemorySettingsRepository();
  const auditRepo          = pool ? new PgAuditRepository(pool)          : new InMemoryAuditRepository();
  // P11-001: voice lookup-skill audit log. The skills write one row
  // per invocation through `LookupEventService` and the Twilio adapter
  // pulls it from the deps bundle. InMemory in dev/test, Pg in prod.
  const lookupEventRepo    = pool ? new PgLookupEventRepository(pool)    : new InMemoryLookupEventRepository();
  const lookupEventService = new LookupEventService(lookupEventRepo);
  // P11-001: hoisted so the Twilio lookup-skill family can read agreements.
  // The richer agreement-service wiring (agreementRunRepo, generators,
  // etc.) still happens further below — this declaration is purely so
  // the read-only lookup branch has access.
  const agreementRepo      = pool ? new PgAgreementRepository(pool)      : new InMemoryAgreementRepository();
  const templateRepo       = pool ? new PgEstimateTemplateRepository(pool) : new InMemoryEstimateTemplateRepository();
  const bundleRepo         = pool ? new PgServiceBundleRepository(pool)  : new InMemoryServiceBundleRepository();
  const qualityMetricsRepo = pool ? new PgQualityMetricsRepository(pool) : new InMemoryQualityMetricsRepository();
  const voiceRepo          = pool ? new PgVoiceRepository(pool)          : new InMemoryVoiceRepository();
  const technicianLocationPingRepo = pool
    ? new PgTechnicianLocationPingRepository(pool)
    : new InMemoryTechnicianLocationPingRepository();
  const technicianLocationAuthorizer = pool
    ? new PgTechnicianLocationAuthorizer(pool)
    : new InMemoryTechnicianLocationAuthorizer();
  const approvalRepo       = pool ? new PgApprovalRepository(pool)       : new InMemoryApprovalRepository();
  const deltaRepo          = pool ? new PgEditDeltaRepository(pool)      : new InMemoryEditDeltaRepository();
  const packActivationRepo = pool ? new PgPackActivationRepository(pool) : new InMemoryPackActivationRepository();
  const queue              = pool ? new PgQueue(pool)                    : new InMemoryQueue();
  const fileRepo           = pool ? new PgFileRepository(pool)           : new InMemoryFileRepository();
  const jobFileRepo        = pool ? new PgJobFileRepository(pool)        : new InMemoryJobFileRepository();
  const jobPhotoRepo       = pool ? new PgJobPhotoRepository(pool)       : new InMemoryJobPhotoRepository();
  const catalogRepo        = pool ? new PgCatalogItemRepository(pool)    : new InMemoryCatalogItemRepository();
  const feedbackRequestRepo = pool ? new PgFeedbackRequestRepository(pool) : new InMemoryFeedbackRequestRepository();
  const feedbackResponseRepo = pool ? new PgFeedbackResponseRepository(pool) : new InMemoryFeedbackResponseRepository();
  // P10-001: portal session repo (single signed token per customer for the
  // self-service portal). Wired here so both the authed creation route and
  // the public token-resolver router share one instance.
  const portalSessionRepo: PortalSessionRepository = pool
    ? new PgPortalSessionRepository(pool)
    : new InMemoryPortalSessionRepository();
  // Agreement-runs are also surfaced on the public portal (read-only).
  // Hoisted here so the public portal router (mounted before Clerk auth)
  // can reference it. `agreementRepo` is already declared above (hoisted
  // for the P11-001 voice lookup-skill family).
  const agreementRunRepo = pool
    ? new PgAgreementRunRepository(pool)
    : new InMemoryAgreementRunRepository();
  // P0-023: WebhookEvent idempotency repo. PgWebhookEventRepository (P0-020)
  // is wired here so a future webhook handler can pull it from app-level
  // wiring without re-instantiating. The webhooks/routes.ts router still
  // uses its own InMemoryWebhookRepository for the legacy
  // (provider/event/svix-id) shape — that one is unchanged.
  const webhookEventRepo   = pool ? new PgWebhookEventRepository(pool)    : new InMemoryWebhookEventRepository();
  const timeEntryRepo      = pool ? new PgTimeEntryRepository(pool)       : new InMemoryTimeEntryRepository();
  // Reference the variable so TS doesn't drop it; downstream consumers will
  // attach in a follow-up PR.
  void webhookEventRepo;

  const { provider: storageProvider, bucket: storageBucket } = createStorageProvider(
    process.env as NodeJS.ProcessEnv
  );

  const canonicalPackRegistry = pool
    ? new PgVerticalPackRegistry(pool)
    : new InMemoryCanonicalVerticalPackRegistry();
  seedCanonicalVerticalPacks(canonicalPackRegistry);

  const transcriptionProvider = createTranscriptionProvider(process.env.AI_PROVIDER_API_KEY);
  // LLM gateway — single instance shared across intent classifier,
  // voice-action-router task handlers, and future AI features.
  // Falls back to a MockLLMProvider in dev/test so the app boots
  // without an AI_PROVIDER_API_KEY.
  const llmGateway = config.AI_PROVIDER_API_KEY
    ? createLLMGateway(config)
    : createMockLLMGateway('{"intentType":"unknown","confidence":0}').gateway;

  // Phase 4a-1: dedicated EmbeddingProvider for the RAG corpus. The
  // gateway routes chat completions through shadow/router logic that
  // doesn't apply to embeddings (`text-embedding-3-small` only). When
  // AI_PROVIDER_API_KEY is unset, embeddings are unavailable and the
  // ingestion workers stay un-registered — the rest of the app boots.
  const embeddingProvider: EmbeddingProvider | null = config.AI_PROVIDER_API_KEY
    ? new OpenAICompatibleProvider({
        apiKey: config.AI_PROVIDER_API_KEY,
        baseURL: config.AI_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1',
      })
    : null;

  // Phase 4a-1 repositories — used by transcript-ingestion-worker and
  // proposal-correction-worker. All Pg-backed in production with
  // tenant-scoped RLS via PgBaseRepository.withTenant; InMemory in
  // dev/test so the app boots without DATABASE_URL.
  const knowledgeChunkRepo = pool
    ? new PgKnowledgeChunkRepository(pool)
    : new InMemoryKnowledgeChunkRepository();
  const proposalExecutionRepo = pool
    ? new PgProposalExecutionRepository(pool)
    : new InMemoryProposalExecutionRepository();
  const retrievalEvalRunRepo = pool
    ? new PgRetrievalEvalRunRepository(pool)
    : new InMemoryRetrievalEvalRunRepository();
  const callTranscriptTurnRepo = pool
    ? new PgCallTranscriptTurnRepository(pool)
    : new InMemoryCallTranscriptTurnRepository();

  const feedbackDispatcher =
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER
      ? new SmsProviderFeedbackDispatcher({
          accountSid: process.env.TWILIO_ACCOUNT_SID,
          authToken: process.env.TWILIO_AUTH_TOKEN,
          fromNumber: process.env.TWILIO_FROM_NUMBER,
        })
      : new NoopFeedbackDispatcher();

  // Customer-facing message delivery for estimates and invoices.
  // Production wires Twilio (SMS) + Twilio SendGrid (email). Without
  // the env vars, falls back to InMemoryDeliveryProvider so the app
  // boots in dev without delivery credentials. Send routes return
  // 503 when sendService is undefined.
  const dispatchRepo = pool ? new PgDispatchRepository(pool) : new InMemoryDispatchRepository();
  const messageDelivery: MessageDeliveryProvider | null =
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER &&
    process.env.SENDGRID_API_KEY &&
    process.env.SENDGRID_FROM_EMAIL
      ? new TwilioDeliveryProvider({
          sms: {
            accountSid: process.env.TWILIO_ACCOUNT_SID,
            authToken: process.env.TWILIO_AUTH_TOKEN,
            fromNumber: process.env.TWILIO_FROM_NUMBER,
          },
          email: {
            apiKey: process.env.SENDGRID_API_KEY,
            fromEmail: process.env.SENDGRID_FROM_EMAIL,
            fromName: process.env.SENDGRID_FROM_NAME,
            replyToEmail: process.env.SENDGRID_REPLY_TO_EMAIL,
          },
        })
      : process.env.NODE_ENV === 'production'
        ? null
        : new InMemoryDeliveryProvider();
  const publicBaseUrl = process.env.APP_PUBLIC_URL ?? 'http://localhost:5173';
  const sendService = messageDelivery
    ? new SendService({
        delivery: messageDelivery,
        estimateRepo,
        invoiceRepo,
        jobRepo,
        customerRepo,
        settingsRepo,
        dispatchRepo,
        publicBaseUrl,
      })
    : undefined;

  const workerLogger = createLogger({
    service: 'transcription-worker',
    environment: process.env.NODE_ENV || 'development',
    level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  });

  const transcriptionWorker = createTranscriptionWorker(
    voiceRepo,
    transcriptionProvider,
    {
      onTranscribed: async (event, hookLogger) => {
        // Enqueue the downstream voice-action-router job. A separate
        // poll loop (below) picks it up and runs intent classification.
        // Keeping it on the queue instead of running inline means:
        //   1) transcription success isn't blocked by classifier latency
        //   2) router failures are retried by the queue, not stalled
        //   3) transcription and router workers can scale independently
        const routerPayload: VoiceActionRouterPayload = {
          tenantId: event.tenantId,
          userId: event.userId ?? 'system',
          transcript: event.transcript,
          conversationId: event.conversationId,
          recordingId: event.recordingId,
        };
        await queue.send(
          'voice_action_router',
          routerPayload,
          `${event.tenantId}:${event.recordingId}:voice_action_router`
        );
        hookLogger.info('voice_action_router enqueued', {
          recordingId: event.recordingId,
        });
      },
    }
  );

  // Worker dispatch — one poll loop routes messages to handlers by
  // message.type. The queue doesn't filter by type on receive, so
  // dispatching here keeps the queue interface simple and lets us
  // register additional workers without spawning more poll loops.
  const workerRegistry = new Map<string, import('./queues/queue').WorkerHandler<unknown>>();
  workerRegistry.set(
    transcriptionWorker.type,
    transcriptionWorker as import('./queues/queue').WorkerHandler<unknown>
  );

  // Phase 4a-1 transcript-ingestion-worker only (proposal-correction-worker
  // needs proposalRepo which is declared further down — registered after
  // that). Without AI_PROVIDER_API_KEY the worker stays un-registered.
  // Phase 4c: shared language detector (offline, microsecond-fast).
  // Constructed once and threaded into every consumer that wants
  // language telemetry — currently the transcript-ingestion-worker
  // (per-call stamp) and the retrieve adapter (per-query log).
  const languageDetector = new FrancLanguageDetector();

  if (embeddingProvider) {
    const transcriptIngestionWorker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: embeddingProvider,
      languageDetector,
    });
    workerRegistry.set(
      transcriptIngestionWorker.type,
      transcriptIngestionWorker as import('./queues/queue').WorkerHandler<unknown>,
    );
  }

  // ── Diff-analysis worker (P0-018): compares two revision snapshots and
  // persists a structured field-level delta. P0-023 graduates the revision
  // store and the analysis store onto Postgres when DATABASE_URL is set —
  // dev still uses the in-memory variants so tests boot without a DB.
  const documentRevisionRepo = pool
    ? new PgDocumentRevisionRepository(pool)
    : new InMemoryDocumentRevisionRepository();
  const diffAnalysisRepo = pool
    ? new PgDiffAnalysisRepository(pool)
    : new InMemoryDiffAnalysisRepository();
  const diffAnalysisWorker = createDiffAnalysisWorker(
    documentRevisionRepo,
    diffAnalysisRepo
  );
  workerRegistry.set(
    diffAnalysisWorker.type,
    diffAnalysisWorker as import('./queues/queue').WorkerHandler<unknown>
  );

  // ── Auto-delivery worker: sweeps approved proposals past the 5-second
  // undo window and hands them to the executor. Closes the operational
  // question from the D9 undo-window slice: "who kicks execution after
  // the window closes?" The answer is this poll, on a 1-second interval.
  let proposalRepo: InMemoryProposalRepository | PgProposalRepository;
  if (pool) {
    proposalRepo = new PgProposalRepository(pool);
  } else {
    proposalRepo = new InMemoryProposalRepository();
    if (config.NODE_ENV !== 'test') {
      // Loud warning: silent InMemory fallback in dev causes "works in dev,
      // broken in prod" bugs (proposals disappear on restart, no RLS enforcement,
      // no cross-tenant sweep). If you see this outside of tests, set DATABASE_URL.
      // eslint-disable-next-line no-console
      console.warn(
        '[app] ⚠️  DATABASE_URL unset — using InMemoryProposalRepository. ' +
        'Proposals will NOT persist across restarts and the auto-delivery worker ' +
        'will behave differently than in prod. Set DATABASE_URL to use Postgres.'
      );
    }
  }
  // Voice intents (add_note, send_invoice, record_payment) execute
  // against real domain repositories. Note + payment use the same
  // in-memory or Pg repos already wired above. Invoice delivery
  // routes through the unified SendService when delivery credentials
  // are configured; otherwise falls back to the Noop so the proposal
  // executor stays exercised in dev/test without sending bytes.
  const invoiceDeliveryProvider = sendService
    ? new SendServiceInvoiceDeliveryProvider(sendService)
    : new NoopInvoiceDeliveryProvider();
  const dispatchAnalyticsRepo = pool
    ? new PgDispatchAnalyticsRepository(pool)
    : new InMemoryDispatchAnalyticsRepository();
  const executionHandlers = createExecutionHandlerRegistry({
    appointmentRepo,
    assignmentRepo,
    invoiceRepo,
    estimateRepo,
    settingsRepo,
    noteRepo,
    paymentRepo,
    invoiceDeliveryProvider,
    analyticsRepo: dispatchAnalyticsRepo,
  });
  // Phase 4a-1: persist a proposal_executions row on success + fire the
  // proposal-correction-worker. The onExecuted callback is failure-soft
  // inside the executor itself (logs via console, never rethrows), so
  // queue-send errors here can't break the executor's invariants.
  const proposalExecutor = new ProposalExecutor(
    executionHandlers,
    proposalRepo,
    undefined,
    {
      executionRepo: proposalExecutionRepo,
      onExecuted: async (event) => {
        if (event.status !== 'succeeded') return;
        try {
          await queue.send(
            'proposal_correction',
            {
              tenantId: event.tenantId,
              proposalId: event.proposalId,
              ...(event.executionId ? { executionId: event.executionId } : {}),
            },
            `correction:${event.executionId ?? event.proposalId}:v1`,
          );
        } catch (err) {
          // Logged inside the executor too; double-log is fine — this
          // path is a real production failure (queue is down) worth
          // noticing in both places.
          // eslint-disable-next-line no-console
          console.error('app: failed to enqueue proposal_correction', {
            proposalId: event.proposalId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
  );

  // Phase 4a-1: register the proposal-correction-worker now that
  // proposalRepo is in scope. Skipped silently when no embedder.
  if (embeddingProvider) {
    const proposalCorrectionWorker = createProposalCorrectionWorker({
      proposalRepo,
      proposalExecutionRepo,
      knowledgeChunkRepo,
      embeddings: embeddingProvider,
      retrievalEvalRunRepo,
    });
    workerRegistry.set(
      proposalCorrectionWorker.type,
      proposalCorrectionWorker as import('./queues/queue').WorkerHandler<unknown>,
    );
  }

  // Phase 4a-2: build the `retrieve` adapter consumed by
  // `buildSourceContext` when callers want grounded RAG augmentation.
  // Gated on `RAG_RETRIEVAL_ENABLED === 'true'` so the corpus can fill
  // (Phase 4a-1 writers) before the reader fires in production. When
  // the flag is off the adapter is `undefined` and `buildSourceContext`
  // falls through to the legacy recency-only path. Phase 4b will pass
  // this through to the FSM `intent_capture` state once we measure
  // latency impact in 4a.
  const ragRetrievalEnabled = process.env.RAG_RETRIEVAL_ENABLED === 'true';
  const retrieveAdapter: RetrieveAdapter | undefined =
    ragRetrievalEnabled && embeddingProvider
      ? createRetrieveAdapter({
          embeddings: embeddingProvider,
          knowledgeChunkRepo,
          retrievalEvalRunRepo,
          languageDetector,
        })
      : undefined;
  // The variable is wired into future `buildSourceContext` call sites
  // (Phase 4b). Reference it once so the linter doesn't flag the
  // construction during the gap between 4a-2 and 4b landing.
  void retrieveAdapter;

  const delayNoticeStateRepo = pool
    ? new PgDelayNoticeStateRepository(pool)
    : new InMemoryDelayNoticeStateRepository();
  const delayNotificationCoordinator = new DelayNotificationCoordinator(
    queue,
    new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo),
    delayNoticeStateRepo,
  );
  const delayNotificationWorker = createDelayNotificationWorker({
    service: new NoopDelayNotificationService(),
    stateRepo: delayNoticeStateRepo,
    analyticsRepo: dispatchAnalyticsRepo,
  });
  workerRegistry.set(
    delayNotificationWorker.type,
    delayNotificationWorker as import('./queues/queue').WorkerHandler<unknown>
  );
  const executionWorkerLogger = createLogger({
    service: 'execution-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  setInterval(async () => {
    try {
      await runExecutionSweep({
        proposalRepo,
        executor: proposalExecutor,
        logger: executionWorkerLogger,
      });
    } catch (err) {
      executionWorkerLogger.error('Execution sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 1000);

  // voice-action-router — consumes transcripts enqueued by the
  // transcription worker's onTranscribed hook, classifies intent,
  // and persists a proposal via proposalRepo. Registered now that
  // proposalRepo is available.
  //
  // P0-035 wiring (PR #202 follow-up): pass a SlotConflictChecker so
  // create_appointment proposals run a pre-draft availability check
  // and emit a voice_clarification proposal on conflict instead of a
  // create_appointment that the dispatcher will reject. Without this
  // construction, the checker shipped in PR #201 is dead code.
  const slotConflictChecker = new DefaultSlotConflictChecker({
    appointmentRepo,
    assignmentRepo,
    jobRepo,
  });
  // Surface up to 3 alternative open slots in the voice_clarification
  // proposal whenever the conflict checker rejects the AI's pick. The
  // dispatcher gets concrete next-available windows instead of a
  // "please pick another time" prompt.
  const availabilityFinder = new DefaultAvailabilityFinder({
    appointmentRepo,
    assignmentRepo,
  });
  const voiceActionRouterWorker = createVoiceActionRouterWorker({
    gateway: llmGateway,
    proposalRepo,
    slotConflictChecker,
    availabilityFinder,
  });
  workerRegistry.set(
    voiceActionRouterWorker.type,
    voiceActionRouterWorker as import('./queues/queue').WorkerHandler<unknown>
  );

  const feedbackSendWorker = createFeedbackSendWorker({
    jobRepo,
    customerRepo,
    settingsRepo,
    feedbackRequestRepo,
    dispatcher: feedbackDispatcher,
    publicBaseUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:5173',
  });
  workerRegistry.set(
    feedbackSendWorker.type,
    feedbackSendWorker as import('./queues/queue').WorkerHandler<unknown>
  );

  // Unified queue poll loop: receives any message type and routes to the
  // matching worker by message.type. This is the single consumer for the
  // queue — multiple setInterval poll loops would race for the same row
  // under PgQueue's FOR UPDATE SKIP LOCKED semantics and waste cycles.
  setInterval(async () => {
    try {
      const message = await queue.receive();
      if (!message) return;
      const handler = workerRegistry.get(message.type);
      if (!handler) {
        workerLogger.warn('No worker registered for message type', { type: message.type });
        await queue.delete(message.id);
        return;
      }
      const processed = await processMessage(message, handler, workerLogger);
      if (processed) {
        await queue.delete(message.id);
      } else if (message.attempts >= message.maxAttempts) {
        await queue.moveToDeadLetter(message, 'max attempts exceeded');
        workerLogger.error('Message moved to DLQ', {
          messageId: message.id,
          type: message.type,
          attempts: message.attempts,
        });
      }
    } catch (err) {
      workerLogger.error('Queue poll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 250);

  // Cross-entity tenant ownership guard. Routes pass parent ids (e.g.
  // jobs.customerId) through validation against the requesting tenant
  // before creating child entities — closes the cross-entity reference
  // forgery class flagged by the tenant-isolation adversarial suite.
  const ownership = createTenantOwnership({
    customerRepo,
    locationRepo,
    jobRepo,
    estimateRepo,
    invoiceRepo,
    appointmentRepo,
    leadRepo,
  });

  // Public feedback routes are mounted before /api auth middleware.
  app.use('/public/feedback', createPublicFeedbackRouter(feedbackRequestRepo, feedbackResponseRepo, settingsRepo));

  // Public lead intake — embedded marketing-page form posts here.
  // Tenant identified by UUID in the URL. The outer `/public` limiter
  // (30/min/IP, mounted above) catches abuse; the intake-specific
  // limiter below adds a tighter per-IP bucket because intake writes
  // to the database (vs the read-only token-gated public flows).
  // Uses an in-memory dev tenant repo when running without a pool so
  // local dev / tests still work.
  const intakeTenantRepo = tenantRepo ?? new DevInMemoryTenantRepository();
  app.use(
    '/public/intake',
    rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    createPublicIntakeRouter(leadRepo, intakeTenantRepo, auditRepo)
  );

  // Public unauthenticated estimate approval flow (token-authenticated).
  const publicEstimateService = new PublicEstimateService({
    estimateRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
  });
  app.use('/public/estimates', createPublicEstimatesRouter(publicEstimateService));

  // Public unauthenticated invoice payment flow (token-authenticated).
  // Stripe Payment Link creation is enabled when STRIPE_SECRET_KEY is set.
  const publicInvoiceService = new PublicInvoiceService({
    invoiceRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
    stripeConfig: process.env.STRIPE_SECRET_KEY
      ? { apiKey: process.env.STRIPE_SECRET_KEY }
      : undefined,
  });
  app.use('/public/invoices', createPublicInvoicesRouter(publicInvoiceService));

  // P10-001: Public, token-gated customer portal. Mounted BEFORE the
  // global `/api` Clerk auth middleware because the portal token IS
  // the auth — no Clerk session is involved. Routes resolve the
  // `:token` URL param, set `req.portal = { tenantId, customerId,
  // sessionId }`, and downstream queries scope to that tenant id.
  app.use(
    '/api/public/portal',
    createPublicPortalRouter({
      portalRepo: portalSessionRepo,
      customerRepo,
      estimateRepo,
      invoiceRepo,
      jobRepo,
      agreementRepo,
      appointmentRepo,
      leadRepo,
      auditRepo,
      paymentLinkProvider,
    }),
  );

  // P5-016: Public payments (Stripe PaymentIntent / Elements flow).
  // Returns a `client_secret` so the customer's browser can confirm the
  // payment directly with Stripe — card data never touches our server.
  // Lives under /api/public-payments (not /public) so the frontend's
  // existing /api/* base URL config picks it up.
  app.use(
    '/api/public-payments',
    createPublicPaymentsRouter({
      invoiceRepo,
      stripeConfig: process.env.STRIPE_SECRET_KEY
        ? { apiKey: process.env.STRIPE_SECRET_KEY }
        : null,
    }),
  );

  // ── Twilio telephony webhooks (P8-011) ────────────────────────────────────
  // Mounted under /api/telephony but BEFORE the Clerk auth middleware so
  // Twilio's signed POSTs aren't rejected for missing a Clerk session.
  // Authentication is enforced inside the router via X-Twilio-Signature
  // verification (twilio-signature.ts).
  // Single shared voice session store: in-app and telephony both create
  // sessions in the same VoiceSessionStore so the FSM/cost-tracker pool
  // is uniform across channels. Process-local; idle-reaped via setInterval.
  const voiceSessionStore = new VoiceSessionStore();
  // OnCall repo is created here so both the telephony adapter (notify_oncall
  // side effect) and the in-app adapter (escalation) share a single
  // implementation. The in-app block below reuses this same instance.
  const sharedOnCallRepo = pool ? new PgOnCallRepository(pool) : new InMemoryOnCallRepository();
  const twilioAdapter = new TwilioGatherAdapter({
    store: voiceSessionStore,
    gateway: llmGateway,
    ...(pool ? { pool } : {}),
    proposalRepo,
    auditRepo,
    onCallRepo: sharedOnCallRepo,
    leadRepo,
    // P11-001: lookup-skill family wiring. Without these the adapter
    // falls back to a "let me get a person to help" line on lookup_*
    // intents — the call doesn't crash, but the read-only path is
    // unavailable. agreementRepo lives a few hundred lines down.
    jobRepo,
    appointmentRepo,
    invoiceRepo,
    agreementRepo,
    lookupEvents: lookupEventService,
    systemActorId: 'system:inbound-call',
    businessName: process.env.TWILIO_BUSINESS_NAME ?? 'our team',
    ...(process.env.PUBLIC_API_URL ? { publicBaseUrl: process.env.PUBLIC_API_URL } : {}),
    // P8-014: when set, the initial inbound TwiML emits a
    // <Start><Record recordingStatusCallback="..."/></Start> block so
    // Twilio asynchronously records the entire call and POSTs metadata
    // to /api/telephony/recording on completion.
    recordingCallbackPath: '/api/telephony/recording',
  });
  // P8-012: feature flag the Media Streams (live audio) path. Default
  // off — when off, the existing Gather adapter remains the only
  // telephony surface. When on, /voice returns a <Connect><Stream/>
  // TwiML and audio flows over the WebSocket attached below.
  const mediaStreamsEnabled = process.env.TWILIO_MEDIA_STREAMS_ENABLED === 'true';
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: twilioAdapter,
      authTokenGetter: () => process.env.TWILIO_AUTH_TOKEN,
      publicBaseUrl: process.env.PUBLIC_API_URL,
      // Single-tenant fallback. TODO: replace with phone-number → tenant lookup.
      resolveTenantId: () => process.env.TWILIO_DEFAULT_TENANT_ID,
      mediaStreamsEnabled,
      // P8-014: mount the recording webhook in production. Without this
      // block the route is unreachable and Twilio's recordingStatusCallback
      // POSTs 404 — call recordings would be lost. Pool / Twilio creds are
      // optional from the router's perspective (handler degrades to
      // "persistence skipped" with a warning) but should be wired in
      // production environments.
      recording: {
        store: voiceSessionStore,
        ...(pool ? { pool } : {}),
        storage: storageProvider,
        storageBucket,
        ...(process.env.TWILIO_ACCOUNT_SID
          ? { twilioAccountSid: process.env.TWILIO_ACCOUNT_SID }
          : {}),
        ...(process.env.TWILIO_AUTH_TOKEN
          ? { twilioAuthToken: process.env.TWILIO_AUTH_TOKEN }
          : {}),
        // Phase 4a-1: enqueue transcript-ingestion when the recording row
        // first lands. Skipped on Twilio retries (`inserted=false`) so
        // we don't double-process the same call. Skipped silently when
        // the embedding provider is unwired (no AI_PROVIDER_API_KEY).
        ...(embeddingProvider
          ? {
              options: {
                onPersisted: async (event) => {
                  if (!event.inserted) return;
                  const session = voiceSessionStore.findByCallSid(event.callSid);
                  if (!session) {
                    // Session was reaped (>30 min idle) before the
                    // recording webhook fired. Known data-loss edge
                    // case from the in-memory session store; not
                    // something Phase 4a-1 fixes. Phase 4 architecture
                    // doc covers persistent FSM state as a follow-up.
                    return;
                  }
                  try {
                    await queue.send(
                      'transcript_ingestion',
                      {
                        tenantId: event.tenantId,
                        voiceRecordingId: event.voiceRecordingId,
                        transcript: [...session.transcript],
                        ...(session.machine.currentContext.currentIntent
                          ? { intent: session.machine.currentContext.currentIntent }
                          : {}),
                        durationMs: Date.now() - session.createdAt.getTime(),
                      },
                      `transcript:${event.voiceRecordingId}:v1`,
                    );
                  } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('app: failed to enqueue transcript_ingestion', {
                      voiceRecordingId: event.voiceRecordingId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                },
              },
            }
          : {}),
      },
    }),
  );

  // P8-012: attach the Media Streams WebSocketServer to the http.Server
  // returned by app.listen(). We override `app.listen` so the bare
  // `index.ts` entry point doesn't need any new wiring — when the
  // server starts listening, the upgrade handler is already attached.
  // The flag also gates whether DeepgramStreamingProvider is constructed
  // (no DEEPGRAM_API_KEY required when the feature is disabled).
  if (mediaStreamsEnabled) {
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
      // eslint-disable-next-line no-console
      console.warn(
        '[app] ⚠️  TWILIO_MEDIA_STREAMS_ENABLED=true but DEEPGRAM_API_KEY is unset. ' +
        'Live-audio streaming will fail when calls connect. Set DEEPGRAM_API_KEY or ' +
        'flip TWILIO_MEDIA_STREAMS_ENABLED=false.'
      );
    }
    // ttsProvider is constructed below for the in-app adapter; we need
    // it here too. Build a single instance and pass it to both.
    const sharedTtsProvider = createTtsProvider({
      TTS_PROVIDER: process.env.TTS_PROVIDER,
      ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
      AI_PROVIDER_API_KEY: config.AI_PROVIDER_API_KEY,
    });
    const streamingProvider = deepgramKey
      ? new DeepgramStreamingProvider(deepgramKey)
      : null;
    if (streamingProvider) {
      const origListen = app.listen.bind(app);
      // Wrap listen() so the WS upgrade handler is attached the moment
      // the http.Server exists. Fire-and-forget; errors during attach
      // are surfaced via the logger inside attachMediaStreamServer.
      app.listen = ((...args: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const server = (origListen as any)(...args);
        attachMediaStreamServer(
          server,
          {
            store: voiceSessionStore,
            streamingProvider,
            ...(sharedTtsProvider ? { ttsProvider: sharedTtsProvider } : {}),
            speechTurn: async ({ session, speechResult, callSid, tenantId }) =>
              twilioAdapter.processCallerUtterance({
                sessionId: session.id,
                callSid,
                speechResult,
                tenantId,
              }),
            authTokenGetter: () => process.env.TWILIO_AUTH_TOKEN,
            ...(process.env.PUBLIC_API_URL ? { publicBaseUrl: process.env.PUBLIC_API_URL } : {}),
          },
        );
        return server;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
    }
  }

  // Auth middleware for API routes
  const clerkSecret = process.env.CLERK_SECRET_KEY ?? '';
  app.use('/api', verifyClerkSession(clerkSecret));

  // DEV ONLY — hard-gated on NODE_ENV=dev + DEV_AUTH_BYPASS=true.
  // Accepts Clerk tokens without RS256/JWKS verification and
  // auto-bootstraps a tenant per Clerk user. Exists because
  // verifyClerkSession uses HMAC-SHA256 (not Clerk's real signing
  // algorithm) — tracked as a production bug. No-op in non-dev.
  if (isDevAuthBypassEnabled()) {
    const devTenantRepo = tenantRepo ?? new DevInMemoryTenantRepository();
    app.use('/api', devAuthBypass({ tenantRepo: devTenantRepo }));
    // eslint-disable-next-line no-console
    console.warn(
      '[app] ⚠️  DEV_AUTH_BYPASS=true — accepting Clerk tokens WITHOUT signature verification. ' +
      'Never enable this outside local dev.'
    );
  }

  // Fail-closed: every /api/* request must carry a valid Clerk session.
  // Individual routes still apply requireAuth/requireTenant/requirePermission
  // as defense in depth, but this line makes it architecturally impossible
  // for a new route to be silently public just because the author forgot
  // to opt into the per-route gate. The decisions test suite guards this
  // invariant in packages/api/test/decisions/decisions.test.ts (D6).
  app.use('/api', requireAuth);

  // P0-024: open a request-scoped transaction with `app.current_tenant_id`
  // set LOCAL so every query in the request reuses the same client and
  // RLS fires automatically. Public routes (health, /public/*, and
  // /api/public-payments) are mounted earlier and never reach this line.
  // Skipped when no pool is wired (in-memory dev mode) — there's no
  // database to attach a transaction to.
  if (pool) {
    app.use('/api', withTenantTransaction(pool));
  }

  // Mount API routes
  app.use('/api/customers', createCustomerRouter(customerRepo, auditRepo));
  app.use('/api/time-entries', createTimeEntriesRouter(timeEntryRepo, auditRepo));
  // P10-001: portal session creation/revocation. Mounted at
  // `/api/portal-sessions` (NOT `/api/customers/:id/portal-session`)
  // because routes/customers.ts is on the freeze list — the body
  // carries the customerId. URL composition uses request host so
  // the link points at this same deployment.
  app.use(
    '/api/portal-sessions',
    createPortalRouter({ portalRepo: portalSessionRepo, customerRepo }),
  );
  app.use('/api/leads', createLeadsRouter(leadRepo, customerRepo, auditRepo));
  app.use('/api/locations', createLocationRouter(locationRepo, ownership));
  app.use('/api/jobs', createJobRouter(jobRepo, timelineRepo, auditRepo, ownership, queue, feedbackDispatcher));
  app.use(
    '/api/jobs',
    createJobFilesRouter({
      jobFileRepo,
      storage: storageProvider,
      bucket: storageBucket,
      auditRepo,
    })
  );
  app.use(
    '/api/jobs',
    createJobPhotosRouter({
      service: new JobPhotoService(jobPhotoRepo, fileRepo, storageProvider),
      fileRepo,
      storage: storageProvider,
      bucket: storageBucket,
      auditRepo,
    })
  );
  app.use(
    '/api/appointments',
    createAppointmentRouter(appointmentRepo, ownership, jobRepo, timelineRepo, {
      delayNotificationCoordinator,
    })
  );
  app.use('/api/dispatch', createDispatchRoutes({ appointmentRepo, assignmentRepo }));
  app.use('/api/estimates', createEstimateRouter(estimateRepo, settingsRepo, auditRepo, ownership, sendService));
  app.use('/api/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo, ownership, paymentRepo, sendService));

  // Tenant-scoped reporting (revenue by lead source / UTM).
  const revenueBySourceRepo = pool
    ? new PgRevenueBySourceRepository(pool)
    : new InMemoryRevenueBySourceRepository();
  app.use('/api/reports', createReportsRouter(revenueBySourceRepo));
  app.use('/api/payments', createPaymentRouter(paymentRepo, invoiceRepo));
  app.use('/api/notes', createNoteRouter(noteRepo, ownership));

  // ── P12-001: /api/me — current user + mode ──────────────────────────────
  // Pg-backed UserModeService when DATABASE_URL is set; in-memory in
  // dev / no-DB mode. The middleware-side mode loader is wired at the
  // same time so requireTenant can populate `req.auth.mode` against the
  // same data source used by the /api/me reads.
  const userModeService: UserModeService = pool
    ? {
        async getUser(tenantId, userId) {
          // P12-001 review fix — `userId` here is the Clerk subject
          // (`req.auth.userId` = `payload.sub`), not the UUID PK on
          // `users.id`. Lookup goes through `clerk_user_id`. The
          // returned `user_id` continues to be the Clerk sub so
          // downstream callers (the API surface) stay aligned with
          // the auth-layer identity.
          const r = await pool.query(
            `SELECT clerk_user_id, tenant_id, role,
                    COALESCE(can_field_serve, false) AS can_field_serve,
                    COALESCE(current_mode, 'supervisor') AS current_mode,
                    mode_changed_at
             FROM users
             WHERE tenant_id = $1 AND clerk_user_id = $2
             LIMIT 1`,
            [tenantId, userId],
          );
          if (r.rowCount === 0) return null;
          const row = r.rows[0] as Record<string, unknown>;
          const rec: MeUserRecord = {
            user_id: String(row.clerk_user_id),
            tenant_id: String(row.tenant_id),
            role: String(row.role),
            can_field_serve: Boolean(row.can_field_serve),
            current_mode: row.current_mode as MeUserRecord['current_mode'],
            mode_changed_at: row.mode_changed_at
              ? new Date(row.mode_changed_at as string)
              : null,
          };
          return rec;
        },
        async getTenantSettings(tenantId) {
          const r = await pool.query(
            `SELECT backup_supervisor_user_id,
                    COALESCE(unsupervised_proposal_routing, 'queue_and_sms') AS unsupervised_proposal_routing
             FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
            [tenantId],
          );
          if (r.rowCount === 0) {
            return {
              backup_supervisor_user_id: null,
              unsupervised_proposal_routing: 'queue_and_sms',
            } as MeTenantSettings;
          }
          const row = r.rows[0] as Record<string, unknown>;
          return {
            backup_supervisor_user_id: row.backup_supervisor_user_id
              ? String(row.backup_supervisor_user_id)
              : null,
            unsupervised_proposal_routing:
              row.unsupervised_proposal_routing as MeTenantSettings['unsupervised_proposal_routing'],
          };
        },
        async setMode(tenantId, userId, mode) {
          // P12-001 review fix — `userId` is the Clerk subject; match
          // on `clerk_user_id`, not the UUID PK. Without this the
          // UPDATE silently no-ops in production.
          const now = new Date();
          await pool.query(
            `UPDATE users
             SET current_mode = $1, mode_changed_at = $2, updated_at = now()
             WHERE tenant_id = $3 AND clerk_user_id = $4`,
            [mode, now, tenantId, userId],
          );
          return { modeChangedAt: now };
        },
      }
    : new InMemoryUserModeService();

  // Wire the middleware-side mode loader. Reuses the same service so
  // we don't drift between read paths.
  setUserModeLoader(async (userId, tenantId) => {
    try {
      const u = await userModeService.getUser(tenantId, userId);
      return u ? u.current_mode : null;
    } catch {
      return null;
    }
  });

  // Phase 12 — wire the tenant-wide supervisor-presence loader. The
  // proposal auto-approve threshold and the emergency-immediate-Dial
  // helper both consult this. Keep wired in dev only when a Pool is
  // available; otherwise the in-memory permissive default applies.
  if (pool) {
    setSupervisorPresenceLoader(pgSupervisorPresenceLoader(pool));
  }

  app.use('/api/me', createMeRouter(userModeService, auditRepo));
  app.use('/api/feedback/responses', createFeedbackResponsesRouter(feedbackResponseRepo));
  app.use('/api/conversations', createConversationRouter(conversationRepo));
  app.use('/api/settings', createSettingsRouter(settingsRepo));
  app.use('/api/settings/packs', createPackActivationRouter(packActivationRepo, canonicalPackRegistry));
  app.use('/api/verticals', createVerticalRouter(canonicalPackRegistry));
  app.use('/api/templates', createTemplateRouter(templateRepo));
  app.use('/api/bundles', createBundleRouter(bundleRepo));
  app.use('/api/quality', createQualityRouter({ metricsRepo: qualityMetricsRepo, approvalRepo, deltaRepo }));
  app.use('/api/voice', createVoiceRouter(voiceRepo, queue));
  app.use(
    '/api/technician-location',
    createTechnicianLocationRouter({
      repository: technicianLocationPingRepo,
      canSubmitForTechnician: (auth, technicianId) =>
        technicianLocationAuthorizer.canSubmitForTechnician(auth, technicianId),
    })
  );
  app.use('/api/catalog/items', createCatalogItemsRouter(catalogRepo));
  app.use(
    '/api/files',
    createFilesRouter({ fileRepo, storage: storageProvider, bucket: storageBucket, auditRepo })
  );
  app.use('/api/assistant', createAssistantRouter({ gateway: llmGateway, proposalRepo }));
  app.use('/api/proposals', createProposalsRouter(proposalRepo));

  // ── Service agreements (P9-003) ─────────────────────────────────────────
  // Recurring service contracts auto-generate a job + draft invoice on
  // their cadence. Bypasses the proposals layer because the customer-
  // signing-up step is the approval; subsequent runs execute it.
  // (`agreementRepo` and `agreementRunRepo` are declared earlier so the
  // public portal router can reference the same instance.)
  const agreementsJobsService = {
    async createJob(input: {
      tenantId: string;
      customerId: string;
      locationId: string;
      summary: string;
      createdBy: string;
    }) {
      const job = await createJobDomain(
        {
          tenantId: input.tenantId,
          customerId: input.customerId,
          locationId: input.locationId,
          summary: input.summary,
          createdBy: input.createdBy,
          actorRole: 'system',
        },
        jobRepo,
        auditRepo,
      );
      return { id: job.id };
    },
  };
  const agreementsInvoicesService = {
    async createDraftInvoice(input: {
      tenantId: string;
      jobId: string;
      priceCents: number;
      description: string;
      createdBy: string;
    }) {
      const invoice = await createInvoiceDomain(
        {
          tenantId: input.tenantId,
          jobId: input.jobId,
          invoiceNumber: `AGREEMENT-${Date.now()}`,
          lineItems: [
            {
              id: `agreement-${Date.now()}`,
              description: input.description,
              quantity: 1,
              unitPriceCents: input.priceCents,
              totalCents: input.priceCents,
              sortOrder: 0,
              taxable: false,
            },
          ],
          customerMessage: undefined,
          createdBy: input.createdBy,
        },
        invoiceRepo,
        auditRepo,
      );
      return { id: invoice.id };
    },
  };
  app.use(
    '/api/agreements',
    createAgreementsRouter({
      agreementRepo,
      runRepo: agreementRunRepo,
      auditRepo,
      jobsService: agreementsJobsService,
      invoicesService: agreementsInvoicesService,
    }),
  );

  // Recurring agreements sweep (P9-003). Runs every 60s. Uses the same
  // setInterval driver pattern as the execution-worker (P0-009). The
  // tenant lister falls back to an empty list outside of pg mode so
  // the in-memory dev server doesn't churn.
  const agreementsLogger = createLogger({
    service: 'recurring-agreements-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  setInterval(async () => {
    try {
      await runRecurringAgreementsSweep({
        agreementRepo,
        runRepo: agreementRunRepo,
        jobsService: agreementsJobsService,
        invoicesService: agreementsInvoicesService,
        listTenantIds: async () => {
          if (!pool) return [];
          const r = await pool.query('SELECT id FROM tenants');
          return r.rows.map((row: { id: string }) => row.id);
        },
        auditRepo,
        logger: agreementsLogger,
      });
    } catch (err) {
      agreementsLogger.error('Recurring-agreements sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 60_000);

  // P8-009: in-app voice session adapter. Reuses the LLM gateway, the
  // unified TTS provider, and the existing proposal/audit/oncall repos.
  // The voiceSessionStore is shared with the Twilio adapter (created above).
  const ttsProvider = createTtsProvider({
    TTS_PROVIDER: process.env.TTS_PROVIDER,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    AI_PROVIDER_API_KEY: config.AI_PROVIDER_API_KEY,
  });
  const inAppVoiceAdapter = new InAppVoiceAdapter({
    store: voiceSessionStore,
    gateway: llmGateway,
    ...(ttsProvider ? { ttsProvider } : {}),
    proposalRepo,
    auditRepo,
    onCallRepo: sharedOnCallRepo,
    ...(pool ? { pool } : {}),
  });
  app.use(
    '/api/voice/sessions',
    createVoiceSessionsRouter({ adapter: inAppVoiceAdapter, store: voiceSessionStore })
  );

  const featureFlagRepo: FeatureFlagRepository = pool
    ? new PgFeatureFlagRepository(pool)
    : new InMemoryFeatureFlagRepository();
  const featureFlagStore = new InMemoryFeatureFlagStore();
  // Hydration is fire-and-forget on boot — the store starts empty and is
  // refilled from the repo asynchronously. isFeatureEnabled returns false
  // for missing flags, so the worst case during the hydration window is
  // that a flag reads as disabled for a few ms.
  void hydrateStoreFromRepository(featureFlagStore, featureFlagRepo);
  app.use('/api/admin/feature-flags', createFeatureFlagsRouter(featureFlagRepo, featureFlagStore));

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  });

  // P0-023: Graceful shutdown — close the Postgres pool on SIGTERM/SIGINT so
  // Railway's stop signal doesn't strand active connections. We use
  // `process.once` so repeated `createApp()` calls inside the test runner
  // don't stack handlers, and we exit only when the pool finishes draining
  // (or after a 5s safety timeout). Server lifecycle is owned by index.ts —
  // this handler only takes responsibility for the DB pool.
  const shutdown = async (signal: NodeJS.Signals) => {
    try {
      // eslint-disable-next-line no-console
      console.log(`[app] ${signal} received — closing voice sessions and pg pool`);
      // Stop the voice-session-store reaper interval so the process can
      // exit cleanly even when no DB pool is wired (dev / in-memory mode).
      voiceSessionStore.dispose();
      if (pool) {
        await Promise.race([
          pool.end(),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[app] shutdown failed', err);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return app;
}
