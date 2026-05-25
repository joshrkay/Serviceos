import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
import { DefaultTwilioCallControl } from './telephony/twilio-call-control';
import { createBusinessPhoneDispatcherResolver } from './telephony/dispatcher-phone-resolver';
import { PgPhoneNumberRepository } from './integrations/twilio/phone-number-repository';
import { attachMediaStreamServer } from './telephony/media-streams';
import { attachClientGateway, setChannelGate } from './ws/client-gateway';
import {
  decodeClerkToken,
  verifyRs256Token,
} from './auth/clerk';
import { RESILIENCE_FLAG_NAMES } from './flags/resilience-flags';
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
import { createUsersRouter } from './routes/users';
import {
  createCalendarIntegrationsRouter,
  createCalendarOAuthCallbackRouter,
} from './routes/calendar-integrations';
import {
  PgCalendarIntegrationRepository,
  PgOAuthStateRepository,
  InMemoryCalendarIntegrationRepository,
  InMemoryOAuthStateRepository,
} from './integrations/calendar-integration';
import {
  CalendarSyncService,
  PgAppointmentCalendarEventRepository,
  InMemoryAppointmentCalendarEventRepository,
} from './integrations/calendar-sync';
import { PgUserRepository } from './users/pg-user';
import { InMemoryUserRepository } from './users/user';
import { PgPendingInvitationRepository } from './users/pg-pending-invitation';
import { InMemoryPendingInvitationRepository } from './users/pending-invitation';
import { createBillingRouter } from './routes/billing';
import { StripeConnectService } from './billing/stripe-connect';
import { BillingService } from './billing/subscription';
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
import { createVerticalTrainingAssetsRouter } from './routes/vertical-training-assets';
import { createTemplateRouter } from './routes/templates';
import { createBundleRouter } from './routes/bundles';
import { createQualityRouter } from './routes/quality';
import { createPackActivationRouter } from './routes/pack-activation';
import { createVoiceRouter } from './routes/voice';
import { createVoiceGate } from './voice/voice-gate';
import { checkAndFireUpgradeNudge } from './voice/check-upgrade-nudge';
import { maybeAutoGoLiveOnInboundEnd } from './voice/go-live';
import { createOnboardingRouter } from './routes/onboarding';
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
import { RepoBackedTimeGivenBackReporter } from './reports/time-given-back';
import { createTimeEntriesRouter } from './routes/time-entries';
import { InMemoryTimeEntryRepository } from './time-tracking/time-entry';
import { PgTimeEntryRepository } from './time-tracking/pg-time-entry';
import { TimeEntryService } from './time-tracking/time-entry-service';
import {
  PgRevenueBySourceRepository,
  InMemoryRevenueBySourceRepository,
} from './reports/revenue-by-source';
import { PgMoneyDashboardRepository } from './reports/pg-money-dashboard';
import { createFeedbackResponsesRouter } from './routes/feedback';
import { createInteractionsRouter } from './routes/interactions';
import { initSentry, setSentryClient } from './monitoring/sentry';

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
import { createPaymentLinkProvider } from './payments/payment-link-provider';
import { InMemoryNoteRepository } from './notes/note';
import { InMemoryConversationRepository } from './conversations/conversation-service';
import { InMemorySettingsRepository, resolveEscalationSettings } from './settings/settings';
import { InMemoryAuditRepository } from './audit/audit';
import { InMemoryLookupEventRepository } from './lookup-events/lookup-event';
import { PgLookupEventRepository } from './lookup-events/pg-lookup-event';
import { LookupEventService } from './lookup-events/lookup-event-service';
import { InMemoryEstimateTemplateRepository } from './templates/estimate-template';
import { InMemoryServiceBundleRepository } from './verticals/bundles';
import {
  InMemoryPrivacyAuditRepository,
  InMemoryTrainingAssetRepository,
} from './verticals/in-memory-training-assets';
import { TrainingAssetRedactionService } from './verticals/training-asset-redaction';
import { TrainingAssetService } from './verticals/training-asset-service';
import { InMemoryQualityMetricsRepository } from './quality/metrics';
import { InMemoryVoiceRepository, createTranscribeAudioFn } from './voice/voice-service';
import { createWhisperTranscriptionProvider } from './voice/transcription-providers';
import { InMemoryDispatchAnalyticsRepository } from './dispatch/analytics';
import {
  InMemoryFeatureFlagStore,
  InMemoryFeatureFlagRepository,
  hydrateStoreFromRepository,
  isFeatureEnabled,
  FeatureFlagRepository,
} from './flags/feature-flags';
import { PgFeatureFlagRepository } from './flags/pg-feature-flags';
import { createFeatureFlagsRouter } from './routes/feature-flags';
import { createAdminTenantsRouter } from './routes/admin-tenants';
import { InMemoryTechnicianLocationPingRepository } from './telemetry/technician-location-ping';
import {
  InMemoryTechnicianLocationAuthorizer,
  PgTechnicianLocationAuthorizer,
} from './telemetry/technician-location-authz';
import { InMemoryQueue, processMessage } from './queues/queue';
import { createProvisionTwilioWorker, PROVISION_TWILIO_JOB_TYPE } from './workers/provision-twilio';
import { createDeprovisionTenantWorker } from './workers/deprovision-tenant';
import { createVerifyAiWorker } from './workers/verify-ai';
import { InMemoryApprovalRepository } from './estimates/approval';
import { InMemoryEditDeltaRepository } from './estimates/edit-delta';
import { InMemoryPackActivationRepository } from './settings/pack-activation';
import { buildVerticalPromptResolver } from './verticals/resolve-active-pack';
import { VerticalTerminologyProvider } from './voice/vertical-terminology-provider';
import { FillerEngine } from './ai/agents/customer-calling/filler-engine';
import { FillerAudioCache } from './ai/agents/customer-calling/filler-audio-cache';
import { classifyTurnSentiment } from './ai/agents/customer-calling/sentiment-classifier';
import { createHvacPack } from './verticals/packs/hvac';
import { createPlumbingPack } from './verticals/packs/plumbing';
import { createElectricalPack } from './verticals/packs/electrical';
import { isValidVerticalType } from './shared/vertical-types';
import {
  buildCallerPlanContext,
  formatCallerPlanForPrompt,
} from './ai/orchestration/caller-plan-context';
import { createThresholdResolver } from './proposals/threshold-resolver';
import { createVoicePersonaResolver } from './settings/voice-persona-resolver';
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
import { InMemoryExpenseRepository } from './expenses/expense';
import { PgExpenseRepository } from './expenses/pg-expense';
import { PgNoteRepository } from './notes/pg-note';
import { PgConversationRepository } from './conversations/pg-conversation';
import { PgSettingsRepository } from './settings/pg-settings';
import { PgAuditRepository } from './audit/pg-audit';
import { PgEstimateTemplateRepository } from './templates/pg-estimate-template';
import { PgServiceBundleRepository } from './verticals/pg-bundles';
import {
  PgPrivacyAuditRepository,
  PgTrainingAssetRepository,
} from './verticals/pg-training-assets';
import { PgQualityMetricsRepository } from './quality/pg-metrics';
import { PgVoiceRepository } from './voice/pg-voice';
import { InMemoryVoiceSessionRepository } from './voice/voice-session';
import { PgVoiceSessionRepository } from './voice/pg-voice-session';
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
import { PublicEstimateService } from './estimates/public-estimate-service';
import { createPublicEstimatesRouter } from './routes/public-estimates';
import { PublicInvoiceService } from './invoices/public-invoice-service';
import { createPublicInvoicesRouter } from './routes/public-invoices';
import { createPublicPaymentsRouter } from './routes/public-payments';
import { createFeedbackSendWorker } from './workers/feedback-send';
import { runRecurringAgreementsSweep } from './workers/recurring-agreements-worker';
import { runOverdueInvoiceSweep } from './workers/overdue-invoice-worker';
import { runGoogleReviewsSweep } from './workers/google-reviews';
import { PgReviewRepository } from './reputation/pg-review';
import { PgReviewPollStateRepository } from './reputation/poll-state';
import { PgServiceCreditRepository } from './reputation/pg-service-credit';
import { PgGoogleBusinessReplyResolver } from './reputation/pg-google-business-reply-resolver';
import { MessageDeliveryReviewPrivateMessageSender } from './reputation/private-message-sender-adapter';
import { NoopBrandVoiceLoader } from './reputation/brand-voice';
import { PgCustomerLoader } from './reputation/match-customer';
import { createCredentialResolver } from './integrations/credentials';
import { InMemoryAgreementRepository } from './agreements/agreement';
import { PgAgreementRepository } from './agreements/pg-agreement';
import { InMemoryAgreementRunRepository } from './agreements/agreement-run';
import { PgAgreementRunRepository } from './agreements/pg-agreement-run';
import { createAgreementsRouter } from './routes/agreements';
import { createMaintenanceContractsRouter } from './routes/maintenance-contracts';
import {
  InMemoryPortalSessionRepository,
  PortalSessionRepository,
} from './portal/portal-session';
import { PgPortalSessionRepository } from './portal/pg-portal-session';
import { createPortalRouter } from './routes/portal';
import { createPublicPortalRouter } from './routes/public-portal';
import {
  PgTenantTransactionRunner,
  InMemoryTransactionRunner,
} from './db/tenant-transaction';
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
// P11-002: language detector re-exported so the Twilio adapter (and any
// future channel adapters) can resolve a session's language from the
// customer override + tenant default + STT hint.
export { detectLanguage } from './ai/orchestration/language-detector';
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
import type { EmbeddingProvider } from './ai/providers/openai-compatible';
import { createVoiceActionRouterWorker, VoiceActionRouterPayload } from './workers/voice-action-router';
import { DefaultSlotConflictChecker } from './ai/tasks/slot-conflict-checker';
import { DefaultAvailabilityFinder } from './ai/tasks/availability-finder';
import { runExecutionSweep } from './workers/execution-worker';
import {
  createLLMGateway,
  createMockLLMGateway,
  createEmbeddingProvider,
  shutdownCacheStores,
} from './ai/gateway/factory';
import * as gatewayFactory from './ai/gateway/factory';
import { createAiHealthRouter } from './routes/ai-health';
import { InMemoryAiRunRepository } from './ai/ai-run';
import { PgAiRunRepository } from './ai/pg-ai-run';
import { createEvaluationRouter } from './routes/evaluation';
import { PgShadowComparisonStore } from './ai/evaluation/pg-shadow-comparison';
import { InMemoryShadowComparisonStore } from './ai/evaluation/shadow-comparison';
import { createTtsProvider } from './ai/tts/tts-provider';
import { InAppVoiceAdapter } from './ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from './ai/agents/customer-calling/voice-session-store';
import { createVoiceSessionsRouter } from './routes/voice-sessions';
import { escalationOutcomeRouter } from './escalations/outcome-route';
import { escalationEventsRouter } from './escalations/events-route';
import { whisperRouter } from './telephony/whisper-route';
import { WhisperCache } from './telephony/whisper-cache';
import { requireTwilioSignature } from './telephony/twilio-signature';
import { InMemoryOnCallRepository, PgOnCallRepository } from './oncall/rotation';
import { InMemoryProposalRepository } from './proposals/proposal';
import { PgProposalRepository } from './proposals/pg-proposal';
import { ProposalExecutor } from './proposals/execution/executor';
import { IdempotencyGuard } from './proposals/execution/idempotency';
import {
  NoOpIdempotencyLockProvider,
  PgIdempotencyLockProvider,
} from './proposals/execution/idempotency-lock';
import { createExecutionHandlerRegistry } from './proposals/execution/handlers';
import { resolveInvoiceDeliveryProvider } from './proposals/execution/invoice-delivery-factory';
import { resolveEstimateDeliveryProvider } from './proposals/execution/estimate-delivery-factory';
import { InMemoryWorkingHoursRepository } from './availability/working-hours';
import { InMemoryUnavailableBlockRepository } from './availability/unavailable-block';
import { createTravelTimeProvider } from './scheduling/travel-time/factory';
import { StubSkillMatcher } from './scheduling/skill-matcher';
import { createSchedulingRouter } from './scheduling/routes';
import type { FeasibilityDependencies } from './scheduling/feasibility-types';
import {
  createDiffAnalysisWorker,
  InMemoryDiffAnalysisRepository,
} from './ai/diff-analysis';
import { InMemoryDocumentRevisionRepository } from './ai/document-revision';
import { createLogger } from './logging/logger';
import { createRequestLoggingMiddleware, captureRequestError } from './middleware/request-logging';
import {
  createDelayNotificationWorker,
  DelayNotificationCoordinator,
  InMemoryDelayNoticeStateRepository,
  NextCustomerSelector,
  NoopDelayNotificationService,
} from './notifications/delay-notifications';
import { TwilioDelayNotificationService } from './notifications/twilio-delay-notification-service';
import { TransactionalCommsService } from './notifications/transactional-comms-service';
import { runAppointmentReminderSweep } from './workers/appointment-reminder-worker';
import { runEstimateReminderSweep } from './workers/estimate-reminder-worker';
import { runEstimateExpirySweep } from './workers/estimate-expiry-worker';
import { PgDncRepository, InMemoryDncRepository } from './compliance/dnc';
import { buildStopKeywordHandler, buildStartKeywordHandler } from './compliance/stop-reply';
import { registerKeywordHandler } from './sms/inbound-dispatch';

// Auth middleware
import { verifyClerkSession } from './auth/clerk';
import {
  devAuthBypass,
  isDevAuthBypassEnabled,
  DevInMemoryTenantRepository,
} from './auth/dev-auth-bypass';
import { requireAuth } from './middleware/auth';
import { withTenantTransaction } from './middleware/tenant-context';
import type { TenantIntegrationStatus } from './integrations/status-machine';

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

/**
 * D1-3 — helmet options factory.
 *
 * Exported separately from `createApp()` so the middleware test can assert
 * header behaviour without booting the full app (which would require a real
 * Pg pool and a full set of production secrets when NODE_ENV=production).
 *
 * Production behaviour:
 *   - CSP whitelists the production frontend's external deps: Clerk
 *     (auth UI + JS), Stripe Elements, Twilio Voice JS SDK, Sentry browser
 *     SDK.
 *   - HSTS = 1 year, includeSubDomains, preload=false (preload list
 *     submission must be a deliberate human action).
 *   - X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy
 *     no-referrer.
 *   - crossOriginEmbedderPolicy is DISABLED because COEP=require-corp breaks
 *     Stripe Elements (cross-origin frames without CORP headers).
 *
 * Dev/test behaviour:
 *   - CSP disabled so Vite HMR / local tooling keep working. Other helmet
 *     defaults (nosniff, HSTS, frame deny, no-referrer) still apply.
 */
export function buildHelmetOptions(isProd: boolean): Parameters<typeof helmet>[0] {
  return {
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
              "'self'",
              'https://js.stripe.com',
              'https://*.clerk.com',
              'https://*.clerk.accounts.dev',
              'https://clerk.com',
              'https://sdk.twilio.com',
              'https://media.twiliocdn.com',
            ],
            styleSrc: [
              "'self'",
              "'unsafe-inline'",
              'https://*.clerk.com',
              'https://clerk.com',
            ],
            imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
            connectSrc: [
              "'self'",
              'https://api.stripe.com',
              'https://*.clerk.com',
              'https://clerk.com',
              'https://*.clerk.accounts.dev',
              'wss://*.twilio.com',
              'https://*.twilio.com',
              'https://*.ingest.sentry.io',
              'https://*.ingest.us.sentry.io',
            ],
            frameSrc: [
              "'self'",
              'https://js.stripe.com',
              'https://hooks.stripe.com',
              'https://*.clerk.com',
            ],
            workerSrc: ["'self'", 'blob:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
    strictTransportSecurity: {
      maxAge: 60 * 60 * 24 * 365,
      includeSubDomains: true,
      preload: false,
    },
    noSniff: true,
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  };
}

export function createApp(): express.Express {
  // §11 H3: Initialize Sentry FIRST so any error thrown during startup
  // or in handler construction below is captured. initSentry() is a no-op
  // when SENTRY_DSN is unset (dev/test), so this is safe in every env.
  // The instrument() wrappers on the four critical paths read the registered
  // client via getSentryClient() — without setSentryClient() they fall back
  // to the no-op client and exceptions are silently swallowed by the monitor.
  const sentryClient = initSentry({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.GIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA,
  });
  setSentryClient(sentryClient);

  const app = express();

  // Behind Railway / Cloudflare / any reverse proxy: trust the immediate
  // hop so req.ip + X-Forwarded-For resolve correctly. Without this,
  // express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
  // request (500 with empty body) because it can't identify the real client.
  app.set('trust proxy', 1);

  // Stripe webhook needs the raw body for signature verification.
  // Mount with express.raw() BEFORE express.json() so this path gets a Buffer
  // and the global json() middleware skips it (body-parser sets req._body = true).
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

  // Twilio posts application/x-www-form-urlencoded — mount the matching parser
  // before global express.json() so /webhooks/twilio/* routes get populated
  // req.body fields (used for signature verification + AccountSid match).
  app.use('/webhooks/twilio', express.urlencoded({ extended: false }));

  // Body parsing for all other routes
  app.use(express.json());

  // Serve static frontend files from the built React app
  const frontendPath = require('path').join(__dirname, '../../web/dist');
  app.use(express.static(frontendPath));

  // Load validated config — must happen before CORS so validateProductionConfig()
  // can throw on missing CORS_ORIGIN before we wire the middleware.
  const config = loadConfig();

  // Swagger UI — no auth required.
  // Mounted BEFORE helmet() so the CSP below doesn't break swagger-ui-express
  // (which injects inline scripts/styles to render). The /api-docs surface is
  // already public + read-only; the security trade-off is acceptable.
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  // D1-3 — helmet hardening. Adds CSP / HSTS / X-Frame-Options / nosniff /
  // referrer-policy headers the security audit (docs/pre-launch-hardening-
  // 2026-05-16.md) flagged as missing. See `buildHelmetOptions` below for
  // the full CSP whitelist + rationale.
  const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';
  app.use(helmet(buildHelmetOptions(isProd)));

  // CORS — use explicit origin in prod/staging (validated by config), wildcard in dev/test.
  app.use(cors({
    origin: config.CORS_ORIGIN ?? true,
    credentials: true,
  }));

  // Rate limiting — applied before auth to protect all routes
  // In dev mode, use a much higher limit to allow QA testing
  const isDev = process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'development';
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isDev ? 10000 : 100, // per IP — relaxed in dev for QA testing
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isDev && process.env.DEV_AUTH_BYPASS === 'true',
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

  const requestLogger = createLogger({
    service: 'api-http',
    environment: process.env.NODE_ENV || 'development',
  });
  app.use(createRequestLoggingMiddleware(requestLogger));

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

  // P2-029 — AI provider health endpoint. Public, no auth required.
  // Uses the shared breaker registry populated by createLLMGateway().
  // Reading gatewayFactory.sharedBreakerRegistry at request time (not at
  // mount time) ensures the registry is populated after createLLMGateway()
  // is called later in the boot sequence.
  app.use('/api/health', (req, res, next) => {
    const registry = gatewayFactory.sharedBreakerRegistry;
    if (!registry) {
      // Gateway not yet initialised (e.g. mock mode without AI_PROVIDER_API_KEY)
      if (req.path === '/ai') {
        res.status(200).json({ providers: [] });
        return;
      }
      next();
      return;
    }
    createAiHealthRouter(registry)(req, res, next);
  });

  // Prometheus metrics. Mounted on the public surface deliberately —
  // production should rely on network-level allowlist (ingress / VPC).
  app.get('/metrics', async (_req, res) => {
    try {
      const { renderMetrics } = await import('./monitoring/metrics');
      const { contentType, body } = await renderMetrics();
      res.setHeader('Content-Type', contentType);
      res.send(body);
    } catch (err) {
      res.status(500).json({
        error: 'METRICS_RENDER_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Webhook routes — mounted before Clerk JWT middleware because webhooks
  // use their own signature verification (svix for Clerk, stripe-signature for Stripe).
  // The settings repo is constructed early so the Clerk webhook tenant
  // bootstrap can seed a default TenantSettings row alongside the new
  // tenant — closes the onboarding hole where a new operator would 500
  // on their first POST /api/estimates.
  // BUG-2 — when there's no pool, every consumer must share ONE
  // DevInMemoryTenantRepository instance, otherwise the public-intake
  // path and the dev-auth-bypass middleware end up with disjoint
  // tenant maps and customers created on one side don't resolve on
  // the other.
  const tenantRepo = pool
    ? new PgTenantRepository(pool)
    : new DevInMemoryTenantRepository();
  const webhookSettingsRepo = pool
    ? new PgSettingsRepository(pool)
    : new InMemorySettingsRepository();
  // Constructed early so the Stripe webhook handler can record payments.
  const webhookInvoiceRepo = pool ? new PgInvoiceRepository(pool) : new InMemoryInvoiceRepository();
  const webhookEstimateRepo = pool ? new PgEstimateRepository(pool) : new InMemoryEstimateRepository();
  const webhookPaymentRepo = pool ? new PgPaymentRepository(pool) : new InMemoryPaymentRepository();
  // Tier 4 (Deposit rules — PR 3b). Hoisted up so the Stripe webhook
  // and the rest of the app share a single instance — InMemory repos
  // are stateful, so two separate `new InMemoryJobRepository()` calls
  // would diverge in tests.
  const jobRepo            = pool ? new PgJobRepository(pool)            : new InMemoryJobRepository();
  // Tier 4 (Team members — PR 3). Same hoist for pending invitations
  // — the Clerk webhook reads them on user.created and the /api/users
  // routes write them. Single shared InMemory in tests.
  const pendingInvitationRepo = pool
    ? new PgPendingInvitationRepository(pool)
    : new InMemoryPendingInvitationRepository();
  // Tier 4 (Subscription — Fieldly billing). Hoisted up so the Stripe
  // webhook can update the cached subscription status when
  // customer.subscription.* events arrive. Single instance shared
  // with the /api/billing route. Requires both Pg pool + Stripe key
  // to instantiate — InMemory tests skip the subscription mirror
  // (the route surfaces 503 / null fields gracefully).
  const billingService = pool && process.env.STRIPE_SECRET_KEY
    ? new BillingService({
        pool,
        config: {
          apiKey: process.env.STRIPE_SECRET_KEY,
          portalConfigurationId: process.env.STRIPE_BILLING_PORTAL_CONFIGURATION,
        },
      })
    : undefined;
  // Tier 4 (Payment methods — PR 1). Stripe Connect onboarding for
  // the tenant's customer-facing payments. Same Stripe API key as
  // BillingService (Connect operations are first-party calls
  // authenticated with our platform secret), but a separate service
  // because the concerns are distinct.
  const connectService = pool && process.env.STRIPE_SECRET_KEY
    ? new StripeConnectService({
        pool,
        config: { apiKey: process.env.STRIPE_SECRET_KEY },
      })
    : undefined;
  // Queue constructed here (before webhook router) so new-tenant webhooks can
  // enqueue provisioning jobs synchronously during the request.
  const queue = pool ? new PgQueue(pool) : new InMemoryQueue();
  const webhookAuditRepo = pool ? new PgAuditRepository(pool) : new InMemoryAuditRepository();
  const webhookEventRepo = pool ? new PgWebhookEventRepository(pool) : new InMemoryWebhookEventRepository();

  // §7 Phase 1 — DNC repository + STOP/START keyword handler registration.
  // The inbound-SMS dispatcher routes any matching first-token to these
  // handlers, which mutate tenant_dnc_list. Suppression at outbound-send
  // time is layered on top in send-service / appointment-confirmation-notifier.
  const dncRepo = pool ? new PgDncRepository(pool) : new InMemoryDncRepository();
  registerKeywordHandler(buildStopKeywordHandler({ dncRepo }), { overwrite: true });
  registerKeywordHandler(buildStartKeywordHandler({ dncRepo }), { overwrite: true });

  // Resolves per-tenant integration credentials for inbound webhook signature
  // verification. Returns null when no row exists or the integration provider
  // doesn't match — recordTwilio / recordSendGrid then 403 with audit.
  const integrationResolver = pool
    ? async (tenantId: string, provider: 'twilio' | 'sendgrid') => {
        const { decrypt } = await import('./integrations/crypto');
        const { setTenantContext } = await import('./db/schema');
        const encKey = process.env.TENANT_ENCRYPTION_KEY;

        // tenant_integrations is FORCE RLS — must set app.current_tenant_id
        // GUC on a dedicated client/transaction. Webhook handlers run outside
        // withTenantTransaction so we open one here.
        const client = await pool.connect();
        let rows: Array<{
          subaccount_sid: string | null;
          auth_token_primary_enc: string | null;
          auth_token_secondary_enc: string | null;
          provider_data: Record<string, unknown>;
        }> = [];
        try {
          await client.query('BEGIN');
          await client.query(setTenantContext(tenantId));
          const result = await client.query<{
            subaccount_sid: string | null;
            auth_token_primary_enc: string | null;
            auth_token_secondary_enc: string | null;
            provider_data: Record<string, unknown>;
          }>(
            `SELECT subaccount_sid, auth_token_primary_enc, auth_token_secondary_enc, provider_data
             FROM tenant_integrations
             WHERE tenant_id = $1 AND provider = $2`,
            [tenantId, provider]
          );
          rows = result.rows;
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        const row = rows[0];
        if (!row) return null;
        // Decryption is only needed for Twilio auth tokens. SendGrid integrations
        // store a public verification key (not encrypted) in provider_data, so
        // the resolver shouldn't 403 valid SendGrid webhooks just because
        // TENANT_ENCRYPTION_KEY isn't configured.
        const canDecrypt = Boolean(encKey);
        if (provider === 'twilio' && !canDecrypt) return null;
        return {
          tenantId,
          provider,
          subaccountSid: row.subaccount_sid ?? undefined,
          authTokenPrimary: row.auth_token_primary_enc && canDecrypt
            ? decrypt(row.auth_token_primary_enc, encKey!)
            : undefined,
          authTokenSecondary: row.auth_token_secondary_enc && canDecrypt
            ? decrypt(row.auth_token_secondary_enc, encKey!)
            : undefined,
          sendgridPublicKeyPem: (row.provider_data?.sendgridPublicKeyPem as string | undefined),
        };
      }
    : undefined;

  const webhookRouterDeps: import('./webhooks/routes').WebhookRouterDeps = {
    tenantRepo,
    settingsRepo: webhookSettingsRepo,
    invoiceRepo: webhookInvoiceRepo,
    estimateRepo: webhookEstimateRepo,
    paymentRepo: webhookPaymentRepo,
    jobRepo,
    // Tier 4 (Team members — PR 3). Invitee join-tenant path on
    // user.created. The same shared pending invitation repo + pool
    // backs the /api/users invite routes so an invite written by
    // the route is found by the webhook on accept.
    pendingInvitationRepo,
    pool: pool ?? undefined,
    // Tier 4 (Subscription — PR 1). Same instance the route uses,
    // so a customer.subscription.* webhook updates the cached
    // status the GET /api/billing/subscription endpoint reads.
    // Wired only when both pool and STRIPE_SECRET_KEY exist.
    billingService,
    connectService,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    queue,
    appBaseUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:3000',
    auditRepo: webhookAuditRepo,
    webhookEventRepo,
    integrationResolver,
  };
  app.use('/webhooks', createWebhookRouter(config, webhookRouterDeps));

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
  // jobRepo is hoisted earlier so the Stripe webhook + everything else
  // share a single InMemory instance during tests.
  const timelineRepo       = pool ? new PgJobTimelineRepository(pool)    : new InMemoryJobTimelineRepository();
  const appointmentRepo    = pool ? new PgAppointmentRepository(pool)    : new InMemoryAppointmentRepository();
  const assignmentRepo     = pool ? new PgAssignmentRepository(pool)     : new InMemoryAssignmentRepository();
  // Availability repos and skill matcher have no Pg variants yet — the
  // dispatch feasibility composer treats missing rows as no-conflict, so
  // running InMemory in production is degraded-but-safe (working-hours and
  // unavailable-block warnings simply won't fire until Pg variants land).
  const workingHoursRepo       = new InMemoryWorkingHoursRepository();
  const unavailableBlockRepo   = new InMemoryUnavailableBlockRepository();
  const travelTimeProvider     = createTravelTimeProvider(process.env);
  const skillMatcher           = new StubSkillMatcher();
  const estimateRepo       = pool ? new PgEstimateRepository(pool)       : new InMemoryEstimateRepository();
  const invoiceRepo        = pool ? new PgInvoiceRepository(pool)        : new InMemoryInvoiceRepository();
  const paymentRepo        = pool ? new PgPaymentRepository(pool)        : new InMemoryPaymentRepository();
  const expenseRepo        = pool ? new PgExpenseRepository(pool)        : new InMemoryExpenseRepository();
  // P5-017: Resolve the payment-link provider via the factory so the mock
  // is hard-blocked in production. The factory throws at boot if
  // STRIPE_SECRET_KEY (or STRIPE_API_KEY) is missing while NODE_ENV=production,
  // and emits a loud dev-mode warning when the mock is used.
  const paymentLinkProvider = createPaymentLinkProvider(process.env);
  // Reference the variable so TS doesn't drop it; the provider will be
  // wired into routes/workers in a follow-up. The factory call itself is
  // load-bearing — it asserts the production guard at boot time.
  void paymentLinkProvider;
  const noteRepo           = pool ? new PgNoteRepository(pool)           : new InMemoryNoteRepository();
  const conversationRepo   = pool ? new PgConversationRepository(pool)   : new InMemoryConversationRepository();
  const settingsRepo       = pool ? new PgSettingsRepository(pool)       : new InMemorySettingsRepository();
  // PR B (Tier 4 / AI approval rules) — shared per-tenant
  // auto-approve threshold resolver. One cached instance for all
  // entry points (twilio adapter, inapp adapter, voice-action-router
  // worker) so settings hits the DB at most once per tenant per TTL
  // window across the whole process.
  const thresholdResolver = createThresholdResolver(settingsRepo);
  // B1 — per-tenant voice persona. 60-second LRU cache; shared by
  // both the Twilio and in-app adapters.
  const voicePersonaResolver = createVoicePersonaResolver(settingsRepo);
  const auditRepo          = webhookAuditRepo;
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
  const voiceSessionRepo   = pool ? new PgVoiceSessionRepository(pool)   : new InMemoryVoiceSessionRepository();
  const technicianLocationPingRepo = pool
    ? new PgTechnicianLocationPingRepository(pool)
    : new InMemoryTechnicianLocationPingRepository();
  const technicianLocationAuthorizer = pool
    ? new PgTechnicianLocationAuthorizer(pool)
    : new InMemoryTechnicianLocationAuthorizer();
  const approvalRepo       = pool ? new PgApprovalRepository(pool)       : new InMemoryApprovalRepository();
  const deltaRepo          = pool ? new PgEditDeltaRepository(pool)      : new InMemoryEditDeltaRepository();
  const packActivationRepo = pool ? new PgPackActivationRepository(pool) : new InMemoryPackActivationRepository();
  const trainingAssetRepo = pool
    ? new PgTrainingAssetRepository(pool)
    : new InMemoryTrainingAssetRepository();
  const privacyAuditRepo = pool
    ? new PgPrivacyAuditRepository(pool)
    : new InMemoryPrivacyAuditRepository();
  // Holder set later once the vertical prompt resolver is built (it
  // depends on canonicalPackRegistry, which is created further down).
  // Lifecycle mutations call this to drop the cached prompt section
  // for the affected tenant so admins see activate/archive without
  // waiting for the 5-minute TTL.
  let invalidateVerticalPromptCache: ((tenantId: string) => void) | null = null;
  // §3B/3D/3E — operator-side classifier paths (voice-action-router worker
  // and assistant chat router) are constructed BEFORE the vertical prompt
  // resolver itself, so we hand them a lazy holder that defers to the real
  // resolver once it's built (mirrors `invalidateVerticalPromptCache` above).
  // Operator paths don't have a customerId in scope, so they only need the
  // vertical resolver — the caller-plan resolver applies to inbound callers
  // (twilio/inapp adapters), not to operator-spoken commands.
  let operatorVerticalPromptResolver:
    | ((tenantId: string) => Promise<string | undefined>)
    | null = null;
  const operatorVerticalResolverShim = async (
    tenantId: string,
  ): Promise<string | undefined> => {
    return operatorVerticalPromptResolver
      ? operatorVerticalPromptResolver(tenantId)
      : undefined;
  };
  const trainingAssetService = new TrainingAssetService({
    assetRepo: trainingAssetRepo,
    privacyAuditRepo,
    auditRepo,
    redaction: new TrainingAssetRedactionService(),
    invalidatePromptCache: (tenantId) => invalidateVerticalPromptCache?.(tenantId),
  });
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
  const webhookEventRepo2   = webhookEventRepo;
  const timeEntryRepo      = pool ? new PgTimeEntryRepository(pool)       : new InMemoryTimeEntryRepository();
  // Reference the variable so TS doesn't drop it; downstream consumers will
  // attach in a follow-up PR.
  void webhookEventRepo2;

  const { provider: storageProvider, bucket: storageBucket } = createStorageProvider(
    process.env as NodeJS.ProcessEnv
  );

  const canonicalPackRegistry = pool
    ? new PgVerticalPackRegistry(pool)
    : new InMemoryCanonicalVerticalPackRegistry();
  seedCanonicalVerticalPacks(canonicalPackRegistry);

  // Synchronous transcription function — used by POST /api/voice/transcribe.
  const transcribeAudio = createTranscribeAudioFn(process.env.AI_PROVIDER_API_KEY);

  // URL-based provider for the queue worker pipeline.
  const transcriptionProvider = createWhisperTranscriptionProvider(process.env);
  // AI-run repository — tracks every LLM call lifecycle (pending → running → completed/failed).
  // Pg-backed in production; InMemory when DATABASE_URL is unset (dev/test).
  const aiRunRepo = pool ? new PgAiRunRepository(pool) : new InMemoryAiRunRepository();

  // P2-030 — shadow comparison store.
  // PgShadowComparisonStore when DATABASE_URL + SHADOW_LLM_ENABLED=true;
  // InMemoryShadowComparisonStore otherwise (zero overhead, data not durable).
  const shadowStore =
    pool && process.env.SHADOW_LLM_ENABLED === 'true'
      ? new PgShadowComparisonStore(pool)
      : new InMemoryShadowComparisonStore();

  // LLM gateway — single instance shared across intent classifier,
  // voice-action-router task handlers, and future AI features.
  // Falls back to a MockLLMProvider in dev/test so the app boots
  // without an AI_PROVIDER_API_KEY.
  const llmGateway = config.AI_PROVIDER_API_KEY
    ? createLLMGateway(config, { aiRunRepo, shadowStore })
    : createMockLLMGateway('{"intentType":"unknown","confidence":0}').gateway;

  // Phase 4a-1: dedicated EmbeddingProvider for the RAG corpus. The
  // gateway routes chat completions through shadow/router logic that
  // doesn't apply to embeddings (`text-embedding-3-small` only). When
  // AI_PROVIDER_API_KEY is unset, embeddings are unavailable and the
  // ingestion workers stay un-registered — the rest of the app boots.
  const embeddingProvider: EmbeddingProvider | null =
    createEmbeddingProvider(config);

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
      : config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging'
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
        dncRepo,
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
  // against real domain repositories. Invoice delivery routes through
  // SendService when configured; resolveInvoiceDeliveryProvider throws at
  // boot in prod/staging without credentials; dev/test uses Noop.
  const invoiceDeliveryProvider = resolveInvoiceDeliveryProvider({
    nodeEnv: config.NODE_ENV,
    sendService,
  });
  const estimateDeliveryProvider = resolveEstimateDeliveryProvider({
    nodeEnv: config.NODE_ENV,
    sendService,
  });
  const dispatchAnalyticsRepo = pool
    ? new PgDispatchAnalyticsRepository(pool)
    : new InMemoryDispatchAnalyticsRepository();
  const transactionalComms = messageDelivery
    ? new TransactionalCommsService({
        delivery: messageDelivery,
        appointmentRepo,
        jobRepo,
        customerRepo,
        settingsRepo,
        invoiceRepo,
        dispatchRepo,
        dncRepo,
      })
    : undefined;
  if (transactionalComms) {
    webhookRouterDeps.paymentReceiptNotifier = transactionalComms;
  }
  const feasibilityDeps: FeasibilityDependencies = {
    assignmentRepo,
    appointmentRepo,
    jobRepo,
    locationRepo,
    workingHoursRepo,
    unavailableBlockRepo,
    travelTimeProvider,
    skillMatcher,
  };
  // P7-026 — wire the review-response execution handler's three
  // optional deps so an approved review_response_proposal actually
  // mutates state instead of falling through the handler's "no dep
  // wired" guards. Hoisted ahead of the createExecutionHandlerRegistry
  // call (the polling worker, registered later, reuses these
  // instances).
  const googleReviewsReviewRepo = pool ? new PgReviewRepository(pool) : null;
  const googleReviewsPollStateRepo = pool
    ? new PgReviewPollStateRepository(pool)
    : null;
  const googleReviewsCredResolver = pool
    ? createCredentialResolver({ pool })
    : null;
  const serviceCreditRepo = pool ? new PgServiceCreditRepository(pool) : undefined;
  const googleReplyResolver =
    googleReviewsReviewRepo && googleReviewsCredResolver
      ? new PgGoogleBusinessReplyResolver(
          googleReviewsReviewRepo,
          googleReviewsCredResolver,
        )
      : undefined;
  const reviewPrivateMessageSender = messageDelivery
    ? new MessageDeliveryReviewPrivateMessageSender(
        messageDelivery,
        customerRepo,
      )
    : undefined;
  // Built ahead of the execution registry so the notify_delay handler can
  // send a real delay notice; reused by the delay-notification worker below.
  const delayNotificationService = messageDelivery
    ? new TwilioDelayNotificationService(messageDelivery, dispatchRepo)
    : new NoopDelayNotificationService();
  const executionHandlers = createExecutionHandlerRegistry({
    customerRepo,
    jobRepo,
    locationRepo,
    appointmentRepo,
    assignmentRepo,
    invoiceRepo,
    estimateRepo,
    settingsRepo,
    docRevisionRepo: documentRevisionRepo,
    editDeltaRepo: deltaRepo,
    noteRepo,
    paymentRepo,
    invoiceDeliveryProvider,
    estimateDeliveryProvider,
    analyticsRepo: dispatchAnalyticsRepo,
    schedulingNotifier: transactionalComms,
    transactionalComms,
    expenseRepo,
    auditRepo,
    feasibilityDeps,
    ...(serviceCreditRepo ? { serviceCreditRepo } : {}),
    ...(googleReplyResolver ? { googleReplyResolver } : {}),
    ...(reviewPrivateMessageSender ? { reviewPrivateMessageSender } : {}),
    // Full-app voice capability execution deps (convert_lead / mark_lead_lost,
    // log_time_entry, request_feedback, notify_delay). Without these the
    // respective handlers degrade to a validated passthrough.
    leadRepo,
    timeEntryService: new TimeEntryService(timeEntryRepo, auditRepo),
    feedbackRepo: feedbackRequestRepo,
    delayNotificationService,
  });
  // §11 H1: IdempotencyGuard + advisory lock per (tenant, key). Keys
  // default to `proposal-run:{tenant}:{id}` when callers omit one.
  const proposalIdempotencyLock = pool
    ? new PgIdempotencyLockProvider(pool)
    : new NoOpIdempotencyLockProvider();
  const proposalIdempotencyGuard = new IdempotencyGuard(
    proposalExecutionRepo,
    proposalRepo,
    proposalIdempotencyLock,
  );
  // Phase 4a-1: persist a proposal_executions row on success + fire the
  // proposal-correction-worker. The onExecuted callback is failure-soft
  // inside the executor itself (logs via console, never rethrows), so
  // queue-send errors here can't break the executor's invariants.
  const proposalExecutor = new ProposalExecutor(
    executionHandlers,
    proposalRepo,
    proposalIdempotencyGuard,
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
    service: delayNotificationService,
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
    thresholdResolver,
    appointmentRepo,
    // §3B/3D/3E — operator voice commands need the same vertical
    // terminology + intake-question disambiguation the customer-facing
    // adapters get. The shim is wired here because the real resolver
    // is built ~280 lines below; once `verticalPromptResolver` is
    // constructed, `operatorVerticalPromptResolver` is assigned and the
    // shim starts returning live data on the next classifier call.
    verticalPromptResolver: operatorVerticalResolverShim,
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
    dncRepo,
    publicBaseUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:5173',
  });
  workerRegistry.set(
    feedbackSendWorker.type,
    feedbackSendWorker as import('./queues/queue').WorkerHandler<unknown>
  );

  if (pool) {
    const provisionTwilioWorker = createProvisionTwilioWorker({ pool });
    workerRegistry.set(
      provisionTwilioWorker.type,
      provisionTwilioWorker as import('./queues/queue').WorkerHandler<unknown>
    );

    const deprovisionTenantWorker = createDeprovisionTenantWorker({ pool });
    workerRegistry.set(
      deprovisionTenantWorker.type,
      deprovisionTenantWorker as import('./queues/queue').WorkerHandler<unknown>
    );
  }

  if (pool && llmGateway) {
    const verifyAiWorker = createVerifyAiWorker({ pool, gateway: llmGateway, auditRepo });
    workerRegistry.set(
      verifyAiWorker.type,
      verifyAiWorker as import('./queues/queue').WorkerHandler<unknown>
    );
  }

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
  // D2-1d: auditRepo wired so the public feedback submission emits
  // `feedback_response.submitted` with the synthetic public:<tokenHash>
  // actor required by CLAUDE.md "all mutations emit audit events".
  app.use('/public/feedback', createPublicFeedbackRouter(feedbackRequestRepo, feedbackResponseRepo, settingsRepo, auditRepo));

  // Public lead intake — embedded marketing-page form posts here.
  // Tenant identified by UUID in the URL. The outer `/public` limiter
  // (30/min/IP, mounted above) catches abuse; the intake-specific
  // limiter below adds a tighter per-IP bucket because intake writes
  // to the database (vs the read-only token-gated public flows).
  // BUG-2 — share the single `tenantRepo` instance constructed at the
  // top of this module so intake-created customers and dashboard-
  // created customers resolve under the same tenant ID in dev.
  const intakeTenantRepo = tenantRepo;
  app.use(
    '/public/intake',
    rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    createPublicIntakeRouter(leadRepo, intakeTenantRepo, auditRepo, settingsRepo, canonicalPackRegistry, pool)
  );

  // Public unauthenticated estimate approval flow (token-authenticated).
  // STRIPE_SECRET_KEY is optional: deposit Stripe Payment Link minting
  // (PR 3b) returns ValidationError when not configured rather than
  // crashing — keeps the rest of the approval flow working in dev /
  // test environments without a Stripe key.
  const publicEstimateService = new PublicEstimateService({
    estimateRepo,
    jobRepo,
    customerRepo,
    locationRepo,
    settingsRepo,
    stripeConfig: process.env.STRIPE_SECRET_KEY
      ? { apiKey: process.env.STRIPE_SECRET_KEY }
      : null,
    // D2-1d: emit public_estimate.{approved,declined} with the
    // synthetic public:<tokenHash> actor on every public approve/decline.
    auditRepo,
  });
  app.use('/public/estimates', createPublicEstimatesRouter(publicEstimateService));

  // Public unauthenticated invoice payment flow (token-authenticated).
  // Stripe Payment Link creation is enabled when STRIPE_SECRET_KEY is set.
  // Tier 4 (Payment methods — PR 2). When the connectService is
  // wired AND the tenant has an active Connect account with charges
  // enabled, payments route directly to the tenant's account via
  // the Stripe-Account header. Without it, payments stay on the
  // legacy platform path.
  const publicInvoiceService = new PublicInvoiceService({
    invoiceRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
    stripeConfig: process.env.STRIPE_SECRET_KEY
      ? { apiKey: process.env.STRIPE_SECRET_KEY }
      : undefined,
    paymentRepo,
    // D2-1d: emit public_invoice.checkout_created on first link mint.
    // Subsequent idempotent calls (cached URL) DO NOT re-emit.
    auditRepo,
    connectAccountResolver: connectService
      ? {
          resolveTenantConnectAccount: async (tenantId: string) => {
            const view = await connectService.getAccount(tenantId);
            if (!view.accountId) return null;
            return {
              accountId: view.accountId,
              chargesEnabled: view.chargesEnabled,
            };
          },
        }
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
      assignmentRepo,
      locationRepo,
      proposalRepo,
      settingsRepo,
      transactionRunner: pool
        ? new PgTenantTransactionRunner(pool)
        : new InMemoryTransactionRunner(),
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

  // Tier 4 (Calendar sync — PR 1). Per-user Google OAuth callback.
  // The CALLBACK is mounted here (BEFORE the global /api requireAuth)
  // because Google's redirect back from the consent screen has no
  // Clerk session — the state nonce stored in oauth_states does the
  // auth binding instead. The connect / list / delete endpoints are
  // mounted later (after requireAuth) where they belong.
  //
  // Google client + secret are required for both initiating the
  // consent flow AND exchanging the callback code; without them the
  // /connect route returns ValidationError. Callback URL must match
  // the one registered in the Google Cloud OAuth console.
  const calendarIntegrationRepo = pool
    ? new PgCalendarIntegrationRepository(pool)
    : new InMemoryCalendarIntegrationRepository();
  const oauthStateRepo = pool
    ? new PgOAuthStateRepository(pool)
    : new InMemoryOAuthStateRepository();
  // Tier 4 (Calendar sync — PR 2). Sync service exposed on the
  // auth'd router as POST /google/test-push so operators can verify
  // their connection before relying on it for real appointments.
  const appointmentCalendarEventRepo = pool
    ? new PgAppointmentCalendarEventRepository(pool)
    : new InMemoryAppointmentCalendarEventRepository();
  const googleApiUrl =
    process.env.PUBLIC_API_URL ?? process.env.APP_PUBLIC_URL ?? 'http://localhost:3000';
  const googleConfig =
    process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET
      ? {
          clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
          redirectUri: `${googleApiUrl}/api/calendar-integrations/google/callback`,
        }
      : undefined;
  const calendarSyncService = new CalendarSyncService({
    integrationRepo: calendarIntegrationRepo,
    eventRepo: appointmentCalendarEventRepo,
    googleConfig,
  });
  const calendarRouterDeps = {
    integrationRepo: calendarIntegrationRepo,
    stateRepo: oauthStateRepo,
    googleConfig,
    syncService: calendarSyncService,
    // appBaseUrl is the FRONTEND URL we redirect the operator's
    // browser back to after OAuth completes. The API/callback URL is
    // separate (googleApiUrl). 5173 is the Vite dev default; matches
    // publicBaseUrl elsewhere in this file.
    appBaseUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:5173',
    // D2-1d: emit calendar_integration.{connected,disconnected,
    // callback_consumed} for the per-user Google OAuth lifecycle. The
    // callback uses `system:google-oauth-callback` because there is no
    // Clerk session in flight when Google redirects the browser back.
    auditRepo,
  };
  app.use(
    '/api/calendar-integrations',
    createCalendarOAuthCallbackRouter(calendarRouterDeps),
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
  // F6b: Process-local whisper TwiML cache. Shared between:
  //   - whisperRouter (serves TwiML to Twilio when dispatcher answers)
  //   - MediaStreamAdapter (stores whisper text after escalation_started)
  // Single-instance; multi-instance Railway deploys would need Redis.
  const sharedWhisperCache = new WhisperCache();
  // OnCall repo is created here so both the telephony adapter (notify_oncall
  // side effect) and the in-app adapter (escalation) share a single
  // implementation. The in-app block below reuses this same instance.
  const sharedOnCallRepo = pool ? new PgOnCallRepository(pool) : new InMemoryOnCallRepository();
  // §3B + §3D: shared vertical-prompt resolver injected into both
  // calling-agent adapters so per-tenant equipment terminology AND
  // intake-question disambiguation reach the classifier.
  const verticalPromptResolverLogger = createLogger({
    service: 'vertical-prompt-resolver',
    environment: process.env.NODE_ENV ?? 'development',
  });
  const verticalPromptResolver = buildVerticalPromptResolver({
    packActivationRepo,
    canonicalPackRegistry,
    trainingAssetRepo,
    logger: verticalPromptResolverLogger,
  });
  invalidateVerticalPromptCache = (tenantId) => verticalPromptResolver.invalidate(tenantId);
  // §3B/3D/3E — light up the operator-side resolver shim now that the
  // real resolver exists. The voice-action-router worker and assistant
  // router both pick it up on their next classifier call.
  operatorVerticalPromptResolver = verticalPromptResolver;
  // §3C: caller-plan resolver. Returns a prompt-shaped block when the
  // caller's customerId resolves to an active maintenance agreement.
  const callerPlanResolver = async (
    tenantId: string,
    customerId: string,
  ): Promise<string | undefined> => {
    const ctx = await buildCallerPlanContext(tenantId, customerId, agreementRepo);
    const section = formatCallerPlanForPrompt(ctx);
    return section.length > 0 ? section : undefined;
  };
  // §P2-3 — Build a shared in-memory map for rich pack fields (sttKeywords,
  // repairTemplates) that are NOT round-tripped through the canonical registry.
  // This is the same Map used by the streaming terminologyProvider; creating it
  // here ensures it is also available to the non-streaming twilio/inapp adapters.
  const sharedRichPackByType = new Map([
    ['hvac', createHvacPack()],
    ['plumbing', createPlumbingPack()],
    ['electrical', createElectricalPack()],
  ]);
  const repairTemplatesResolver = async (tenantId: string): Promise<ReadonlyArray<import('./verticals/registry').RepairTemplate>> => {
    const activations = await packActivationRepo.findByTenant(tenantId);
    const active = activations
      .filter((a) => a.status === 'active')
      .sort((a, b) => b.activatedAt.getTime() - a.activatedAt.getTime())[0];
    if (!active) return [];
    const base = active.packId.replace(/-v\d+$/, '');
    if (!isValidVerticalType(base)) return [];
    return sharedRichPackByType.get(base)?.repairTemplates ?? [];
  };
  const telephonyCallControl = new DefaultTwilioCallControl();
  // Owner-scoped revenue lookup (voice `lookup_revenue`) shares the same
  // money-dashboard repo the /api/reports router uses below.
  const moneyDashboardRepo = new PgMoneyDashboardRepository(
    invoiceRepo,
    paymentRepo,
    expenseRepo,
  );
  const twilioAdapter = new TwilioGatherAdapter({
    store: voiceSessionStore,
    gateway: llmGateway,
    ...(pool ? { pool } : {}),
    proposalRepo,
    auditRepo,
    onCallRepo: sharedOnCallRepo,
    callControl: telephonyCallControl,
    dispatcherPhoneResolver: createBusinessPhoneDispatcherResolver(settingsRepo),
    settingsRepo,
    whisperCache: sharedWhisperCache,
    ...(messageDelivery
      ? {
          deliveryProvider: {
            sendSms: (args: { to: string; body: string }) =>
              messageDelivery.sendSms({ to: args.to, body: args.body }),
          },
        }
      : {}),
    leadRepo,
    // P11-001: lookup-skill family wiring. Without these the adapter
    // falls back to a "let me get a person to help" line on lookup_*
    // intents — the call doesn't crash, but the read-only path is
    // unavailable. agreementRepo lives a few hundred lines down.
    jobRepo,
    appointmentRepo,
    invoiceRepo,
    agreementRepo,
    moneyDashboardRepo,
    catalogRepo,
    availabilityFinder,
    lookupEvents: lookupEventService,
    systemActorId: 'system:inbound-call',
    businessName: process.env.TWILIO_BUSINESS_NAME ?? 'our team',
    ...(process.env.PUBLIC_API_URL ? { publicBaseUrl: process.env.PUBLIC_API_URL } : {}),
    // P8-014: when set, the initial inbound TwiML emits a
    // <Start><Record recordingStatusCallback="..."/></Start> block so
    // Twilio asynchronously records the entire call and POSTs metadata
    // to /api/telephony/recording on completion.
    recordingCallbackPath: '/api/telephony/recording',
    verticalPromptResolver,
    callerPlanResolver,
    thresholdResolver,
    repairTemplatesResolver,
    voiceSessionRepo,
    voiceRepo,
    voicePersonaResolver,
    // §10 onboarding — fire the 30-minute upgrade nudge after every
    // inbound call ends. Pool-gated (no-op when running in-memory).
    ...(pool
      ? {
          onSessionEnded: async ({
            tenantId,
            channel,
          }: {
            tenantId: string;
            channel: 'voice_inbound' | 'inapp_voice';
          }) => {
            await checkAndFireUpgradeNudge({ pool }, tenantId);
            await maybeAutoGoLiveOnInboundEnd(
              { pool, auditRepo },
              { tenantId, channel },
            );
          },
        }
      : {}),
  });
  // P8-012: feature flag the Media Streams (live audio) path. Default
  // off — when off, the existing Gather adapter remains the only
  // telephony surface. When on, /voice returns a <Connect><Stream/>
  // TwiML and audio flows over the WebSocket attached below.
  const mediaStreamsEnabled = process.env.TWILIO_MEDIA_STREAMS_ENABLED === 'true';

  // Per-tenant Twilio token + tenant-id resolvers, keyed off
  // tenant_integrations. Falls back to the legacy single-account env
  // vars when no row matches — preserves the in-production single-tenant
  // flow while unblocking inbound calls on provisioned subaccounts.
  // Reads the table outside withTenantTransaction (FORCE RLS) using a
  // dedicated transaction with set_config('app.current_tenant_id', ...).
  // Both helpers issue cross-tenant lookups against tenant_integrations
  // (we don't know the tenant yet — that's what we're looking up).
  // Migration 074 added a permissive read policy gated on
  // app.system_lookup = 'true'. Set it via SET LOCAL inside a short
  // transaction; SET LOCAL drops on COMMIT and the connection returns
  // to the pool clean.
  const resolveTwilioAuthTokenForSubaccount = async (
    accountSid: string | undefined,
  ): Promise<string | undefined> => {
    if (!accountSid || !pool) return process.env.TWILIO_AUTH_TOKEN;
    const encKey = process.env.TENANT_ENCRYPTION_KEY;
    if (!encKey) return process.env.TWILIO_AUTH_TOKEN;
    try {
      const { decrypt } = await import('./integrations/crypto');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.system_lookup', 'true', true)");
        const result = await client.query<{ auth_token_primary_enc: string | null }>(
          `SELECT auth_token_primary_enc FROM tenant_integrations
           WHERE provider = 'twilio' AND subaccount_sid = $1
           LIMIT 1`,
          [accountSid],
        );
        await client.query('COMMIT');
        const enc = result.rows[0]?.auth_token_primary_enc;
        return enc ? decrypt(enc, encKey) : process.env.TWILIO_AUTH_TOKEN;
      } finally {
        client.release();
      }
    } catch {
      return process.env.TWILIO_AUTH_TOKEN;
    }
  };

  const resolveTenantIdByPhoneNumber = async (
    to: string,
  ): Promise<string | undefined> => {
    if (!to || !pool) return process.env.TWILIO_DEFAULT_TENANT_ID;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.system_lookup', 'true', true)");
        const result = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM tenant_integrations
           WHERE provider = 'twilio'
             AND provider_data->>'phoneE164' = $1
           LIMIT 1`,
          [to],
        );
        await client.query('COMMIT');
        return result.rows[0]?.tenant_id ?? process.env.TWILIO_DEFAULT_TENANT_ID;
      } finally {
        client.release();
      }
    } catch {
      return process.env.TWILIO_DEFAULT_TENANT_ID;
    }
  };

  // D2-3 — real phone-number → tenant lookup for inbound /voice. The
  // legacy `resolveTenantId` callback is still wired for `/gather` and
  // `/dial-result`, which already run inside an established call; the
  // /voice handler consults this repo first and only falls through to
  // the env-var seam in dev (with a loud WARN).
  const phoneNumberRepo = pool ? new PgPhoneNumberRepository(pool) : undefined;

  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: twilioAdapter,
      authTokenGetter: ({ accountSid }) => resolveTwilioAuthTokenForSubaccount(accountSid),
      publicBaseUrl: process.env.PUBLIC_API_URL,
      ...(phoneNumberRepo ? { phoneNumberRepo } : {}),
      resolveTenantId: ({ to }) => resolveTenantIdByPhoneNumber(to),
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
                        // B2: thread the typed CallOutcome into the worker
                        // payload so voice_recordings.outcome gets stamped
                        // alongside voice_sessions.outcome. Optional —
                        // the worker no-ops when undefined.
                        ...(session.terminalOutcome
                          ? { outcome: session.terminalOutcome }
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
      getHealth: () => {
        const ttsEnabled =
          !!process.env.ELEVENLABS_API_KEY || !!config.AI_PROVIDER_API_KEY;
        const sttEnabled = !!process.env.DEEPGRAM_API_KEY;
        const recordingEnabled =
          !!process.env.TWILIO_ACCOUNT_SID &&
          !!process.env.TWILIO_AUTH_TOKEN &&
          !!process.env.STORAGE_BUCKET;
        const messageDeliveryEnabled = !!sendService;
        const databaseEnabled = !!pool;
        const llmGatewayEnabled = !!config.AI_PROVIDER_API_KEY;
        const warnings: string[] = [];
        if (mediaStreamsEnabled && !sttEnabled) warnings.push('mediaStreams enabled but DEEPGRAM_API_KEY unset');
        if (mediaStreamsEnabled && !ttsEnabled) warnings.push('mediaStreams enabled but no TTS key (ELEVENLABS_API_KEY)');
        if (!process.env.PUBLIC_API_URL) warnings.push('PUBLIC_API_URL unset — Stream URL will be invalid');
        if (!process.env.TWILIO_BUSINESS_NAME) warnings.push("TWILIO_BUSINESS_NAME unset — greeting says 'our team'");
        if (!databaseEnabled) warnings.push('DATABASE_URL unset — proposals/outcomes will not persist');
        if (!recordingEnabled) warnings.push('Recording disabled — STORAGE_* or TWILIO_* missing');
        if (!messageDeliveryEnabled) warnings.push('send_invoice disabled — TWILIO_FROM_NUMBER / SENDGRID_* missing');
        const ok =
          (!mediaStreamsEnabled || (sttEnabled && ttsEnabled)) &&
          databaseEnabled &&
          llmGatewayEnabled;
        return {
          ok,
          capabilities: {
            mediaStreams: mediaStreamsEnabled,
            tts: ttsEnabled,
            stt: sttEnabled,
            recording: recordingEnabled,
            messageDelivery: messageDeliveryEnabled,
            database: databaseEnabled,
            llmGateway: llmGatewayEnabled,
          },
          config: {
            publicBaseUrl: process.env.PUBLIC_API_URL ?? null,
            businessName: process.env.TWILIO_BUSINESS_NAME ?? null,
          },
          warnings,
        };
      },
      // §10 onboarding voice gates — only wired when both pool and auditRepo
      // exist (production / integration test). In-memory dev mode skips
      // gating entirely (the route stays legacy behavior).
      ...(pool && auditRepo
        ? { voiceGate: createVoiceGate({ pool, auditRepo }) }
        : {}),
      ...(pool ? { pool } : {}),
      settingsRepo,
      leadRepo,
      auditRepo,
      businessName: process.env.TWILIO_BUSINESS_NAME ?? 'our team',
    }),
  );

  // F6b: Whisper TwiML route — mounted BEFORE requireAuth so Twilio's
  // signed GETs (no Clerk session) are accepted. Path is under
  // /api/telephony so it's co-located with the main telephony webhook.
  // Twilio signature verification is enforced to prevent unauthenticated
  // access to whisper TwiML (which contains PII: caller name, phone, intent).
  app.use(
    '/api/telephony',
    requireTwilioSignature(
      ({ accountSid }) => resolveTwilioAuthTokenForSubaccount(accountSid),
      { publicBaseUrl: () => process.env.PUBLIC_API_URL },
    ),
    whisperRouter({ whisperCache: sharedWhisperCache }),
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
      // Reuse sharedRichPackByType (already built above for repairTemplatesResolver)
      // so sttKeywords + repairTemplates come from the same in-memory pack instances.
      const terminologyProvider = new VerticalTerminologyProvider({
        repo: {
          findByType: async (type) => sharedRichPackByType.get(type) ?? null,
        },
        lookupVertical: async (tenantId: string) => {
          const activations = await packActivationRepo.findByTenant(tenantId);
          const active = activations
            .filter((a) => a.status === 'active')
            .sort((a, b) => b.activatedAt.getTime() - a.activatedAt.getTime())[0];
          if (!active) return null;
          // Activation packId is conventionally the verticalType ('hvac',
          // 'plumbing', 'electrical') or a versioned packId like 'hvac-v1'.
          // Strip the suffix and validate.
          const packId = active.packId;
          const base = packId.replace(/-v\d+$/, '');
          if (!isValidVerticalType(base)) {
            verticalPromptResolverLogger.debug('vertical lookup returned null', {
              tenantId,
              packId,
              derivedBase: base,
              reason: 'invalid_vertical_type',
            });
            return null;
          }
          return base;
        },
      });

      // P2-1: Filler engine + cache. One engine instance is shared across
      // calls. Cross-call state sharing means the no-repeat guarantee is
      // process-wide, not per-call — acceptable because callers can't hear
      // each other's audio, and round-robin over 8 fillers means no caller
      // hears the same filler back-to-back regardless. The cache loads all
      // PCM files from disk once at boot; missing files are logged (warn).
      const fillerCache = new FillerAudioCache(
        require('path').resolve(__dirname, 'ai/agents/customer-calling/fillers'),
      );
      fillerCache.load();
      const fillerEngine = new FillerEngine();

      // F6c — wire LLM-backed sentiment classifier into the MediaStream adapter.
      // The adapter calls this after each caller turn (fire-and-forget); if the
      // frustration score exceeds the per-tenant threshold it dispatches
      // `frustration_detected` back into the FSM out-of-band.
      //
      // The sentiment function expects `deps.llm.complete({ prompt })` returning
      // `{ text }`. We adapt the LLM gateway (which uses messages arrays) into
      // that interface here using the `call_sentiment` task type so routing
      // config can target it separately from main call-flow completions.
      //
      // escalationSettings is per-tenant and resolved per-session: the
      // `resolveEscalationSettings` resolver (passed into attachMediaStreamServer
      // below) reads the tenant's current settings at session start, so the
      // static `escalationSettings` dep is intentionally left unset.
      const sentimentClassifierDep = llmGateway
        ? (
            input: Parameters<typeof classifyTurnSentiment>[0],
            budget?: Partial<Parameters<typeof classifyTurnSentiment>[1]>,
          ) =>
            classifyTurnSentiment(input, {
              llm: {
                complete: async ({ prompt }: { prompt: string }) => {
                  const res = await llmGateway.complete({
                    taskType: 'call_sentiment',
                    messages: [{ role: 'user' as const, content: prompt }],
                  });
                  return { text: res.content };
                },
              },
              // Per-session cost-cap inputs threaded in by the adapter so the
              // classifier's budget guard can skip the LLM call when the session
              // is near its cost cap.
              ...budget,
            })
        : undefined;

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
            terminologyProvider,
            fillerEngine,
            fillerCache,
            speechTurn: async ({ session, speechResult, callSid, tenantId }) =>
              twilioAdapter.processCallerUtterance({
                sessionId: session.id,
                callSid,
                speechResult,
                tenantId,
              }),
            // B2: delegate outcome stamping to the gather adapter so all
            // close paths (caller hangup, idle timeout, end_session, WS
            // teardown, slow-consumer disconnect) stamp the same typed
            // CallOutcome onto voice_sessions. Forward the FSM
            // sideEffects so the actual `end_session.payload.reason`
            // (e.g. 'abuse_detected:profanity') reaches deriveCallOutcome
            // for non-hangup terminations.
            finalizeOnClose: (session, reason, sideEffects) =>
              twilioAdapter.finalizeTerminatedSession(session, sideEffects, reason),
            // WS upgrades don't carry AccountSid; fall back to the master
            // token. Per-tenant subaccount auth for media streams is a
            // future-phase change (auth at first `start` message).
            authTokenGetter: () => process.env.TWILIO_AUTH_TOKEN,
            ...(process.env.PUBLIC_API_URL ? { publicBaseUrl: process.env.PUBLIC_API_URL } : {}),
            // Section 7 (CRITICAL): wire the gather adapter's shared Map so
            // Dial TwiML built inside handleEscalateWithContext is visible to
            // the route layer via takePendingTransferTwiml(sessionId). Without
            // this the caller stays on hold forever — the dispatcher gets SMS
            // but the call never bridges.
            setPendingTransferTwiml: twilioAdapter.setPendingTransferTwiml.bind(twilioAdapter),
            // F6b: Wire the shared whisper cache so the MediaStream adapter
            // stores whisper TwiML after handleEscalateWithContext runs.
            whisperCache: sharedWhisperCache,
            // F6c: LLM-backed sentiment classifier. Only fires when
            // escalationSettings.trigger_llm_sentiment is true.
            ...(sentimentClassifierDep ? { sentimentClassifier: sentimentClassifierDep } : {}),
            // F6c (per-tenant): resolve escalation settings at WS session start
            // so CallRoutingSheet toggle changes take effect on the next call.
            resolveEscalationSettings: async (tenantId: string) => {
              const settings = await settingsRepo.findByTenant(tenantId);
              return resolveEscalationSettings(settings);
            },
            // F6c: deliver out-of-band frustration_detected effects (notify_oncall,
            // audit) through the host processor — emitSideEffects only renders TTS.
            deliverEscalationEffects: (session, effects, tenantId) =>
              twilioAdapter.deliverOutOfBandEffects(session, effects, tenantId),
          },
        );
        return server;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
    }
  }

  // Client WebSocket gateway (subsumes SSE token streams for assistant
  // chat + voice events, behind feature flags). Gated by
  // CLIENT_WS_GATEWAY_ENABLED so production stays SSE-only until ramp.
  const clientWsEnabled = process.env.CLIENT_WS_GATEWAY_ENABLED === 'true';
  if (clientWsEnabled) {
    const origListen = app.listen.bind(app);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.listen = ((...args: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = (origListen as any)(...args);
      attachClientGateway(server, {
        // Runtime kill switch: consult the persisted feature flag on
        // every upgrade so flipping ws.client_gateway_enabled off
        // immediately disables /api/ws without redeploy. The env-var
        // gate above only controls whether the upgrade handler is
        // attached at boot; this controls per-request acceptance.
        isEnabled: () =>
          isFeatureEnabled(
            featureFlagStore,
            RESILIENCE_FLAG_NAMES.clientGatewayEnabled,
            { environment: process.env.NODE_ENV ?? 'development' },
          ),
        auth: {
          authenticate: async (req) => {
            // Token via Authorization header (rare for WS), Sec-WebSocket-Protocol,
            // or ?token=...
            const authHeader = req.headers.authorization;
            const proto = (req.headers['sec-websocket-protocol'] as string | undefined) ?? '';
            const url = new URL(req.url ?? '/', 'http://localhost');
            const queryToken = url.searchParams.get('token') ?? undefined;
            const headerToken =
              authHeader && authHeader.startsWith('Bearer ')
                ? authHeader.substring(7)
                : undefined;
            const protoToken = proto
              .split(',')
              .map((s) => s.trim())
              .find((s) => s.startsWith('bearer.'))
              ?.substring('bearer.'.length);
            const token = headerToken || queryToken || protoToken;
            if (!token) return null;

            try {
              const isHmacDev =
                process.env.NODE_ENV !== 'production' &&
                process.env.NODE_ENV !== 'prod' &&
                process.env.CLERK_DEV_HMAC_TOKENS === 'true';
              const payload = isHmacDev
                ? decodeClerkToken(token, process.env.CLERK_SECRET_KEY ?? '')
                : await verifyRs256Token(token, {
                    pubKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
                  });
              if (!payload?.tenant_id) return null;
              return {
                tenantId: payload.tenant_id,
                userId: payload.sub,
              };
            } catch {
              return null;
            }
          },
        },
      });
      return server;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
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
    // BUG-2 — share the single tenantRepo constructed at the top of
    // this module. Previously this branch instantiated its own
    // DevInMemoryTenantRepository, leaving the dev-bypass and intake
    // paths with disjoint tenant maps.
    app.use('/api', devAuthBypass({ tenantRepo }));
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
    // D2-1d: portal tokens are bearer credentials; both mint and
    // revoke emit portal_session.{created,revoked} via auditRepo.
    createPortalRouter({ portalRepo: portalSessionRepo, customerRepo, auditRepo }),
  );
  app.use('/api/leads', createLeadsRouter(leadRepo, customerRepo, auditRepo));
  app.use('/api/locations', createLocationRouter(locationRepo, ownership, auditRepo));
  app.use('/api/jobs', createJobRouter(jobRepo, timelineRepo, auditRepo, ownership, queue, feedbackDispatcher, customerRepo, locationRepo));
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
    }, auditRepo)
  );
  app.use(
    '/api/dispatch',
    createDispatchRoutes({
      appointmentRepo,
      assignmentRepo,
      jobRepo,
      customerRepo,
      locationRepo,
      enRouteCoordinator: delayNotificationCoordinator,
      proposalRepo,
      boardEventsDeps: {
        authUserIdFromRequest: async (req) =>
          (req as { auth?: { userId?: string } }).auth?.userId ?? null,
        authTenantIdFromRequest: async (req) =>
          (req as { auth?: { tenantId?: string } }).auth?.tenantId ?? null,
      },
    }),
  );
  app.use(
    '/api/estimates',
    createEstimateRouter(
      estimateRepo,
      settingsRepo,
      auditRepo,
      ownership,
      sendService,
      { gateway: llmGateway, proposalRepo },
      { jobRepo, invoiceRepo },
      { docRevisionRepo: documentRevisionRepo, editDeltaRepo: deltaRepo },
      paymentRepo,
    ),
  );
  app.use(
    '/api/invoices',
    createInvoiceRouter(
      invoiceRepo,
      settingsRepo,
      auditRepo,
      ownership,
      paymentRepo,
      sendService,
      jobRepo,
      estimateRepo,
      paymentLinkProvider,
    ),
  );

  // Tier 4 (Team members — PR 1+2+3). User roster, role editing, and
  // invitation flow. Tenant scoping is enforced by the route's
  // requireTenant + the repo's tenant context. Clerk integration is
  // best-effort: missing CLERK_SECRET_KEY just persists the local
  // intent; the operator can still re-send via dashboard and the
  // webhook still attaches the invitee on accept (lookup is by email).
  const userRepo = pool ? new PgUserRepository(pool) : new InMemoryUserRepository();
  app.use(
    '/api/users',
    createUsersRouter(
      userRepo,
      {
        // Same instance the Clerk webhook reads on user.created — the
        // accept side reads what the invite side wrote.
        pendingInvitationRepo,
        clerkSecretKey: process.env.CLERK_SECRET_KEY,
        appBaseUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:3000',
      },
      // D2-1c — audit-log user role / name edits + invitations.
      auditRepo,
    ),
  );

  // Tier 4 (Calendar sync — PR 1). Auth'd lifecycle endpoints.
  // The OAuth callback was mounted earlier (before global
  // requireAuth) on the same prefix; Express dispatches by method+path
  // so the two registrations don't conflict.
  app.use(
    '/api/calendar-integrations',
    createCalendarIntegrationsRouter(calendarRouterDeps),
  );

  // billingService is hoisted earlier so the Stripe webhook can use
  // the same instance.
  app.use('/api/billing', createBillingRouter({ billingService, connectService, auditRepo }));

  // Tenant-scoped reporting (revenue by lead source / UTM, money dashboard, tax export).
  const revenueBySourceRepo = pool
    ? new PgRevenueBySourceRepository(pool)
    : new InMemoryRevenueBySourceRepository();
  const timeGivenBackReporter = new RepoBackedTimeGivenBackReporter(
    proposalRepo,
    settingsRepo,
    voiceSessionRepo,
  );
  app.use(
    '/api/reports',
    createReportsRouter({
      revenueBySourceRepo,
      moneyDashboardRepo,
      expenseRepo,
      invoiceRepo,
      paymentRepo,
      timeGivenBackReporter,
    }),
  );
  app.use(
    '/api/payments',
    createPaymentRouter(
      paymentRepo,
      invoiceRepo,
      jobRepo,
      estimateRepo,
      auditRepo,
      transactionalComms,
    ),
  );
  app.use('/api/notes', createNoteRouter(noteRepo, ownership, auditRepo));

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
        async getTenantIntegrationStatuses(tenantId) {
          const r = await pool.query(
            `SELECT provider, status, updated_at
             FROM tenant_integrations
             WHERE tenant_id = $1`,
            [tenantId],
          );
          return r.rows.map((row) => ({
            provider: String(row.provider),
            status: String(row.status) as TenantIntegrationStatus,
            updated_at: row.updated_at ? new Date(String(row.updated_at)) : null,
          }));
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
  app.use('/api/conversations', createConversationRouter(conversationRepo, auditRepo));

  app.use(
    '/api/settings',
    createSettingsRouter(
      settingsRepo,
      {
        activationRepo: packActivationRepo,
        verticalPackRegistry: canonicalPackRegistry,
      },
      // D2-1c — audit-log tenant-settings + language mutations.
      auditRepo,
    ),
  );
  app.use('/api/settings/packs', createPackActivationRouter(packActivationRepo, canonicalPackRegistry, auditRepo));
  app.use('/api/verticals', createVerticalRouter(canonicalPackRegistry));
  app.use('/api/vertical-training-assets', createVerticalTrainingAssetsRouter(trainingAssetService));
  app.use('/api/templates', createTemplateRouter(templateRepo, auditRepo));
  app.use('/api/bundles', createBundleRouter(bundleRepo, auditRepo));
  app.use('/api/quality', createQualityRouter({ metricsRepo: qualityMetricsRepo, approvalRepo, deltaRepo }));

  // P2-030 — AI evaluation admin API (owner-only; tenant-scoped).
  app.use('/api/evaluation', createEvaluationRouter({ shadowStore }));

  const voiceLogger = createLogger({
    service: 'voice',
    environment: process.env.NODE_ENV || 'development',
    level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  });
  app.use(
    '/api/voice',
    createVoiceRouter(voiceRepo, queue, transcribeAudio, auditRepo, voiceLogger, pool ? { pool } : undefined),
  );
  app.use('/api/onboarding', createOnboardingRouter({ settingsRepo, packActivationRepo, auditRepo, pool, billingService, queue }));
  app.use(
    '/api/technician-location',
    createTechnicianLocationRouter({
      repository: technicianLocationPingRepo,
      canSubmitForTechnician: (auth, technicianId) =>
        technicianLocationAuthorizer.canSubmitForTechnician(auth, technicianId),
    })
  );
  app.use('/api/catalog/items', createCatalogItemsRouter(catalogRepo, auditRepo));
  app.use(
    '/api/files',
    createFilesRouter({ fileRepo, storage: storageProvider, bucket: storageBucket, auditRepo })
  );
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway: llmGateway,
      proposalRepo,
      // §3B/3D/3E — assistant chat shares the operator-side resolver
      // shim with the voice-action-router so the same vertical context
      // reaches both text and voice classification paths.
      verticalPromptResolver: operatorVerticalResolverShim,
    }),
  );
  // D2-1c — audit-log proposal approve / reject / edit / undo.
  app.use('/api/dispatch', createSchedulingRouter(feasibilityDeps, userRepo));
  app.use('/api/proposals', createProposalsRouter(proposalRepo, appointmentRepo, auditRepo, feasibilityDeps));
  if (pool) {
    app.use('/api/interactions', createInteractionsRouter({ pool }));
  }

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

  // BUG-6 — backs the Contracts page (`MaintenanceContractsPage`,
  // `ContractDetailPage`, `CreateContractSheet`). Distinct surface
  // from /api/agreements; in-memory only.
  app.use('/api/maintenance-contracts', createMaintenanceContractsRouter(auditRepo));

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

  // §6 Time-to-Cash: overdue-invoice sweep. Hourly — invoice due dates
  // have day granularity, so an hourly check surfaces newly-overdue
  // invoices promptly without churn. Same setInterval driver + tenant
  // lister pattern as the recurring-agreements sweep above; in-memory
  // dev returns no tenants so it no-ops locally.
  const overdueInvoiceLogger = createLogger({
    service: 'overdue-invoice-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  setInterval(async () => {
    try {
      await runOverdueInvoiceSweep({
        jobRepo,
        estimateRepo,
        invoiceRepo,
        auditRepo,
        transactionalComms,
        listTenantIds: async () => {
          if (!pool) return [];
          const r = await pool.query('SELECT id FROM tenants');
          return r.rows.map((row: { id: string }) => row.id);
        },
        logger: overdueInvoiceLogger,
      });
    } catch (err) {
      overdueInvoiceLogger.error('Overdue-invoice sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 60 * 60_000);

  const appointmentReminderLogger = createLogger({
    service: 'appointment-reminder-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (transactionalComms) {
    setInterval(async () => {
      try {
        await runAppointmentReminderSweep({
          appointmentRepo,
          transactionalComms,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          logger: appointmentReminderLogger,
        });
      } catch (err) {
        appointmentReminderLogger.error('Appointment-reminder sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 60 * 60_000);
  }

  // Estimate-reminder worker — nudges customers on estimates sent but
  // unviewed/unaccepted after 3 days (1 reminder, capped). Only runs when
  // SendService is configured (it re-sends via the unified send path).
  const estimateReminderLogger = createLogger({
    service: 'estimate-reminder-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (sendService) {
    setInterval(async () => {
      try {
        await runEstimateReminderSweep({
          estimateRepo,
          sendService,
          auditRepo,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          logger: estimateReminderLogger,
        });
      } catch (err) {
        estimateReminderLogger.error('Estimate-reminder sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 60 * 60_000);
  }

  // Estimate-expiry worker — transitions sent estimates past their
  // valid_until date to 'expired' so stale quotes can't be accepted and
  // the pipeline reflects lapsed offers. Runs hourly; no SendService
  // dependency (it only changes status).
  const estimateExpiryLogger = createLogger({
    service: 'estimate-expiry-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  setInterval(async () => {
    try {
      await runEstimateExpirySweep({
        estimateRepo,
        auditRepo,
        moneyStateDeps: { jobRepo, estimateRepo, invoiceRepo, auditRepo, logger: estimateExpiryLogger },
        listTenantIds: async () => {
          if (!pool) return [];
          const r = await pool.query('SELECT id FROM tenants');
          return r.rows.map((row: { id: string }) => row.id);
        },
        logger: estimateExpiryLogger,
      });
    } catch (err) {
      estimateExpiryLogger.error('Estimate-expiry sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 60 * 60_000);

  // P7-026 PR a: Google Business reviews polling. Every 15 minutes
  // we sweep every tenant with an active `google_business`
  // integration and persist new reviews idempotently. One tenant's
  // failure never stops the loop (per-tenant try/catch inside the
  // sweep). Per-tenant exponential backoff on 429 lives in
  // review_poll_state; tenants currently throttled are skipped
  // entirely until the window lifts.
  //
  // When `pool` is unset (in-memory dev), the sweep no-ops cleanly:
  // the worker short-circuits on a null credential resolver and
  // returns all-zero metrics.
  const googleReviewsLogger = createLogger({
    service: 'google-reviews-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  // P7-026 final wiring — ingestion → proposal bridge. When all the
  // build-proposal deps are available (LLM gateway + customer loader +
  // brand voice + service-credit repo), newly-inserted reviews
  // immediately produce a draft review_response_proposal. When any are
  // missing, we log a one-shot warning so ops can see "ingestion only,
  // no proposals being created" without grepping the per-tick logs.
  const googleReviewsCustomerLoader = pool ? new PgCustomerLoader(pool) : null;
  const googleReviewsBrandVoiceLoader = new NoopBrandVoiceLoader();
  const googleReviewsProposalEmission =
    serviceCreditRepo && googleReviewsCustomerLoader
      ? {
          proposalRepo,
          buildProposalDeps: {
            llmGateway,
            customerLoader: googleReviewsCustomerLoader,
            brandVoiceLoader: googleReviewsBrandVoiceLoader,
            serviceCreditRepo,
          },
        }
      : undefined;
  if (!googleReviewsProposalEmission) {
    googleReviewsLogger.warn(
      'Google reviews worker: proposal emission deps incomplete — ' +
        'ingestion will run but no review_response_proposal drafts will be created',
      {
        hasServiceCreditRepo: Boolean(serviceCreditRepo),
        hasCustomerLoader: Boolean(googleReviewsCustomerLoader),
      },
    );
  }
  setInterval(async () => {
    if (
      !googleReviewsReviewRepo ||
      !googleReviewsPollStateRepo ||
      !googleReviewsCredResolver
    ) {
      return;
    }
    try {
      await runGoogleReviewsSweep({
        reviewRepo: googleReviewsReviewRepo,
        pollStateRepo: googleReviewsPollStateRepo,
        credentialResolver: googleReviewsCredResolver,
        listTenantIds: async () => {
          if (!pool) return [];
          const r = await pool.query('SELECT id FROM tenants');
          return r.rows.map((row: { id: string }) => row.id);
        },
        logger: googleReviewsLogger,
        ...(googleReviewsProposalEmission
          ? { proposalEmission: googleReviewsProposalEmission }
          : {}),
      });
    } catch (err) {
      googleReviewsLogger.error('Google reviews sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 15 * 60_000);

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
    verticalPromptResolver,
    callerPlanResolver,
    thresholdResolver,
    repairTemplatesResolver,
    voiceSessionRepo,
    voicePersonaResolver,
  });
  app.use(
    '/api/voice/sessions',
    createVoiceSessionsRouter({ adapter: inAppVoiceAdapter, store: voiceSessionStore })
  );

  // ── F5: Escalation outcome + SSE events routes ────────────────────────────
  // escalationOutcomeRouter: user-facing POST /api/escalations/:id/outcome.
  // escalationEventsRouter:  user-facing GET  /api/escalations/events (SSE).
  // Both sit behind /api so they inherit the requireAuth gate above.
  app.use(
    '/api/escalations',
    escalationOutcomeRouter({ store: voiceSessionStore }),
  );
  app.use(
    '/api/escalations',
    escalationEventsRouter({
      authUserIdFromRequest: async (req) => {
        return (req as unknown as { auth?: { userId?: string } }).auth?.userId ?? null;
      },
      authTenantIdFromRequest: async (req) => {
        return (req as unknown as { auth?: { tenantId?: string } }).auth?.tenantId ?? null;
      },
      subscribeToVoiceEvents: (cb) => voiceSessionStore.subscribeGlobal(cb),
    }),
  );

  const featureFlagRepo: FeatureFlagRepository = pool
    ? new PgFeatureFlagRepository(pool)
    : new InMemoryFeatureFlagRepository();
  const featureFlagStore = new InMemoryFeatureFlagStore();
  // Hydration is fire-and-forget on boot — the store starts empty and is
  // refilled from the repo asynchronously. isFeatureEnabled returns false
  // for missing flags, so the worst case during the hydration window is
  // that a flag reads as disabled for a few ms.
  void (async () => {
    const { seedResilienceFlags } = await import('./flags/resilience-flags');
    try {
      await seedResilienceFlags(featureFlagRepo);
    } catch {
      /* fire-and-forget — admin flags surface via the admin API */
    }
    await hydrateStoreFromRepository(featureFlagStore, featureFlagRepo);
  })();
  // D2-1c — audit-log platform-admin feature-flag upsert / delete.
  app.use(
    '/api/admin/feature-flags',
    createFeatureFlagsRouter(featureFlagRepo, featureFlagStore, {}, auditRepo),
  );

  // Platform-admin tenant lifecycle (hard-delete / deprovision). Requires a
  // DB pool; the queue is always present (Pg- or in-memory).
  if (pool) {
    app.use('/api/admin/tenants', createAdminTenantsRouter({ pool, queue }));
  }

  // Wire the WS publish-side kill switches: every call to publish()
  // consults the feature flag store at runtime, so flipping
  // ws.assistant_stream_enabled / ws.voice_events_enabled off
  // immediately stops mirroring without redeploy.
  const wsEnv = process.env.NODE_ENV ?? 'development';
  setChannelGate((channel, tenantId) => {
    const flag =
      channel === 'assistant'
        ? RESILIENCE_FLAG_NAMES.assistantStreamEnabled
        : RESILIENCE_FLAG_NAMES.voiceEventsEnabled;
    return isFeatureEnabled(featureFlagStore, flag, {
      environment: wsEnv,
      tenantId,
    });
  });

  app.use(captureRequestError());

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  });

  // Catch-all route for client-side routing — serves index.html for all non-API routes
  // This allows the React SPA to handle routing on the client side
  app.get('*', (req, res) => {
    const frontendPath = require('path').join(__dirname, '../../web/dist');
    const indexPath = require('path').join(frontendPath, 'index.html');
    res.sendFile(indexPath);
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
      // Disconnect Redis cache store(s) before draining the DB pool so Railway
      // shutdown is not slowed by lingering Redis connections.
      await shutdownCacheStores();
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
