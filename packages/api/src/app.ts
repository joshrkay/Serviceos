import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createRateLimitStore } from './middleware/rate-limit-store';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './swagger/spec';
import { createHealthRouter, HealthCheck } from './health/health';
import { toErrorResponse } from './shared/errors';
import { createPool, createDirectPool } from './db/pool';
import { verifyRlsRuntimeRole } from './db/rls-runtime-role';
import { loadConfig, resolveMediaStreamsEnabled } from './shared/config';
import { resolveWebDistDir } from './web-static-path';
import { registerMarketingRedirects } from './marketing-redirects';
import { createWebhookRouter } from './webhooks/routes';
import { createIntegrationResolver, createVapiSecretResolver } from './webhooks/integration-resolver';
import { createTelephonyRouter } from './routes/telephony';
import { createCallsRouter, createCallBridgeRouter } from './routes/calls';
import { TwilioGatherAdapter } from './telephony/twilio-adapter';
import {
  createEmergencyPageWorker,
  createEmergencyPageResolvedCheck,
} from './telephony/emergency-page-retry';
import { DefaultTwilioCallControl } from './telephony/twilio-call-control';
import { createUserPhoneDispatcherResolver, createBusinessPhoneFallback } from './telephony/dispatcher-phone-resolver';
import { PgPhoneNumberRepository } from './integrations/twilio/phone-number-repository';
import { attachMediaStreamServer } from './telephony/media-streams';
import { createTwilioCallRedirector } from './telephony/twilio-call-redirect';
import { RealtimeHealthCircuit } from './telephony/realtime-health-circuit';
import { attachClientGateway, setChannelGate } from './ws/client-gateway';
import { setDraining, isDraining as isDrainingFlag } from './ws/drain-state';
import { createConnectionRegistry } from './ws/connection-registry';
import {
  decodeClerkToken,
  verifyRs256Token, type AuthenticatedRequest } from './auth/clerk';
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
  createIntegrationsRouter,
  createIntegrationsOAuthCallbackRouter,
} from './routes/integrations';
import {
  PgAccountingIntegrationRepository,
  PgAccountingSyncLogRepository,
  PgAccountingOAuthStateRepository,
  InMemoryAccountingIntegrationRepository,
  InMemoryAccountingSyncLogRepository,
  InMemoryAccountingOAuthStateRepository,
} from './integrations/accounting/repository';
import { resolveQuickBooksOAuthConfig } from './integrations/accounting/quickbooks-oauth';
import {
  runAccountingSyncSweep,
  ACCOUNTING_SYNC_INTERVAL_MS,
} from './workers/accounting-sync-worker';
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
import { createTerminalRouter } from './routes/terminal';
import { createNoteRouter } from './routes/notes';
import { createDevicesRouter } from './routes/devices';
import { InMemoryDeviceTokenRepository } from './push/device-token-service';
import { PgDeviceTokenRepository } from './push/pg-device-token-repository';
import { ExpoPushDeliveryProvider } from './notifications/expo-push-service';
import {
  approverUserIdsResolver,
  notifyExecuted as notifyExecutedPush_,
  notifyNeedsApproval as notifyNeedsApprovalPush_,
} from './notifications/proposal-push-notifier';
import { OwnerNotificationService } from './notifications/owner-notification-service';
import { InMemoryNotificationPreferenceRepository } from './notifications/notification-preferences-service';
import { PgNotificationPreferenceRepository } from './notifications/pg-notification-preferences-repository';
import { createNotificationPreferencesRouter } from './routes/notification-preferences';
import { userIdsWithPermissionResolver } from './notifications/user-targeting';
import { setOwnerNotifications } from './notifications/owner-notifications-instance';
import { setOwnerNotificationNameResolvers } from './notifications/owner-notification-name-resolver';
import {
  TechnicianAssignmentNotifier,
  setTechnicianAssignmentNotifier,
} from './appointments/assignment-notifications';
import {
  createMeRouter,
  DEFAULT_TENANT_TIMEZONE,
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
import { createBrandVoiceRouter } from './tenants/brand/brand-voice-router';
import { PgBrandVoiceRepository } from './tenants/brand/pg-brand-voice-repository';
import { InMemoryBrandVoiceRepository } from './tenants/brand/in-memory-brand-voice-repository';
import { createDncRouter } from './routes/dnc';
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
import { maybeFireFirstRealCallActivation } from './voice/activation';
import { createOnboardingRouter } from './routes/onboarding';
import { createOnboardingConversationRouter } from './routes/onboarding-conversation';
import { OnboardingConversationOrchestrator } from './ai/orchestration/onboarding-conversation';
import {
  InMemoryOnboardingSessionRepository,
  PgOnboardingSessionRepository,
} from './db/onboarding-session-repository';
import { createAssistantRouter } from './routes/assistant';
import { createProposalsRouter } from './routes/proposals';
import { createRedraftHandlerFactory } from './proposals/redraft-handler-factory';
import { createTechnicianLocationRouter } from './routes/technician-location';
import { createCatalogItemsRouter } from './routes/catalog-items';
import { createFilesRouter, createDevStorageRouter } from './routes/files';
import { createJobFilesRouter } from './routes/job-files';
import { createJobPhotosRouter } from './routes/job-photos';
import { JobPhotoService } from './jobs/job-photo-service';
import { InMemoryJobPhotoRepository } from './jobs/job-photo';
import { PgJobPhotoRepository } from './jobs/pg-job-photo';
import { createAttachmentsRouter } from './routes/attachments';
import { AttachmentService } from './attachments/attachment-service';
import { InMemoryAttachmentRepository } from './attachments/attachment';
import { PgAttachmentRepository } from './attachments/pg-attachment';
import { createDispatchRoutes } from './dispatch/routes';
import { initDispatchPresenceStore } from './dispatch/presence-store';
import { initDispatchBoardFanout } from './dispatch/board-event-bus';
import { createDispatchPresenceGatewayDeps } from './dispatch/presence-gateway';
import { createPublicFeedbackRouter } from './routes/public-feedback';
import { createPublicIntakeRouter } from './routes/public-intake';
import { createPublicBookingRouter } from './routes/public-booking';
import { createReportsRouter } from './routes/reports';
import { createDigestsRouter } from './routes/digests';
import { RepoBackedTimeGivenBackReporter } from './reports/time-given-back';
import { RepoBackedVoiceRoiReporter } from './analytics/voice-roi';
import { createVoiceRoiRouter } from './analytics/voice-roi-router';
import { PgJobsBookedReporter } from './analytics/jobs-booked';
import { createJobsBookedRouter } from './analytics/jobs-booked-router';
import { RepoBackedActivityFeedReporter } from './analytics/activity-feed';
import { createActivityFeedRouter } from './analytics/activity-feed-router';
import { loadTenantBusinessHours } from './telephony/business-hours-loader';
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
import { dbPoolConnections, pgQueueDepth, voiceTurnLatencyMs } from './monitoring/metrics';
// WS15 — platform SLO monitor + drain-abandonment alarm.
import { createAlertOperator, emitDrainAbandonment } from './monitoring/alert-operator';
import { recordSweepSuccess, sweepLastSuccessMs } from './monitoring/sweep-heartbeats';
import { PgPlatformSloRepository } from './monitoring/pg-platform-slo';
import {
  runSloMonitor,
  SLO_MONITOR_INTERVAL_MS,
  estimateTurnLatencyP95,
} from './workers/slo-monitor';

// In-memory repositories (fallback for dev without DATABASE_URL)
import { InMemoryCustomerRepository } from './customers/customer';
import { InMemoryContactRepository } from './customers/contact';
import { PgContactRepository } from './customers/pg-contact';
import { InMemoryTagRepository } from './customers/tag';
import { PgTagRepository } from './customers/pg-tag';
import { InMemoryCustomFieldRepository } from './customers/custom-field';
import { PgCustomFieldRepository } from './customers/pg-custom-field';
import { InMemoryCustomerMergeRepository } from './customers/merge';
import { PgCustomerMergeRepository } from './customers/pg-merge';
import { createCustomerCustomFieldRouter } from './routes/customer-custom-fields';
import { InMemoryJobFormRepository } from './job-forms/job-form';
import { PgJobFormRepository } from './job-forms/pg-job-form';
import { createJobFormRouter } from './routes/job-forms';
import { InMemoryRecurringJobRepository } from './recurring-jobs/recurring-job';
import { PgRecurringJobRepository } from './recurring-jobs/pg-recurring-job';
import { createRecurringJobRouter } from './routes/recurring-jobs';
import { InMemoryJobCustomFieldRepository } from './jobs/job-custom-field';
import { PgJobCustomFieldRepository } from './jobs/pg-job-custom-field';
import { createJobCustomFieldRouter } from './routes/job-custom-fields';
import { InMemoryFinancingRepository } from './financing/financing';
import { PgFinancingRepository } from './financing/pg-financing';
import { createFinancingProvider } from './financing/financing-provider';
import { createFinancingRouter, createFinancingWebhookRouter } from './routes/financing';
import { InMemoryCampaignRepository } from './marketing/campaign';
import { PgCampaignRepository } from './marketing/pg-campaign';
import { createMarketingRouter } from './routes/marketing';
import { InMemoryCustomerGroupRepository } from './customers/customer-group';
import { PgCustomerGroupRepository } from './customers/pg-customer-group';
import { createCustomerGroupRouter } from './routes/customer-groups';
import { InMemoryStandingInstructionRepository } from './instructions/standing-instructions';
import { PgStandingInstructionRepository } from './instructions/pg-standing-instructions';
import { createStandingInstructionRouter } from './routes/standing-instructions';
import { InMemoryLeadRepository } from './leads/lead';
import { InMemoryLocationRepository } from './locations/location';
import { InMemoryJobRepository } from './jobs/job';
import { InMemoryJobTimelineRepository } from './jobs/job-lifecycle';
import { InMemoryAppointmentRepository } from './appointments/appointment';
import { InMemoryAssignmentRepository } from './appointments/assignment';
import { InMemoryEstimateRepository } from './estimates/estimate';
import { InMemoryInvoiceRepository } from './invoices/invoice';
import { InMemoryDunningConfigRepository, InMemoryDunningEventRepository } from './invoices/dunning-config';
import { InMemoryInvoiceScheduleRepository } from './invoices/invoice-schedule';
import { PgInvoiceScheduleRepository } from './invoices/pg-invoice-schedule';
import { InMemoryBatchInvoiceRunRepository } from './invoices/batch-invoice-run';
import { PgBatchInvoiceRunRepository } from './invoices/pg-batch-invoice-run';
import { runBatchInvoiceSweep } from './workers/batch-invoice-worker';
import { InMemoryPaymentRepository } from './invoices/payment';
import { createPaymentLinkProvider } from './payments/payment-link-provider';
import { InMemoryNoteRepository } from './notes/note';
import { InMemoryConversationRepository } from './conversations/conversation-service';
import {
  InMemorySettingsRepository,
  resolveEscalationSettings,
  createSettingsOwnerPhoneResolver,
} from './settings/settings';
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
import { createPresidioAnonymizer } from './ai/privacy/presidio-adapter';
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
import { PgTenantFeatureFlagRepository } from './flags/pg-tenant-feature-flags';
import { createFeatureFlagsRouter } from './routes/feature-flags';
import { createAdminTenantsRouter } from './routes/admin-tenants';
import { InMemoryTechnicianLocationPingRepository } from './telemetry/technician-location-ping';
import {
  InMemoryTechnicianLocationAuthorizer,
  PgTechnicianLocationAuthorizer,
} from './telemetry/technician-location-authz';
import { InMemoryQueue, processMessage, type QueueMessage } from './queues/queue';
import { createProvisionTwilioWorker, PROVISION_TWILIO_JOB_TYPE } from './workers/provision-twilio';
import { createDeprovisionTenantWorker } from './workers/deprovision-tenant';
import { createVerifyAiWorker } from './workers/verify-ai';
import { InMemoryApprovalRepository } from './estimates/approval';
import { InMemoryEditDeltaRepository } from './estimates/edit-delta';
import { InMemoryPackActivationRepository } from './settings/pack-activation';
import { buildVerticalPromptResolver } from './verticals/resolve-active-pack';
import { VerticalTerminologyProvider } from './voice/vertical-terminology-provider';
import { TenantGlossaryProvider } from './voice/tenant-glossary-provider';
import { FillerEngine } from './ai/agents/customer-calling/filler-engine';
import { FillerAudioCache } from './ai/agents/customer-calling/filler-audio-cache';
import { classifyTurnSentiment } from './ai/agents/customer-calling/sentiment-classifier';
import { gradeVulnerability } from './ai/agents/customer-calling/vulnerability-grader';
import { createVulnerabilityTriageHook } from './ai/agents/customer-calling/vulnerability-triage-hook';
import {
  PgTriageEventRepository,
  InMemoryTriageEventRepository,
} from './ai/agents/customer-calling/pg-triage-events';
import { patchOwnerThrough } from './ai/skills/patch-owner-through';
import { buildMarkCustomerVulnerablePayload } from './ai/agents/customer-calling/vulnerable-customer';
import { createHvacPack } from './verticals/packs/hvac';
import { createPlumbingPack } from './verticals/packs/plumbing';
import { createElectricalPack } from './verticals/packs/electrical';
import { createPaintingPack } from './verticals/packs/painting';
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
import { PgDunningConfigRepository, PgDunningEventRepository } from './invoices/pg-dunning-config';
import { PgPaymentRepository } from './invoices/pg-payment';
import { InMemoryExpenseRepository } from './expenses/expense';
import { PgExpenseRepository } from './expenses/pg-expense';
import { PgNoteRepository } from './notes/pg-note';
import { PgConversationRepository } from './conversations/pg-conversation';
import { PgSettingsRepository } from './settings/pg-settings';
import { PgAuditRepository } from './audit/pg-audit';
import { ForwardingAuditRepository } from './audit/forwarding-audit-repository';
import { recordApiError } from './analytics/posthog';
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
import { InMemoryCallMeBackRepository } from './voice/call-me-back/call-me-back';
import { PgCallMeBackRepository } from './voice/call-me-back/pg-call-me-back';
import { runCallMeBackSweep } from './workers/call-me-back-worker';
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
import { createSharpImageProcessor } from './files/image-processor';
import { createImagePostProcessWorker } from './workers/image-post-process-worker';
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
import { NoopFeedbackDispatcher, MessageDeliveryFeedbackDispatcher } from './feedback/dispatcher';
import {
  MessageDeliveryProvider,
  InMemoryDeliveryProvider,
} from './notifications/delivery-provider';
import { TwilioDeliveryProvider } from './notifications/twilio-delivery-provider';
import { PerTenantTwilioDeliveryProvider } from './notifications/per-tenant-twilio-delivery-provider';
import { GatedMessageDelivery } from './notifications/gated-message-delivery';
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
import { createOneTapApproveRouter } from './routes/one-tap-approve';
import { createOneTapUndoRouter } from './routes/one-tap-undo';
import { createFeedbackSendWorker } from './workers/feedback-send';
import { runRecurringAgreementsSweep } from './workers/recurring-agreements-worker';
import { runDailyDigestSweep, DIGEST_SWEEP_INTERVAL_MS } from './workers/daily-digest-worker';
import { PgDailyDigestRepository } from './digest/pg-daily-digest';
import { InMemoryDailyDigestRepository, type DailyDigestPayload } from './digest/digest-service';
import { composeBrandVoiceMessage } from './ai/brand-voice/composer';
import { runOverdueInvoiceSweep } from './workers/overdue-invoice-worker';
import { runHfcrWeeklySendSweep } from './workers/hfcr-weekly-send-worker';
import { runWeeklyFeedbackSweep } from './workers/weekly-feedback-worker';
import { buildWeeklyFeedbackSnapshot } from './digest/weekly-feedback-builder';
import { buildSuggestionsPrompt, parseSuggestions } from './digest/weekly-feedback';
import {
  PgHfcrWeeklySendRepository,
  InMemoryHfcrWeeklySendRepository,
} from './metrics/hfcr-weekly-send';
import { runGoogleReviewsSweep } from './workers/google-reviews';
import { runThankYouSmsSweep } from './workers/thank-you-sms-worker';
import { runReviewRequestSweep } from './workers/review-request-worker';
import { createLifecycleEmailWorker } from './workers/lifecycle-email-worker';
import { runSetupReminderSweep } from './workers/setup-reminder-sweep';
import { runTrialReminderSweep } from './workers/trial-reminder-sweep';
import { PgReviewRepository } from './reputation/pg-review';
import { PgReviewPollStateRepository } from './reputation/poll-state';
import { PgServiceCreditRepository } from './reputation/pg-service-credit';
import { PgGoogleBusinessReplyResolver } from './reputation/pg-google-business-reply-resolver';
import { MessageDeliveryReviewPrivateMessageSender } from './reputation/private-message-sender-adapter';
import { SettingsBrandVoiceLoader } from './reputation/settings-brand-voice-loader';
import { PgCustomerLoader } from './reputation/match-customer';
import { createCredentialResolver, getTenantTwilioCreds } from './integrations/credentials';
import { checkOutboundConsent, type OutboundConsentContext } from './voice/outbound-consent';
import { InMemoryAgreementRepository } from './agreements/agreement';
import { PgAgreementRepository } from './agreements/pg-agreement';
import { InMemoryCustomerPaymentMethodRepository } from './payments/customer-payment-method';
import { PgCustomerPaymentMethodRepository } from './payments/pg-customer-payment-method';
import { StripeDuesCollector, DuesInvoiceOps } from './agreements/dues-collector';
import { issueInvoice } from './invoices/invoice';
import { recordPayment } from './invoices/payment';
import { InMemoryAgreementRunRepository } from './agreements/agreement-run';
import { PgAgreementRunRepository } from './agreements/pg-agreement-run';
import { createAgreementsRouter } from './routes/agreements';
import { createMaintenanceContractsRouter } from './routes/maintenance-contracts';
import { PgMaintenanceContractRepository } from './maintenance-contracts/pg-maintenance-contract';
import { InMemoryMaintenanceContractRepository } from './maintenance-contracts/maintenance-contract';
import { createMessageTemplateRouter } from './messaging/message-template-router';
import { PgMessageTemplateRepository } from './messaging/pg-message-template';
import { InMemoryMessageTemplateRepository } from './messaging/message-template';
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
// U7 — structured correction-lesson loop (record on execution, undo on undo).
import {
  InMemoryCorrectionLessonRepository,
} from './learning/corrections/correction-lesson';
import { PgCorrectionLessonRepository } from './learning/corrections/pg-correction-lesson';
import type { ConfigPorts } from './learning/corrections/lesson-applicator';
import { recordCorrectionLessonsOnExecution } from './learning/corrections/record-on-execution';
// Story 3.9 — raw per-field proposal-edit corrections log.
import { InMemoryCorrectionRepository } from './proposals/corrections/correction';
import { PgCorrectionRepository } from './proposals/corrections/pg-correction';
import {
  runRecordingRetentionSweep,
  PgRecordingRetentionRepository,
} from './workers/recording-retention-worker';
import { createRetrieveAdapter } from './ai/orchestration/retrieve-adapter';
import { FrancLanguageDetector } from './voice/language-detector';
import type { RetrieveAdapter } from './ai/orchestration/context-builder';
// P11-002: language detector re-exported so the Twilio adapter (and any
// future channel adapters) can resolve a session's language from the
// customer override + tenant default + STT hint.
export { detectLanguage } from './ai/orchestration/language-detector';
// UB-C1 — the media-stream adapter's initialLanguageResolver composes the
// identified caller's preferredLanguage with the tenant's language settings
// through detectLanguage (which applies the supported_languages gate).
import { detectLanguage as detectInitialCallLanguage } from './ai/orchestration/language-detector';
import { identifyCaller } from './ai/skills/identify-caller';
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
import { createVoiceActionRouterWorker, VoiceActionRouterPayload, INTENT_TO_PROPOSAL_TYPE } from './workers/voice-action-router';
import { PgEntityResolver } from './ai/resolution/pg-entity-resolver';
import { AliasFirstEntityResolver } from './ai/resolution/alias-first-entity-resolver';
import { PgEntityAliasRepository } from './learning/entity-aliases/pg-entity-alias';
import { createEntityAliasCandidateService } from './learning/entity-aliases/candidate-service';
import { createEntityAliasesRouter } from './routes/entity-aliases';
import { DefaultSlotConflictChecker } from './ai/tasks/slot-conflict-checker';
import { DefaultAvailabilityFinder } from './ai/tasks/availability-finder';
import { runExecutionSweep } from './workers/execution-worker';
import {
  createLLMGateway,
  createHermeticMockLLMGateway,
  createEmbeddingProvider,
  shutdownCacheStores,
} from './ai/gateway/factory';
import * as gatewayFactory from './ai/gateway/factory';
import { shutdownRedisClients } from './redis/redis-client';
import { createAiHealthRouter } from './routes/ai-health';
import { InMemoryAiRunRepository } from './ai/ai-run';
import { PgAiRunRepository } from './ai/pg-ai-run';
import { createEvaluationRouter } from './routes/evaluation';
import { PgShadowComparisonStore } from './ai/evaluation/pg-shadow-comparison';
import { InMemoryShadowComparisonStore } from './ai/evaluation/shadow-comparison';
import { createTtsProvider, assertTtsProviderSupportsMediaStreams } from './ai/tts/tts-provider';
import { InAppVoiceAdapter } from './ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from './ai/agents/customer-calling/voice-session-store';
import { createVoiceEventTransport } from './ai/agents/customer-calling/voice-event-transport';
import { createVoiceSessionsRouter } from './routes/voice-sessions';
import { escalationOutcomeRouter } from './escalations/outcome-route';
import { escalationEventsRouter } from './escalations/events-route';
import { whisperRouter } from './telephony/whisper-route';
import { WhisperCache } from './telephony/whisper-cache';
import { requireTwilioSignature } from './telephony/twilio-signature';
import { InMemoryOnCallRepository, PgOnCallRepository } from './oncall/rotation';
import { InMemoryProposalRepository, createProposal as buildProposalRow } from './proposals/proposal';
import { PgProposalRepository } from './proposals/pg-proposal';
// Rivet P2 F-1 — Supervisor Agent v1 (deterministic policy hook + advisory annotator).
import {
  configureSupervisorCreationHook,
  SUPERVISOR_DISABLED_FLAG,
} from './proposals/supervisor/hook';
import {
  SupervisorPolicyService,
  recordExecutedProposalSpend,
} from './proposals/supervisor/service';
import type { SupervisorRules } from './proposals/supervisor/policy';
import {
  InMemorySupervisorPolicyRepository,
  PgSupervisorPolicyRepository,
} from './proposals/supervisor/policies-repo';
import {
  InMemoryTenantBudgetCounterRepository,
  PgTenantBudgetCounterRepository,
} from './proposals/supervisor/budget-counters-repo';
import {
  runSupervisorAnnotationSweep,
  SUPERVISOR_ANNOTATE_SWEEP_INTERVAL_MS,
} from './workers/supervisor-review-worker';
// N-004 (P2-037) — Supervisor Agent review pass (four-check pre-dispatch gate).
import { configureSupervisorReviewGate } from './ai/supervisor/review-gate';
import { createSupervisorReviewGate } from './ai/supervisor/reviewer';
import {
  InMemorySupervisorReviewRepository,
  PgSupervisorReviewRepository,
} from './ai/supervisor/reviews-repo';
import { PgPricingBaselineResolver } from './ai/supervisor/pricing-baseline';
import {
  DEFAULT_SUPERVISOR_REVIEW_MODE,
  type SupervisorReviewMode,
} from './ai/supervisor/types';
import {
  DEFAULT_AI_ROUTING_CONFIG,
  resolveModelForTaskType,
  assertSupervisorReviewModelDistinct,
} from './config/ai-routing';
import { ProposalExecutor } from './proposals/execution/executor';
import { IdempotencyGuard } from './proposals/execution/idempotency';
import {
  NoOpIdempotencyLockProvider,
  PgIdempotencyLockProvider,
} from './proposals/execution/idempotency-lock';
import { createExecutionHandlerRegistry } from './proposals/execution/handlers';
import { assertVoiceHandlersWired } from './proposals/execution/wiring-assertions';
import { resolveInvoiceDeliveryProvider } from './proposals/execution/invoice-delivery-factory';
import { resolveEstimateDeliveryProvider } from './proposals/execution/estimate-delivery-factory';
import { InMemoryWorkingHoursRepository } from './availability/working-hours';
import { PgWorkingHoursRepository } from './availability/pg-working-hours';
import { InMemoryUnavailableBlockRepository } from './availability/unavailable-block';
import { PgUnavailableBlockRepository } from './availability/pg-unavailable-block';
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
import { runHoldReaperSweep } from './workers/hold-reaper-worker';
import { runEstimateReminderSweep } from './workers/estimate-reminder-worker';
import { runEstimateExpirySweep } from './workers/estimate-expiry-worker';
import { runProposalExpirySweep } from './workers/proposal-expiry-worker';
import { PgDncRepository, InMemoryDncRepository } from './compliance/dnc';
import { buildStopKeywordHandler, buildStartKeywordHandler } from './compliance/stop-reply';
import {
  registerKeywordHandler,
  registerRecoveryResumeHandler,
  registerNegotiationHandler,
  registerCaptureHandler,
} from './sms/inbound-dispatch';
import { createInboundNegotiationHandler } from './sms/negotiation/inbound-negotiation-handler';
import { createInboundCaptureHandler } from './sms/inbound-capture';
import { PgCustomerNegotiationContextProvider } from './customers/pg-customer-negotiation-context';
import { normalizePhone } from './customers/dedup';
import { DefaultCurrentQuoteResolver } from './conversations/negotiation/current-quote-resolver';
import { evaluateNegotiationDiscount } from './proposals/guardrails/negotiation-guardrail';
import {
  DroppedCallScheduler,
  PgDroppedCallRecoveryRepository,
  InMemoryDroppedCallRecoveryRepository,
} from './sms/recovery/scheduler';
import { createDroppedCallResumeHandler } from './sms/recovery/resume-handler';
// P8-015 — production deps for the dropped-call recovery sweep.
import type { DroppedCallHandlerDeps } from './sms/recovery/dropped-call-handler';
import { createRecoveryRateLimiter } from './sms/recovery/recovery-rate-limiter';
import { createDroppedCallResolvedSince } from './sms/recovery/resolved-since';
import { createRecoveryComposer } from './sms/recovery/recovery-composer';
import { createRecoveryThreader } from './sms/recovery/recovery-threader';
import {
  runDroppedCallRecoverySweep,
  DROPPED_CALL_RECOVERY_FLAG,
} from './workers/dropped-call-worker';
import { PgConversationLinkRepository } from './conversations/pg-conversation-link';
import {
  PgConsentEventRepository,
  InMemoryConsentEventRepository,
} from './compliance/consent-events';
import { TwilioRecordingControl } from './telephony/recording-control';
// RV-050 — inbound MMS photo ingestion from registered tech phones.
// P0-009: the webhook seam enqueues; the worker runs the pipeline.
import {
  registerMmsIngestHandler,
  createTwilioMediaFetcher,
} from './sms/tech-status/mms-ingest';
// P6-028 — tech "I'm out today" keyword handler (OUT|SICK|UNAVAILABLE).
import {
  registerTechStatusKeywords,
  PgTechStatusTodayRepository,
  InMemoryTechStatusTodayRepository,
} from './sms/tech-status';
import { createMmsIngestWorker } from './workers/mms-ingest-worker';
import { PhoneRateLimiter } from './shared/rate-limit/phone-rate-limit';
import {
  CUSTOMER_MMS_RATE_SCOPE,
  CUSTOMER_MMS_RATE_LIMIT,
  CUSTOMER_MMS_RATE_WINDOW_MS,
} from './sms/customer-mms/customer-mms-intake';
import {
  registerProposalReplySms,
  PgProposalSmsEventRepository,
  InMemoryProposalSmsEventRepository,
  createProposalSmsEvent,
  encodeDigestApproveAllBody,
  createLlmEditInterpreter,
  type OutboundAnchorKind,
} from './proposals/sms';

// Auth middleware
import { verifyClerkSession } from './auth/clerk';
import {
  devAuthBypass,
  isDevAuthBypassEnabled,
  DevInMemoryTenantRepository,
} from './auth/dev-auth-bypass';
import { requireAuth, resolveAuthorization, setAuthorizationLoader } from './middleware/auth';
import { createAuthorizationLoader } from './auth/authorization-loader';
import { withTenantTransaction } from './middleware/tenant-context';
import type { TenantIntegrationStatus } from './integrations/status-machine';
// In-memory dev fallback for the WebhookEvent idempotency repo. Extracted from
// this composition-root into its own module so app.ts no longer carries an
// inline repository class. Production/staging always use the Pg variant
// (createApp() throws if DATABASE_URL is missing in those environments).
import { InMemoryWebhookEventRepository } from './webhooks/in-memory-webhook-event';

// Composition-root helpers extracted into ./bootstrap. Imported for local use
// inside createApp() AND re-exported so existing tests that import them from
// '../../src/app' keep working. (A bare `export { X } from './m'` re-export
// does NOT bind X into local scope, so a local import is required too.)
import { buildHelmetOptions } from './bootstrap/helmet-options';
import { checkMetricsAuth, type MetricsAuthResult } from './bootstrap/metrics-auth';
export { buildHelmetOptions, checkMetricsAuth, type MetricsAuthResult };

// ARCH-02: the graceful-drain sequence (flip /ready to 503, reject new WS
// upgrades, wait DRAIN_TIMEOUT_MS for live voice/WS sessions, then tear down
// background loops/Redis/pool) must run for BOTH a clean SIGTERM/SIGINT and a
// fatal in-process error (uncaughtException) — index.ts's fatal handler calls
// `app.gracefulDrain(reason)` directly instead of duplicating this sequence
// so a sync throw can no longer bypass the drain and drop live calls.
export type AppWithLifecycle = express.Express & {
  /**
   * Idempotent, bounded drain-before-teardown. Safe to call more than once
   * (e.g. a SIGTERM arriving while a fatal-error drain is already in
   * flight) — every caller after the first gets the SAME in-flight promise
   * instead of re-running teardown (double-closing the pool/Redis clients).
   * `reason` is for logging only; it is not necessarily a POSIX signal name.
   */
  gracefulDrain: (reason: string) => Promise<void>;
  /**
   * WS2 — number of background worker intervals this instance registered.
   * Snapshot taken at construction time. Zero when PROCESS_ROLE=web or
   * PROCESS_ROLE=voice (the HTTP/voice surface runs no background loops);
   * nonzero for 'worker'/'all'. Read-only observability seam so tests can
   * assert the process-role split without exporting createApp() internals.
   */
  readonly backgroundIntervalCount: number;
};

export function createApp(): AppWithLifecycle {
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

  // Clerk/svix sign the raw request bytes too. Same treatment as Stripe:
  // capture the raw Buffer here so the handler verifies over the exact bytes
  // svix signed, instead of re-serializing the parsed object (key order /
  // whitespace differences would fail legit webhooks and break tenant bootstrap).
  app.use('/webhooks/clerk', express.raw({ type: 'application/json' }));

  // Vapi signs its server messages (serverUrlSecret). Capture the raw Buffer
  // here so the HMAC verification in handleVapiCallEvent sees the exact bytes
  // Vapi signed — same treatment as Stripe/Clerk.
  app.use('/webhooks/vapi', express.raw({ type: 'application/json' }));

  // Twilio posts application/x-www-form-urlencoded — mount the matching parser
  // before global express.json() so /webhooks/twilio/* routes get populated
  // req.body fields (used for signature verification + AccountSid match).
  app.use('/webhooks/twilio', express.urlencoded({ extended: false }));

  // FIN — Wisetack financing webhook needs the raw body for HMAC verification.
  // Register the raw parser BEFORE global express.json() (like Stripe); the
  // handler router is mounted later once repos are constructed.
  app.use('/webhooks/wisetack', express.raw({ type: '*/*' }));

  // SEC-40 — SendGrid's Event Webhook signs `timestamp + payload` (ECDSA over
  // the EXACT delivered bytes). Capture the raw Buffer here BEFORE global
  // express.json() so handleSendGrid verifies over the bytes SendGrid signed —
  // same treatment as Stripe/Vapi. Without this the global json() consumes and
  // re-parses the body; the handler's JSON.stringify() fallback re-serializes a
  // different byte sequence (key order / whitespace), so verifySendGridSignature
  // rejects every genuine signed delivery and the webhook is non-functional.
  app.use('/webhooks/sendgrid', express.raw({ type: 'application/json' }));

  // Body parsing for all other routes. Explicit ceiling (default is an
  // implicit 100kb): large-but-bounded so no client can buffer unbounded
  // JSON into the process, and the limit is visible here rather than
  // buried in body-parser defaults.
  app.use(express.json({ limit: '1mb' }));

  // Serve static frontend files from the built React app.
  // resolveWebDistDir anchors on the packages/api boundary so it points at
  // <repoRoot>/packages/web/dist in both dev (__dirname=.../api/src) and the
  // built image (__dirname=.../api/dist/src). See web-static-path.ts.
  const frontendPath = resolveWebDistDir(__dirname);
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

  // CORS — use explicit origin(s) in prod/staging (validated by config),
  // wildcard in dev/test. Comma-separated CORS_ORIGIN lets Railway host
  // both the custom domain and the *.up.railway.app alias.
  const corsOrigin = config.CORS_ORIGIN
    ? config.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : true;
  app.use(cors({
    origin: Array.isArray(corsOrigin) && corsOrigin.length === 1
      ? corsOrigin[0]
      : corsOrigin,
    credentials: true,
  }));

  // Rate limiting — applied before auth to protect all routes
  // In dev mode, use a much higher limit to allow QA testing
  const isDev = process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'development';
  const redisUrl = process.env.REDIS_URL;
  // T4-F02: this per-IP limiter is a DoS guard, not the fairness control — a
  // shared-NAT office can exhaust a low per-IP cap with normal multi-user
  // traffic. The per-tenant limiter below (API_TENANT_RATE_LIMIT_MAX,
  // :4372-4384) is the actual fairness/abuse control. Env-configurable so the
  // ceiling can be tightened without a code change if abuse patterns emerge.
  const ipRateMax = Math.max(1, Number(process.env.API_IP_RATE_LIMIT_MAX) || 2000);
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isDev ? 10000 : ipRateMax, // per IP — relaxed in dev for QA testing
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isDev && process.env.DEV_AUTH_BYPASS === 'true',
    // P3/U-P3c: shared Redis counter so the per-IP cap is cluster-wide (else N
    // replicas = N× the limit). undefined ⇒ default per-process MemoryStore.
    store: createRateLimitStore(redisUrl, 'api:'),
  }));
  // T4-F02: the six signature-verified provider webhook prefixes need
  // materially higher throughput than unknown/junk /webhooks/* paths — this
  // limiter must stay in sync with the raw-body parsers above (:760-790); a
  // seventh provider added there without a matching prefix here just falls
  // back to the general /webhooks limit below (fails safe, not open).
  // Mounted BEFORE the general /webhooks limiter so legitimate provider
  // bursts aren't 429'd ahead of signature verification (webhook router,
  // mounted later) at realistic callback volume.
  const webhookProviderPrefixes = [
    '/webhooks/stripe',
    '/webhooks/clerk',
    '/webhooks/vapi',
    '/webhooks/twilio',
    '/webhooks/wisetack',
    '/webhooks/sendgrid',
  ];
  // Segment-boundary match on the SAME string Express used for mount
  // matching (req.baseUrl + req.path — no query string, same non-
  // normalization of dot-segments), so "skipped by the general limiter"
  // and "covered by the provider limiter above" can never diverge:
  // '/webhooks/stripefake' is neither, '/webhooks/stripe/../x' is both.
  const isProviderWebhookPath = (url: string) =>
    webhookProviderPrefixes.some(
      (prefix) => url === prefix || url.startsWith(`${prefix}/`),
    );
  const webhookProviderRateMax = Math.max(1, Number(process.env.WEBHOOK_PROVIDER_RATE_LIMIT_MAX) || 600);
  app.use(webhookProviderPrefixes, rateLimit({
    windowMs: 60 * 1000,      // 1 minute
    max: webhookProviderRateMax,
    store: createRateLimitStore(redisUrl, 'webhooks-provider:'),
  }));
  app.use('/webhooks', rateLimit({
    windowMs: 60 * 1000,      // 1 minute
    max: 30,
    // Only governs unknown/junk /webhooks/* paths — the six provider
    // prefixes are already rate-limited (at higher throughput) above.
    // NB: req.path is relative to this middleware's '/webhooks' mount point
    // (e.g. '/stripe'); baseUrl + path reconstructs the full mount-matched
    // path without the query string.
    skip: (req) => isProviderWebhookPath(req.baseUrl + req.path),
    store: createRateLimitStore(redisUrl, 'webhooks:'),
  }));
  // Public invoice/estimate pages are unauthenticated but token-gated.
  // Limit aggressively to slow token brute-force and view-count inflation.
  app.use('/public', rateLimit({
    windowMs: 60 * 1000,      // 1 minute
    max: 30,                  // per IP
    store: createRateLimitStore(redisUrl, 'public:'),
  }));

  const requestLogger = createLogger({
    service: 'api-http',
    environment: process.env.NODE_ENV || 'development',
  });
  app.use(createRequestLoggingMiddleware(requestLogger));

  // Initialize repositories — use Postgres when DATABASE_URL is set, otherwise
  // fall back to in-memory for local development without a database.
  const pool = process.env.DATABASE_URL ? createPool() : undefined;
  // Direct (session-mode) pool for state that is unsafe under PgBouncer
  // transaction pooling — session advisory locks (leader election, the proposal
  // idempotency lock) and LISTEN/NOTIFY. `createDirectPool()` returns null when
  // DATABASE_DIRECT_URL is unset, so we fall back to the main pool — identical
  // behavior to before for dev / any deployment without PgBouncer.
  const directPool = pool ? (createDirectPool() ?? pool) : undefined;
  // U3b — WS per-tenant connection cap: cluster-wide via Redis when REDIS_URL is
  // set (lease-TTL so a crashed replica's slots self-expire), else process-local.
  const connectionRegistry = createConnectionRegistry(process.env.REDIS_URL);

  // In production, in-memory repositories lose all data on restart — crash fast.
  if (!pool && (config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging')) {
    throw new Error('DATABASE_URL is required in production and staging environments');
  }

  // RLS runtime-role guard: when RLS_RUNTIME_ROLE=true, refuse to run unless the
  // rls_app_runtime role is actually assumable — never serve with the flag on but
  // enforcement silently absent. No-op when the flag is off.
  if (pool) {
    void verifyRlsRuntimeRole(pool).catch((err) => {
      process.stderr.write(
        `FATAL ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
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
          // Report `down` so /ready returns 503 and stops taking traffic during
          // a genuine DB outage. /health stays 200 (liveness) per railway.toml.
          return { status: 'down', message: 'Database connection failed' };
        }
      },
    });
  }
  // P4/U-P4a: while draining for shutdown, /ready (which fails on any `down`
  // check) returns 503 so the load balancer stops routing NEW traffic here while
  // active calls finish. /health (liveness) is unaffected.
  checks.push({
    name: 'drain',
    check: async () => (isDrainingFlag() ? { status: 'down', message: 'draining' } : { status: 'ok' }),
  });
  const healthRouter = createHealthRouter('1.0.0', process.env.NODE_ENV || 'development', checks);
  app.use('/', healthRouter);

  // P2-029 — AI provider health endpoint. Public listing (/ai) needs no auth.
  // U4 completion probe (/ai/completion) is gated like /metrics.
  // Uses the shared breaker registry + gateway populated by createLLMGateway()
  // later in boot — read at request time, not mount time.
  // Assigned after createLLMGateway() below — request handlers read it lazily.
  let aiHealthGateway: import('./ai/gateway/gateway').LLMGateway | undefined;
  app.use('/api/health', (req, res, next) => {
    const registry = gatewayFactory.sharedBreakerRegistry;
    if (!registry) {
      // Gateway not yet initialised (e.g. mock mode without AI_PROVIDER_API_KEY)
      if (req.path === '/ai') {
        res.status(200).json({ providers: [] });
        return;
      }
      if (req.path === '/ai/completion') {
        res.status(503).json({
          error: 'AI_GATEWAY_UNAVAILABLE',
          message: 'LLM gateway is not configured (AI_PROVIDER_API_KEY missing).',
        });
        return;
      }
      next();
      return;
    }
    createAiHealthRouter(registry, [], { gateway: aiHealthGateway })(req, res, next);
  });

  // Prometheus metrics — gated by `checkMetricsAuth` (METRICS_TOKEN bearer).
  // The endpoint exposes tenant ids, request volumes, and pool counts, so
  // network-level allowlists alone are not enough on a public hostname.
  app.get('/metrics', async (req, res) => {
    const auth = checkMetricsAuth(
      req.headers.authorization,
      process.env.METRICS_TOKEN,
      process.env.NODE_ENV,
    );
    if (!auth.ok) {
      if (auth.headers) {
        for (const [k, v] of Object.entries(auth.headers)) res.setHeader(k, v);
      }
      res.status(auth.status).json(auth.body);
      return;
    }

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
  // Same for settings: InMemorySettingsRepository is stateful — the
  // Clerk webhook seeder and /api/settings must share one map or
  // hermetic/dev boots 404 on Settings after a successful bootstrap.
  const tenantRepo = pool
    ? new PgTenantRepository(pool)
    : new DevInMemoryTenantRepository();
  const settingsRepo = pool
    ? new PgSettingsRepository(pool)
    : new InMemorySettingsRepository();
  const webhookSettingsRepo = settingsRepo;
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
  // Tier 4 (Subscription — Rivet billing). Hoisted up so the Stripe
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
  // Wrap the single audit-repo instance in the PostHog forwarding decorator at
  // the composition root: every mutation's audit write (~270 sites, all
  // domains) is threaded through `auditRepo`, so this one wrap gives full
  // in-app product-event coverage. Off-by-default — a no-op forward until
  // POSTHOG_API_KEY is set, and it can never break a mutation.
  const webhookAuditRepo = new ForwardingAuditRepository(
    pool ? new PgAuditRepository(pool) : new InMemoryAuditRepository(),
  );
  const webhookEventRepo = pool ? new PgWebhookEventRepository(pool) : new InMemoryWebhookEventRepository();
  // Blocker 1 — durable idempotency store for the Stripe/Clerk dedup path
  // (handleWebhookEvent). Postgres-backed in real deploys; left undefined
  // without a pool (tests/dev) so createWebhookRouter falls back to its
  // in-memory map. createWebhookRouter throws if this is missing in prod.
  const webhookRepo = pool ? new PgWebhookRepository(pool) : undefined;

  // §7 Phase 1 — DNC repository + STOP/START keyword handler registration.
  // The inbound-SMS dispatcher routes any matching first-token to these
  // handlers, which mutate tenant_dnc_list. Suppression at outbound-send
  // time is layered on top in send-service / appointment-confirmation-notifier.
  const dncRepo = pool ? new PgDncRepository(pool) : new InMemoryDncRepository();
  // STOP/START handler registration is deferred until the consent ledger and
  // customer repos exist (Story 10.6 unifies DNC + consent_events + the
  // customers.consent_status rollup) — see registration below.

  // Resolves per-tenant integration credentials for inbound webhook signature
  // verification. Returns null when no row exists or the integration provider
  // doesn't match — recordTwilio / recordSendGrid then 403 with audit.
  const integrationResolver = pool ? createIntegrationResolver(pool) : undefined;
  // Per-tenant Vapi webhook secret resolver (closes the cross-tenant forgery
  // the single global secret allowed). The /vapi handler falls back to the
  // global secret when this returns null (tenant not yet re-provisioned).
  const vapiSecretResolver = pool ? createVapiSecretResolver(pool) : undefined;

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
    webhookRepo,
    integrationResolver,
    vapiSecretResolver,
    // #6 phase 4 — persist saved cards on setup_intent.succeeded.
    // customerPaymentMethodRepo is wired in after its instantiation below.
    stripeConfig: process.env.STRIPE_SECRET_KEY
      ? { apiKey: process.env.STRIPE_SECRET_KEY }
      : undefined,
  };
  // SEC-41 — canonical webhook surface is `/webhooks/*` (every external
  // provider config in docs/launch/GO-LIVE-RUNBOOK.md + docs/third-party-services
  // points there). The former `/api/webhooks` alias was mounted WITHOUT the
  // per-provider raw-body middleware above (only registered for `/webhooks/*`),
  // so `/api/webhooks/stripe|vapi` reached the handler with a JSON-parsed body:
  // the Stripe handler throws synchronously when req.body isn't a Buffer, which
  // in Express 4 becomes an unhandled rejection and HANGS the request. The alias
  // is unreferenced by any test, e2e spec, doc, or provider config, so it is
  // removed rather than duplicated — smaller surface, no divergent behavior.
  app.use('/webhooks', createWebhookRouter(config, webhookRouterDeps));

  // Dev-only storage PUT receiver for DevStorageProvider upload URLs.
  // Mounted before /api Clerk auth so unauthenticated presigned-style PUTs
  // succeed in local development. In prod/staging, createStorageProvider
  // refuses to return a DevStorageProvider, so this route is dormant.
  if (config.NODE_ENV !== 'prod' && config.NODE_ENV !== 'staging') {
    app.use('/storage-dev', createDevStorageRouter());
  }

  const customerRepo       = pool ? new PgCustomerRepository(pool)       : new InMemoryCustomerRepository();
  // U1 (CRM Jobber parity) — multiple contacts per customer.
  const customerContactRepo = pool ? new PgContactRepository(pool)       : new InMemoryContactRepository();
  // U2 (CRM Jobber parity) — customer tags + tenant-defined custom fields.
  const customerTagRepo     = pool ? new PgTagRepository(pool)           : new InMemoryTagRepository();
  const customerCustomFieldRepo = pool ? new PgCustomFieldRepository(pool) : new InMemoryCustomFieldRepository();
  const jobFormRepo = pool ? new PgJobFormRepository(pool) : new InMemoryJobFormRepository();
  const recurringJobRepo = pool ? new PgRecurringJobRepository(pool) : new InMemoryRecurringJobRepository();
  const jobCustomFieldRepo = pool ? new PgJobCustomFieldRepository(pool) : new InMemoryJobCustomFieldRepository();
  const financingRepo = pool ? new PgFinancingRepository(pool) : new InMemoryFinancingRepository();
  const financingProvider = createFinancingProvider();
  const campaignRepo = pool ? new PgCampaignRepository(pool) : new InMemoryCampaignRepository();
  const customerGroupRepo = pool ? new PgCustomerGroupRepository(pool) : new InMemoryCustomerGroupRepository();
  // UB-A1 — standing instructions the AI agents apply when drafting.
  const standingInstructionRepo = pool
    ? new PgStandingInstructionRepository(pool)
    : new InMemoryStandingInstructionRepository();
  const entityAliasRepo = pool ? new PgEntityAliasRepository(pool) : undefined;
  // Story 4.6 — customer merge. Pg re-parents child rows + archives the loser
  // in one transaction; the no-DB dev path only archives (no child tables).
  const customerMergeRepo = pool
    ? new PgCustomerMergeRepository(pool)
    : new InMemoryCustomerMergeRepository(customerRepo);
  // N-003 (P2-036) — caller LTV/recency for the negotiation guardrail callback.
  const customerNegotiationContextProvider = pool
    ? new PgCustomerNegotiationContextProvider(pool)
    : undefined;
  const leadRepo           = pool ? new PgLeadRepository(pool)           : new InMemoryLeadRepository();
  const locationRepo       = pool ? new PgLocationRepository(pool)       : new InMemoryLocationRepository();
  // jobRepo is hoisted earlier so the Stripe webhook + everything else
  // share a single InMemory instance during tests.
  const timelineRepo       = pool ? new PgJobTimelineRepository(pool)    : new InMemoryJobTimelineRepository();
  const appointmentRepo    = pool ? new PgAppointmentRepository(pool)    : new InMemoryAppointmentRepository();
  const assignmentRepo     = pool ? new PgAssignmentRepository(pool)     : new InMemoryAssignmentRepository();
  // Declared here (ahead of its first router use) so the jobs router's
  // from-estimate scheduling deps can reference it.
  const userRepo = pool ? new PgUserRepository(pool) : new InMemoryUserRepository();
  // Hermetic / DEV_AUTH_BYPASS path: share one InMemoryUserModeService so
  // bootstrap can upsert the owner row (with internal_user_id) before
  // /api/me mounts. Pg-backed mode still builds its service later.
  const inMemoryUserModeService = pool ? null : new InMemoryUserModeService();
  // Working hours are now Pg-backed in production (migration 137 added
  // technician_working_hours), so the dispatch feasibility composer and the
  // inbound-AI availability search enforce real working-hours rows instead of
  // treating missing rows as no-conflict. The unavailable-block repo is now
  // Pg-backed too (migration 116 `tech_unavailable_blocks`) so the P6-028
  // tech "I'm out" handler persists real same-day blocks the feasibility
  // composer reads. InMemory variants stay for tests / no-pool.
  const workingHoursRepo       = pool ? new PgWorkingHoursRepository(pool)     : new InMemoryWorkingHoursRepository();
  const unavailableBlockRepo   = pool ? new PgUnavailableBlockRepository(pool) : new InMemoryUnavailableBlockRepository();
  const travelTimeProvider     = createTravelTimeProvider(process.env);
  const skillMatcher           = new StubSkillMatcher();
  const estimateRepo       = pool ? new PgEstimateRepository(pool)       : new InMemoryEstimateRepository();
  const invoiceRepo        = pool ? new PgInvoiceRepository(pool)        : new InMemoryInvoiceRepository();
  const dunningConfigRepo  = pool ? new PgDunningConfigRepository(pool)  : new InMemoryDunningConfigRepository();
  const dunningEventRepo   = pool ? new PgDunningEventRepository(pool)   : new InMemoryDunningEventRepository();
  const hfcrWeeklySendRepo = pool ? new PgHfcrWeeklySendRepository(pool) : new InMemoryHfcrWeeklySendRepository();
  const invoiceScheduleRepo = pool ? new PgInvoiceScheduleRepository(pool) : new InMemoryInvoiceScheduleRepository();
  const batchInvoiceRunRepo = pool ? new PgBatchInvoiceRunRepository(pool) : new InMemoryBatchInvoiceRunRepository();
  const batchInvoiceTxRunner = pool ? new PgTenantTransactionRunner(pool) : new InMemoryTransactionRunner();
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
  // settingsRepo is constructed once above (webhook + /api/settings share it).
  // P2-036 V2 — resolves the customer's current live quote for the discount engine.
  const negotiationQuoteResolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });
  // Voice-parity (Feature 7) — call_me_back tasks (failed-transfer callbacks).
  const callMeBackRepo     = pool ? new PgCallMeBackRepository(pool)     : new InMemoryCallMeBackRepository();
  // PR B (Tier 4 / AI approval rules) — shared per-tenant
  // auto-approve threshold resolver. One cached instance for all
  // entry points (twilio adapter, inapp adapter, voice-action-router
  // worker) so settings hits the DB at most once per tenant per TTL
  // window across the whole process.
  const thresholdResolver = createThresholdResolver(settingsRepo);
  // Per-tenant scheduling context (IANA timezone) for the voice booking
  // path. Delegates to settingsRepo (same RLS / withTenant path) so spoken
  // times ("next Tuesday at 2pm") resolve against the TENANT's zone instead
  // of a hardcoded one. A 60s cache mirrors thresholdResolver/voicePersona
  // so a multi-segment chain doesn't re-query settings per segment. Best-
  // effort: the router falls back to the product default when undefined.
  const schedulingTzCache = new Map<
    string,
    {
      timezone?: string;
      businessHours?: Record<string, { open: string; close: string } | null> | null;
      expiresAt: number;
    }
  >();
  const tenantSchedulingResolver = async (tenantId: string) => {
    const hit = schedulingTzCache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) {
      return { timezone: hit.timezone, businessHours: hit.businessHours };
    }
    const settings = await settingsRepo.findByTenant(tenantId);
    const timezone = settings?.timezone;
    // UB-D — business hours ride the same cached read so the autonomous
    // booking lane's in-hours gate costs no extra settings query.
    const businessHours = settings?.businessHours;
    schedulingTzCache.set(tenantId, { timezone, businessHours, expiresAt: Date.now() + 60_000 });
    return { timezone, businessHours };
  };
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
  // #6 phase 4 — saved cards for off-session dues billing.
  const customerPaymentMethodRepo = pool
    ? new PgCustomerPaymentMethodRepository(pool)
    : new InMemoryCustomerPaymentMethodRepository();
  // Wire into the webhook deps (assembled above, before this repo existed) so
  // setup_intent.succeeded can persist the card — mirrors paymentReceiptNotifier.
  webhookRouterDeps.customerPaymentMethodRepo = customerPaymentMethodRepo;
  const templateRepo       = pool ? new PgEstimateTemplateRepository(pool) : new InMemoryEstimateTemplateRepository();
  const messageTemplateRepo = pool ? new PgMessageTemplateRepository(pool) : new InMemoryMessageTemplateRepository();
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
  let voiceExtendedIntentsFlagResolver:
    | ((tenantId: string) => Promise<boolean>)
    | null = null;
  const voiceExtendedIntentsFlagShim = async (tenantId: string): Promise<boolean> => {
    return voiceExtendedIntentsFlagResolver
      ? voiceExtendedIntentsFlagResolver(tenantId)
      : false;
  };
  // WS5 — Presidio-first redaction. When both analyzer + anonymizer URLs are
  // configured we run a real Presidio pass ahead of the deterministic scrub and
  // fail closed (quarantine) if it is unreachable. Unset ⇒ local-only scrub.
  const presidioAnonymizer = createPresidioAnonymizer(config);
  const trainingAssetService = new TrainingAssetService({
    assetRepo: trainingAssetRepo,
    privacyAuditRepo,
    auditRepo,
    redaction: new TrainingAssetRedactionService(
      presidioAnonymizer ? { presidio: presidioAnonymizer } : {},
    ),
    // Transactional persistence for the asset + privacy_audit + audit writes
    // when a real Postgres pool is present (compensating deletes otherwise).
    pool: pool ?? undefined,
    invalidatePromptCache: (tenantId) => invalidateVerticalPromptCache?.(tenantId),
  });
  const fileRepo           = pool ? new PgFileRepository(pool)           : new InMemoryFileRepository();
  const jobFileRepo        = pool ? new PgJobFileRepository(pool)        : new InMemoryJobFileRepository();
  const jobPhotoRepo       = pool ? new PgJobPhotoRepository(pool)       : new InMemoryJobPhotoRepository();
  // RV-005: generalized attachments (photos & documents on any entity).
  const attachmentRepo     = pool ? new PgAttachmentRepository(pool)     : new InMemoryAttachmentRepository();
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
  const timeEntryRepo      = pool ? new PgTimeEntryRepository(pool)       : new InMemoryTimeEntryRepository();

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
  // Falls back to a hermetic MockLLMProvider in dev/test so the app boots
  // without an AI_PROVIDER_API_KEY and Assistant can still draft proposals
  // (fixed "unknown" mock permanently degraded the chat path).
  const llmGateway = config.AI_PROVIDER_API_KEY
    ? createLLMGateway(config, { aiRunRepo, shadowStore })
    : createHermeticMockLLMGateway().gateway;
  // Wire completion probe for GET /api/health/ai/completion (even hermetic mock
  // — probe then proves the mock path responds, which is useful in local boot).
  aiHealthGateway = llmGateway;

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
  // U7 — structured correction-lesson loop. The repo + ConfigPorts back the
  // recordCorrectionLessonsOnExecution call in the executor's onExecuted seam
  // (and the undo path in proposal actions). Ports cascade a distilled lesson
  // into real tenant config: labor rate (tenant_settings.labor_rate_cents_per
  // _hour), SKU price (catalog item), banned phrases (brand-voice negative
  // prompt). setTemplateWeight is a no-op — no template-weight store exists yet,
  // so scope_reclassified lessons aren't produced (no resolveTemplate passed).
  const correctionLessonRepo = pool
    ? new PgCorrectionLessonRepository(pool)
    : new InMemoryCorrectionLessonRepository();
  // WS6 — supervisor_reviews repo, hoisted here (rather than constructed
  // inline inside the review-gate config further down) so the daily-digest
  // worker deps can reuse the SAME instance for its "Checked: N proposals,
  // M flagged" reflection line instead of standing up a second repo.
  const supervisorReviewsRepo = pool
    ? new PgSupervisorReviewRepository(pool)
    : new InMemorySupervisorReviewRepository();
  // Story 3.9 — raw per-field proposal-edit log (intent + field + before/after),
  // queryable per tenant and per intent; the training signal for prompt/routing
  // improvement. Distinct from correction_lessons (cascading config above).
  const correctionRepo = pool
    ? new PgCorrectionRepository(pool)
    : new InMemoryCorrectionRepository();
  const correctionConfigPorts: ConfigPorts = {
    async setLaborRateCents(tenantId, cents) {
      await settingsRepo.update(tenantId, { laborRateCentsPerHour: cents });
    },
    async setSkuPriceCents(tenantId, catalogItemId, cents) {
      await catalogRepo.update(tenantId, catalogItemId, { unitPriceCents: cents });
    },
    async setBannedPhrases(tenantId, phrases) {
      const current = await settingsRepo.findByTenant(tenantId);
      await settingsRepo.update(tenantId, {
        brandVoice: { ...(current?.brandVoice ?? {}), banned_phrases: phrases },
      });
    },
    async setTemplateWeight() {
      /* No template-weight store yet; scope_reclassified lessons aren't produced. */
    },
  };
  const retrievalEvalRunRepo = pool
    ? new PgRetrievalEvalRunRepository(pool)
    : new InMemoryRetrievalEvalRunRepository();
  const callTranscriptTurnRepo = pool
    ? new PgCallTranscriptTurnRepository(pool)
    : new InMemoryCallTranscriptTurnRepository();

  // Customer-facing message delivery for estimates and invoices.
  // Production wires Twilio (SMS) + Twilio SendGrid (email). Without
  // the env vars, falls back to InMemoryDeliveryProvider so the app
  // boots in dev without delivery credentials. Send routes return
  // 503 when sendService is undefined.
  const dispatchRepo = pool ? new PgDispatchRepository(pool) : new InMemoryDispatchRepository();
  let rawMessageDelivery: MessageDeliveryProvider | null;
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER &&
    process.env.SENDGRID_API_KEY &&
    process.env.SENDGRID_FROM_EMAIL
  ) {
    // The global Twilio/SendGrid provider handles email and any send that
    // carries no tenantId; the global Twilio SMS creds also serve as the
    // dev/test fallback inside getTenantTwilioCreds.
    const baseDelivery = new TwilioDeliveryProvider({
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
    });
    // Feature 7 — when a Postgres pool is available, route per-tenant SMS
    // through each tenant's own Twilio subaccount (failing closed when a
    // tenant has no credentials). Without a pool we cannot resolve per-tenant
    // creds, so keep the global provider.
    rawMessageDelivery = pool
      ? new PerTenantTwilioDeliveryProvider({ pool, base: baseDelivery })
      : baseDelivery;
  } else if (config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging') {
    rawMessageDelivery = null;
  } else {
    rawMessageDelivery = new InMemoryDeliveryProvider();
  }
  // RV-130 — consent ledger (append-only consent_events). Constructed here —
  // before the SMS gate — because WS12 makes it the cross-channel source of
  // truth both outbound gates consult; the STOP/START keyword handlers and
  // the voice adapter (registered further down) append to the same instance.
  const consentEventRepo = pool
    ? new PgConsentEventRepository(pool)
    : new InMemoryConsentEventRepository();

  // WS1 safety rails — wrap the single delivery object in the consent+DNC gate
  // so EVERY outbound SMS passes exactly one gate. Owner-class sends bypass;
  // customer-class sends are gated per `config.TCPA_CONSENT_ENFORCEMENT` (the
  // SAME value that drives the voice consent gate). Wrapping here — the single
  // construction site — is what makes the guarantee hold for all three
  // provider branches (per-tenant, global, and in-memory dev).
  // WS12 — the gate also consults the consent ledger so a revocation arriving
  // on ANY channel (voice, portal, manual, STOP) suppresses customer SMS.
  const messageDelivery: MessageDeliveryProvider | null = rawMessageDelivery
    ? new GatedMessageDelivery({
        base: rawMessageDelivery,
        dnc: dncRepo,
        auditRepo,
        enforcement: config.TCPA_CONSENT_ENFORCEMENT,
        consentLedger: consentEventRepo,
      })
    : null;

  // WS1 — resolve a customer's SMS consent by phone for send sites that only
  // hold the recipient's number (dropped-call recovery + negotiation replies).
  // A single customer match yields the consent snapshot; zero or many matches →
  // undefined, which makes the central gate fail closed (missing_consent_context)
  // rather than silently guess.
  const resolveCustomerConsentByPhone = async (
    tenantId: string,
    phone: string,
  ): Promise<{ smsConsent: boolean; customerId?: string } | undefined> => {
    try {
      const matches = await customerRepo.findByPhoneNormalized(
        tenantId,
        normalizePhone(phone),
      );
      if (matches.length !== 1) return undefined;
      return { smsConsent: matches[0].smsConsent === true, customerId: matches[0].id };
    } catch {
      return undefined;
    }
  };

  // WS1 — feedback-request SMS now flows through the single messageDelivery
  // object (customer-class) instead of a raw Twilio fetch. Noop without a
  // provider so dev/CI boot without SMS creds.
  const feedbackDispatcher = messageDelivery
    ? new MessageDeliveryFeedbackDispatcher(messageDelivery)
    : new NoopFeedbackDispatcher();
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

  // ── P12-004 wiring — one-tap approve (unsupervised queue_and_sms) ────────
  // HMAC secret for the single-use approve token in the owner SMS. In prod /
  // staging it must be configured explicitly; dev falls back to a fixed
  // secret so the flow is exercisable without env setup.
  const oneTapSecret =
    process.env.ONE_TAP_APPROVE_SECRET ??
    (config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging'
      ? undefined
      : 'dev-one-tap-approve-secret');
  const oneTapApiBaseUrl = (
    process.env.PUBLIC_API_URL ?? process.env.APP_PUBLIC_URL ?? 'http://localhost:3000'
  ).replace(/\/+$/, '');
  // Durable single-use nonce store: reuse the webhook_events idempotency
  // primitive (unique index on (source, idempotency_key), INSERT … ON
  // CONFLICT DO NOTHING) so a one-tap link stays single-use across restarts
  // and across instances. In-memory repo backs dev without a DATABASE_URL.
  const consumeOneTapNonce = async (nonce: string): Promise<boolean> => {
    const receipt = await webhookEventRepo.recordReceipt(
      'one_tap_approve',
      nonce,
      'one_tap_approve_nonce',
      {},
    );
    return receipt.inserted;
  };
  // UB-D / D3 — same durable receipt store, DISTINCT source: undo nonces
  // and approve nonces can never collide or cross-consume.
  const consumeOneTapUndoNonce = async (nonce: string): Promise<boolean> => {
    const receipt = await webhookEventRepo.recordReceipt(
      'one_tap_undo',
      nonce,
      'one_tap_undo_nonce',
      {},
    );
    return receipt.inserted;
  };
  // Capture as const so the SMS closure narrows (messageDelivery is a let).
  const oneTapDelivery = messageDelivery;
  const oneTapSmsSender = oneTapDelivery
    ? async (to: string, body: string): Promise<void> => {
        // One-tap approval link → owner/operator. Never gated by customer consent.
        await oneTapDelivery.sendSms({ to, body, recipientClass: 'owner' });
      }
    : undefined;
  // Owner/backup-supervisor phone for the unsupervised SMS: tenant_settings
  // owner_phone first, then the backup supervisor's mobile_number.
  const resolveUnsupervisedOwnerPhone = async (tenantId: string): Promise<string | null> => {
    const settings = await settingsRepo.findByTenant(tenantId);
    if (settings?.ownerPhone) return settings.ownerPhone;
    if (settings?.backupSupervisorUserId) {
      const backup = await userRepo.findById(tenantId, settings.backupSupervisorUserId);
      return backup?.mobileNumber ?? null;
    }
    return null;
  };

  const workerLogger = createLogger({
    service: 'transcription-worker',
    environment: process.env.NODE_ENV || 'development',
    level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  });

  // A1 — tenant-scoped vocabulary (catalog item names, active customer
  // names, technician/user names) for the transcription-correction pass.
  // Reuses the same catalogRepo/customerRepo/userRepo already constructed
  // above for the rest of the app; best-effort (never throws — see
  // TenantGlossaryProvider's own doc comment).
  const transcriptionGlossaryProvider = new TenantGlossaryProvider({
    catalogRepo,
    customerRepo,
    userRepo,
  });

  const transcriptionWorker = createTranscriptionWorker(
    voiceRepo,
    transcriptionProvider,
    {
      // Wires the correction pass (workers/transcription.ts's
      // `if (options.gateway …)` block) live — previously only
      // onTranscribed + rawTranscriptEncryptionKey were passed here, so
      // correction never ran regardless of AI_PROVIDER_API_KEY.
      //
      // llmGateway is NOT always the real provider — it falls back to a
      // hermetic MockLLMProvider when AI_PROVIDER_API_KEY is unset (see its
      // construction above). But transcriptionProvider (Whisper, via
      // createWhisperTranscriptionProvider) is gated on a DIFFERENT env var
      // (OPENAI_API_KEY alone) and runs for REAL regardless of
      // AI_PROVIDER_API_KEY. That asymmetry meant a deployment with
      // OPENAI_API_KEY but no AI_PROVIDER_API_KEY got real Whisper
      // transcripts silently replaced: the hermetic mock's scripted
      // catch-all response for transcription_correction is an ~84-char JSON
      // blob (`{"ok":true,"mock":true,...}`) that clears the 40%-length
      // floor in transcription.ts's correctTranscript() for any real
      // transcript ≤210 chars — corrupting genuine voice-memo transcripts
      // with mock JSON before downstream intent classification ever runs
      // (observed live). Only pass gateway/glossary when the REAL gateway
      // was built, so correction is skipped cleanly (raw transcript kept)
      // for keyless-gateway deployments — matching pre-branch behavior.
      ...(config.AI_PROVIDER_API_KEY
        ? { gateway: llmGateway, glossary: transcriptionGlossaryProvider }
        : {}),
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
          ...(event.jobId ? { jobId: event.jobId } : {}),
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
      // Blocker 12 — encrypt retained raw transcripts at rest. Prefer a
      // dedicated TRANSCRIPT_ENCRYPTION_KEY but fall back to the
      // already-provisioned TENANT_ENCRYPTION_KEY so encryption is active in
      // prod without a new ops step. When neither is set the raw transcript
      // is not retained (no plaintext PII at rest).
      rawTranscriptEncryptionKey:
        process.env.TRANSCRIPT_ENCRYPTION_KEY ?? process.env.TENANT_ENCRYPTION_KEY,
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

  // ── Image post-process worker (RV-006): strips EXIF, converts
  // HEIC/WEBP→JPEG, generates thumbnails and stamps content hashes for
  // files enqueued after a successful attach. Uses the same storage
  // provider/bucket as the upload path; on the dev provider (which
  // discards bytes) the worker no-ops gracefully.
  const imagePostProcessWorker = createImagePostProcessWorker({
    fileRepo,
    storage: storageProvider,
    processor: createSharpImageProcessor(),
  });
  workerRegistry.set(
    imagePostProcessWorker.type,
    imagePostProcessWorker as import('./queues/queue').WorkerHandler<unknown>
  );

  // ── Onboarding lifecycle emails. The frontend origin backs the CTA links
  // (/onboarding, /settings) and the support address backs the footer ask;
  // shared by the welcome worker (below) and the setup/trial sweeps.
  const lifecycleEmailAppBaseUrl = process.env.APP_PUBLIC_URL ?? 'http://localhost:5173';
  const lifecycleEmailSupportEmail =
    process.env.SUPPORT_EMAIL ?? process.env.SENDGRID_REPLY_TO_EMAIL ?? 'support@rivet.ai';
  const lifecycleEmailWorker = createLifecycleEmailWorker({
    delivery: messageDelivery,
    pool: pool ?? null,
    settingsRepo,
    auditRepo,
    appBaseUrl: lifecycleEmailAppBaseUrl,
    supportEmail: lifecycleEmailSupportEmail,
    logger: createLogger({
      service: 'lifecycle-email-worker',
      environment: process.env.NODE_ENV || 'development',
    }),
  });
  workerRegistry.set(
    lifecycleEmailWorker.type,
    lifecycleEmailWorker as import('./queues/queue').WorkerHandler<unknown>
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

  // ── P6-028 wiring — tech "I'm out today" keyword handler ─────────────────
  // Registers the OUT|SICK|UNAVAILABLE inbound-SMS keywords with the P2-034
  // dispatcher so a verified technician's "OUT" text marks the day unavailable
  // and drafts owner-gated reschedule proposals end-to-end. Placed HERE,
  // AFTER proposalRepo (the last-declared dep), because the reschedule path
  // also needs userRepo (852), settingsRepo (885), unavailableBlockRepo (861),
  // appointmentRepo (848), assignmentRepo (849), jobRepo (739), customerRepo
  // (838), auditRepo (914) and the LLM gateway (1043) — all already constructed
  // above. The keyword registry is module-global, so registration order within
  // createApp() is free as long as every dep exists. `overwrite: true` mirrors
  // the STOP/START registrations so re-running createApp() (across test files /
  // multiple bootstraps in one process) re-registers without tripping the
  // duplicate-keyword guard.
  const techStatusTodayRepo = pool
    ? new PgTechStatusTodayRepository(pool)
    : new InMemoryTechStatusTodayRepository();
  registerTechStatusKeywords(
    {
      userRepo,
      settingsRepo,
      unavailableBlockRepo,
      techStatusTodayRepo,
      auditRepo,
      rescheduleDeps: {
        appointmentRepo,
        assignmentRepo,
        proposalRepo,
        jobRepo,
        customerRepo,
        // Brand-voice customer SMS drafts route through the shared LLM gateway
        // (CLAUDE.md: all AI calls go through the gateway); tone is read from
        // tenant_settings via settingsRepo. UB-A3: owner standing instructions
        // (keyed on the brand-voice intent) adjust draft content.
        brandVoiceDeps: { gateway: llmGateway, settingsRepo, standingInstructionRepo },
      },
    },
    { overwrite: true },
  );

  // ── P2-034 wiring — SMS approval transport ───────────────────────────────
  // Outbound: the unsupervised queue_and_sms body now carries reply tokens
  // (Y / N / EDIT) and each render is persisted to proposal_sms_events.
  // Inbound: the owner's reply (verified against tenant_settings.owner_phone)
  // approves/rejects through the EXISTING proposal actions, or opens a
  // 10-minute edit session interpreted by the LLM gateway and re-rendered
  // for re-approval. Free text with no context gets one clarification nudge.
  const proposalSmsEventRepo = pool
    ? new PgProposalSmsEventRepository(pool)
    : new InMemoryProposalSmsEventRepository();
  registerProposalReplySms(
    {
      proposalRepo,
      smsEventRepo: proposalSmsEventRepo,
      settingsRepo,
      userRepo,
      auditRepo,
      appointmentRepo,
      ...(oneTapSmsSender ? { sendSms: oneTapSmsSender } : {}),
      interpretEdit: createLlmEditInterpreter(llmGateway),
    },
    { overwrite: true },
    // YES is also the compliance opt-in keyword — registerProposalReplySms
    // upgrades the plain START handler to the opt-in-first composite.
    { dncRepo },
  );

  const recordProposalSmsRender = async (args: {
    tenantId: string;
    proposalId: string;
    body: string;
    // RV-074 — low/very_low-confidence sends anchor as
    // `review_required_rendered` so the "reply N to reject" they solicit
    // targets THIS proposal, not an older render.
    kind: OutboundAnchorKind;
  }): Promise<void> => {
    await proposalSmsEventRepo.create(
      createProposalSmsEvent({
        tenantId: args.tenantId,
        proposalId: args.proposalId,
        direction: 'outbound',
        kind: args.kind,
        body: args.body,
      }),
    );
  };
  // Voice intents (add_note, send_invoice, record_payment) execute
  // against real domain repositories. Invoice delivery routes through
  // SendService when configured; resolveInvoiceDeliveryProvider throws at
  // boot in prod/staging without credentials unless delivery is explicitly
  // opted out (EMAIL_ENABLED=false + TELEPHONY_ENABLED=false); otherwise
  // dev/test uses Noop.
  const deliveryOptedOut =
    process.env.EMAIL_ENABLED === 'false' && process.env.TELEPHONY_ENABLED === 'false';
  const invoiceDeliveryProvider = resolveInvoiceDeliveryProvider({
    nodeEnv: config.NODE_ENV,
    sendService,
    allowNoopInProduction: deliveryOptedOut,
  });
  const estimateDeliveryProvider = resolveEstimateDeliveryProvider({
    nodeEnv: config.NODE_ENV,
    sendService,
    allowNoopInProduction: deliveryOptedOut,
  });
  const dispatchAnalyticsRepo = pool
    ? new PgDispatchAnalyticsRepository(pool)
    : new InMemoryDispatchAnalyticsRepository();
  const transactionalCommsLogger = createLogger({
    service: 'transactional-comms',
    environment: process.env.NODE_ENV || 'development',
  });
  const transactionalComms = messageDelivery
    ? new TransactionalCommsService({
        delivery: messageDelivery,
        appointmentRepo,
        jobRepo,
        customerRepo,
        settingsRepo,
        invoiceRepo,
        dispatchRepo,
        // T4-F01 — claim-before-send pool for sendCustomerMessage's gate.
        pool: pool ?? null,
        logger: transactionalCommsLogger,
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
    ? createCredentialResolver({ pool, directPool })
    : null;
  const serviceCreditRepo = pool ? new PgServiceCreditRepository(pool) : undefined;
  // Reviewer→customer matcher + brand voice for review-response drafting.
  // Hoisted here (was next to the polling worker at the bottom of createApp)
  // because the voice-action-router's respond_to_review on-ramp (U3) needs
  // the same instances; the polling worker below reuses them.
  const googleReviewsCustomerLoader = pool ? new PgCustomerLoader(pool) : null;
  // Real tenant-tone loader (was NoopBrandVoiceLoader — a P4-015 placeholder
  // that shipped but was never swapped, so review responses ignored the shop's
  // voice + banned_phrases). Reads tenant_settings.brand_voice, failure-soft.
  const googleReviewsBrandVoiceLoader = new SettingsBrandVoiceLoader(settingsRepo);
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
    ? new TwilioDelayNotificationService(messageDelivery, dispatchRepo, customerRepo)
    : new NoopDelayNotificationService();
  const executionHandlers = createExecutionHandlerRegistry({
    customerRepo,
    jobRepo,
    // B7 (money-loss fix) — update_job routes status changes through
    // transitionJobStatus (timeline + completedAt) and runs completion effects.
    timelineRepo,
    timeEntryRepo,
    locationRepo,
    appointmentRepo,
    assignmentRepo,
    invoiceRepo,
    estimateRepo,
    settingsRepo,
    scheduleRepo: invoiceScheduleRepo,
    proposalRepo,
    // Collections cadence — dunning ledger for MANUAL reminder execution dedup.
    dunningEventRepo,
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
    // RV-141 — emergency_dispatch owner page goes through the same
    // delivery provider as every other dispatch SMS.
    ...(messageDelivery ? { emergencySmsSender: messageDelivery } : {}),
    // RV-086 — send_estimate_nudge: re-send via the unified SendService
    // path; message_dispatches backs the 48h cooldown.
    ...(sendService ? { sendService } : {}),
    // T4-F01 — claim-before-send pool for send_estimate_nudge's
    // dispatchEstimateNudge call (see estimates/estimate-nudge.ts).
    pool: pool ?? null,
    dispatchRepo,
    // UB-A2 — create_standing_instruction inserts via the UB-A1 repo
    // (in-memory fallback when no pool, same as the routes above).
    standingInstructionRepo,
    // WS20 — update_catalog_item writes the owner-ratified SKU price.
    catalogRepo,
    entityAliasRepo,
    // WS3 — voice update_customer consent parity: a spoken smsConsent toggle
    // appends to the consent ledger in the same transaction as the customer
    // update + audit event (matching the authenticated route path).
    consentEventRepo,
  });
  // U5 / WS3 — fail boot loudly if a voice-reachable persist handler is
  // degraded (would return success without saving). Every voice-reachable
  // persistence handler now reports isFullyWired (WS3), so a missing repo for
  // any of them aborts boot rather than silently no-opping voice traffic.
  assertVoiceHandlersWired(
    executionHandlers,
    Object.values(INTENT_TO_PROPOSAL_TYPE),
    { poolConfigured: Boolean(pool), logger: workerLogger },
  );
  // §11 H1: IdempotencyGuard + advisory lock per (tenant, key). Keys
  // default to `proposal-run:{tenant}:{id}` when callers omit one.
  const proposalIdempotencyLock = pool
    ? new PgIdempotencyLockProvider(directPool ?? pool)
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
  // Rivet P2 F-1: late-bound supervisor spend recorder. The
  // SupervisorPolicyService is constructed further down (it needs the
  // feature-flag repo built near the end of createApp); the executor's
  // onExecuted callback closes over this slot so executed money-class
  // spend feeds the daily budget counter once the service is wired.
  // Null until then — and recordExecutedProposalSpend never throws, so
  // this can never break the execution path.
  let supervisorSpendRecorder:
    | ((tenantId: string, proposalId: string) => Promise<void>)
    | null = null;
  // U7 — push the owner a "done" notification when an approved proposal
  // executes. Late-bound: the device-token repo + push provider are built
  // further down. Null until then, and the notifier swallows its own errors,
  // so this can never break the execution path.
  let notifyExecutedPush:
    | ((tenantId: string, proposalId: string) => Promise<void>)
    | null = null;
  // U7 — "needs approval" push, wired into the voice-action-router worker's
  // unsupervised-routing deps (built above the device-token repo). Same
  // late-bound pattern; the worker reads it through a stable wrapper.
  let notifyNeedsApprovalPush:
    | ((args: { tenantId: string; proposal: { id: string; summary: string } }) => Promise<void>)
    | null = null;
  const proposalExecutor = new ProposalExecutor(
    executionHandlers,
    proposalRepo,
    proposalIdempotencyGuard,
    // WS11 — execution outcomes write proposal.executed/execution_failed
    // audit events atomically with the state change (executeAudited).
    auditRepo,
    {
      executionRepo: proposalExecutionRepo,
      onExecuted: async (event) => {
        if (event.status !== 'succeeded') return;
        // Rivet P2 F-1: executed money-class spend increments the daily
        // budget counter. Failure-isolated twice over — the recorder
        // never throws, and the executor's onExecuted is failure-soft.
        if (supervisorSpendRecorder) {
          await supervisorSpendRecorder(event.tenantId, event.proposalId);
        }
        // U7 — "done" push to the owner's devices. The notifier is
        // failure-isolated internally; onExecuted is failure-soft too.
        if (notifyExecutedPush) {
          await notifyExecutedPush(event.tenantId, event.proposalId);
        }
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
        // U7 — record structured correction lessons (labor rate / banned
        // phrase) from the drafted-vs-executed diff, cascading the change
        // forward within the day so the digest "what I learned" is real and
        // the next same-day draft reflects it. Failure-soft: a lesson error
        // must never break execution.
        try {
          await recordCorrectionLessonsOnExecution(
            { tenantId: event.tenantId, proposalId: event.proposalId },
            {
              proposalRepo,
              proposalExecutionRepo,
              settingsRepo,
              lessonRepo: correctionLessonRepo,
              catalogRepo,
              ports: correctionConfigPorts,
              auditRepo,
            },
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('app: failed to record correction lessons', {
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
    undefined, // internalAlertSink — keep the default no-op sink
    dncRepo, // Story 10.3 — DNC suppression on the SMS delay/en-route path
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
  // Blocker 5 — background-loop lifecycle + leader election.
  //
  // (1) Every setInterval below is registered here so graceful shutdown can
  //     clearInterval them before the pg pool drains; otherwise a tick fires
  //     mid-teardown and throws on a closed pool. `shuttingDown` also stops
  //     leader-gated sweeps from starting new work during shutdown.
  // (2) Tenant-wide sweeps (recurring agreements, overdue invoices,
  //     appointment/estimate reminders, estimate expiry, Google reviews) run
  //     in-process on EVERY instance. On a multi-instance deploy that means
  //     duplicate invoices/reminders/review replies. `runAsLeader` gates each
  //     tick behind a Postgres advisory lock so exactly one instance runs it;
  //     others skip. Single-instance launch (or in-memory dev with no pool)
  //     always runs. The execution worker and queue poll loop are NOT gated —
  //     they are already multi-instance-safe (claimForExecution / FOR UPDATE
  //     SKIP LOCKED) and gating them would needlessly serialize throughput.
  const backgroundIntervals: NodeJS.Timeout[] = [];
  let shuttingDown = false;
  const registerInterval = (handle: NodeJS.Timeout): NodeJS.Timeout => {
    backgroundIntervals.push(handle);
    return handle;
  };
  // WS2 — process-role split. A PROCESS_ROLE=web (or, WS14, PROCESS_ROLE=voice)
  // deploy serves the HTTP/voice/WS surface with ZERO background worker loops
  // so it can never be coupled to (or blocked by) the sweeps/queue drain;
  // 'worker' and 'all' run them. Every worker interval registration below
  // (and the worker-object constructions that exist solely to feed them) is
  // gated on this. Cheap observability intervals (samplePoolMetrics /
  // sampleQueueDepth) stay in ALL roles — a web/voice deploy must still
  // expose its own pool + queue-depth metrics. Leader locks (runAsLeader)
  // make it safe if two instances ever both run 'all'.
  // Explicit allowlist (not `!== 'web'`) so a THIRD non-worker role can
  // never accidentally start running background sweeps by falling through
  // an exclusion list — 'voice' must land here, not in shouldRunWorkers.
  const shouldRunWorkers =
    config.PROCESS_ROLE === 'worker' || config.PROCESS_ROLE === 'all';

  // scale-to-1000 U2c — sample Postgres pool occupancy into /metrics so the
  // saturation signal (waiting climbing while total is pinned at the pool max)
  // is observable. Reads cheap counters off pg.Pool every 5s; cleared on
  // shutdown via registerInterval.
  if (pool) {
    const samplePoolMetrics = () => {
      dbPoolConnections.set({ pool: 'main', state: 'total' }, pool.totalCount);
      dbPoolConnections.set({ pool: 'main', state: 'idle' }, pool.idleCount);
      dbPoolConnections.set({ pool: 'main', state: 'waiting' }, pool.waitingCount);
      if (directPool && directPool !== pool) {
        dbPoolConnections.set({ pool: 'direct', state: 'total' }, directPool.totalCount);
        dbPoolConnections.set({ pool: 'direct', state: 'idle' }, directPool.idleCount);
        dbPoolConnections.set({ pool: 'direct', state: 'waiting' }, directPool.waitingCount);
      }
    };
    samplePoolMetrics();
    registerInterval(setInterval(samplePoolMetrics, 5000));
  }
  const SWEEP_LOCK = {
    recurringAgreements: 590001,
    overdueInvoice: 590002,
    appointmentReminder: 590003,
    estimateReminder: 590004,
    estimateExpiry: 590005,
    googleReviews: 590006,
    batchInvoice: 590007,
    callMeBack: 590008,
    dailyDigest: 590009,
    // RV-132 — recording retention purge. 590010 is reserved by a parallel
    // track; this sweep owns 590011.
    recordingRetention: 590011,
    supervisorAnnotate: 590012,
    accountingSync: 590013,
    // 590014 was shared by the removed P5-020 `digest` sweep and
    // `hfcrWeeklySend` (an advisory-lock collision); the dead worker is gone
    // (U5) so the key is now unique to hfcrWeeklySend.
    hfcrWeeklySend: 590014,
    holdReaper: 590015,
    thankYouSms: 590016,
    setupReminder: 590017,
    trialReminder: 590018,
    // §5.5 — schedule proposal cards expire after 48h.
    proposalExpiry: 590019,
    // Epic 12.6 — weekly feedback email sweep (590019 taken by proposalExpiry on main).
    weeklyFeedback: 590020,
    // PRD US-345 — 24h post-completion review-request sweep.
    reviewRequest: 590021,
    // P8-015 — dropped-call recovery drain. NOTE the collision discipline:
    // every key here must be unique (590014 was once shared by two sweeps —
    // an advisory-lock collision that silently serialized them); 590010
    // remains reserved by a parallel track.
    droppedCallRecovery: 590022,
    // scale-to-1000 C1 — durable job-queue depth sampler (one replica queries
    // the shared _queue_messages/_queue_dlq tables per tick).
    queueDepth: 590023,
    // WS15 — platform SLO monitor (evaluates completion rate / queue
    // staleness / sweep lag and pages the operator on breach).
    sloMonitor: 590024,
  } as const;
  const runAsLeader = async (lockKey: number, work: () => Promise<void>): Promise<void> => {
    if (shuttingDown) return;
    if (!pool) {
      // In-memory dev: no coordination needed (sweeps no-op with no tenants).
      await work();
      // WS15 — sweep heartbeat (see below for the pool path).
      recordSweepSuccess(String(lockKey));
      return;
    }
    // Leader election holds a SESSION advisory lock across work(), so it must
    // run on a direct (non-PgBouncer) connection — see createDirectPool. `pool`
    // is non-null here (guarded above), so `directPool ?? pool` is defined.
    const client = await (directPool ?? pool).connect();
    try {
      const res = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [lockKey],
      );
      if (!res.rows[0]?.locked) return; // another instance owns this tick
      try {
        await work();
        // WS15 — record the sweep heartbeat on SUCCESS only (a throwing
        // work() must read as lag). Keyed by lock key; the SLO monitor reads
        // the queue-depth sampler's heartbeat as its worker-loop liveness
        // canary. In-process registry — see monitoring/sweep-heartbeats.ts
        // for the multi-replica caveat.
        recordSweepSuccess(String(lockKey));
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      }
    } finally {
      client.release();
    }
  };

  // scale-to-1000 C1 — sample the durable job-queue backlog into /metrics so the
  // committed SLO (PgQueue depth < 1,000 sustained) and the P2 queue-depth alert
  // are observable. Leader-elected: exactly one replica runs the COUNT per tick
  // (the value is global, so N replicas querying would just be waste). Every
  // 15s; failure-soft (a transient DB blip must not crash the interval).
  {
    let queueDepthInFlight = false;
    const sampleQueueDepth = async () => {
      if (queueDepthInFlight) return;
      queueDepthInFlight = true;
      try {
        await runAsLeader(SWEEP_LOCK.queueDepth, async () => {
          const { pending, deadLetter } = await queue.depth();
          pgQueueDepth.set({ queue: 'pending' }, pending);
          pgQueueDepth.set({ queue: 'dead_letter' }, deadLetter);
        });
      } catch {
        // Best-effort telemetry — never let a sampling error break the loop.
      } finally {
        queueDepthInFlight = false;
      }
    };
    void sampleQueueDepth();
    registerInterval(setInterval(() => void sampleQueueDepth(), 15000));
  }

  // WS2 — baseline for the process-role split. samplePoolMetrics +
  // sampleQueueDepth are the only intervals registered above and are cheap
  // observability that runs in EVERY role (incl. PROCESS_ROLE=web); every
  // interval registered after this point is a gated background WORKER loop.
  // `backgroundIntervalCount` (exposed on the returned app) is the count of
  // those worker loops — length minus this baseline — so it is 0 in web role.
  const observabilityIntervalCount = backgroundIntervals.length;

  // WS15 — platform SLO monitor. Evaluates call completion rate (last 60min,
  // voice_sessions terminal outcomes, cross-tenant), queue staleness (pending
  // jobs older than SLO_QUEUE_STALE_MIN), and sweep lag (queue-depth sampler
  // heartbeat age) every 5 minutes, and ALERTS A HUMAN on breach: always a
  // Sentry error event (docs/runbooks/alerting.md routes those to Slack/DM),
  // plus an operator SMS when ALERT_SMS_TO is set (owner-class — bypasses the
  // consent gate). Leader-locked so exactly one replica evaluates/pages per
  // tick; per-rule cooldown (SLO_ALERT_COOLDOWN_MIN) inside alertOperator.
  // Runbook: docs/runbooks/slo-alerts.md.
  if (shouldRunWorkers) {
    const sloLogger = createLogger({
      service: 'slo-monitor',
      environment: process.env.NODE_ENV || 'development',
    });
    const alertOperator = createAlertOperator({
      sentry: sentryClient,
      delivery: messageDelivery,
      alertSmsTo: config.ALERT_SMS_TO,
      cooldownMs: config.SLO_ALERT_COOLDOWN_MIN * 60 * 1000,
      logger: sloLogger,
    });
    const platformSloRepo = pool ? new PgPlatformSloRepository(pool) : null;
    let sloMonitorInFlight = false;
    registerInterval(setInterval(() => {
      if (sloMonitorInFlight) return;
      sloMonitorInFlight = true;
      void runAsLeader(SWEEP_LOCK.sloMonitor, async () => {
        await runSloMonitor({
          // In-memory dev (no pool): zero counts — the completion rule's
          // sample floor keeps it quiet.
          getCallOutcomeCounts: (windowStart) =>
            platformSloRepo
              ? platformSloRepo.endedCallOutcomeCounts(windowStart)
              : Promise.resolve({ total: 0, completedish: 0 }),
          getStalePendingCount: (olderThanSeconds) => queue.stalePendingCount(olderThanSeconds),
          getSweepLastSuccessMs: () => sweepLastSuccessMs(String(SWEEP_LOCK.queueDepth)),
          // WS26 — turn-latency snapshot from the in-process histogram. Only
          // consulted when PROCESS_ROLE=all (the rule's role guard); reading the
          // metric is failure-soft so a prom error never aborts the tick.
          processRole: config.PROCESS_ROLE,
          getTurnLatencySnapshot: async () => {
            try {
              const snap = await voiceTurnLatencyMs.get();
              return estimateTurnLatencyP95(snap.values);
            } catch {
              return null;
            }
          },
          alert: alertOperator,
          thresholds: {
            callCompletionMin: config.SLO_CALL_COMPLETION_MIN,
            callCompletionMinSample: config.SLO_CALL_COMPLETION_MIN_SAMPLE,
            queueStaleMin: config.SLO_QUEUE_STALE_MIN,
            sweepLagMin: config.SLO_SWEEP_LAG_MIN,
            turnLatencyP95Ms: config.SLO_TURN_LATENCY_P95_MS,
            turnLatencyMinSample: config.SLO_TURN_LATENCY_MIN_SAMPLE,
          },
          logger: sloLogger,
        });
      }).catch((err) => {
        sloLogger.error('SLO monitor sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }).finally(() => {
        sloMonitorInFlight = false;
      });
    }, SLO_MONITOR_INTERVAL_MS));
  }

  const executionWorkerLogger = createLogger({
    service: 'execution-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  // In-flight guard (same shape as the queue poll loop's pollInFlight): on a
  // 1s cadence a slow executor otherwise stacks overlapping sweeps, each
  // re-running resetStaleExecuting against the same rows.
  let executionSweepInFlight = false;
  if (shouldRunWorkers) {
    registerInterval(setInterval(async () => {
      if (executionSweepInFlight) return;
      executionSweepInFlight = true;
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
      } finally {
        executionSweepInFlight = false;
      }
    }, 1000));
  }

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
  // Owner-scoped revenue lookup (voice `lookup_revenue`) shares the same
  // money-dashboard repo the /api/reports router uses below. Constructed
  // here (rather than next to the telephony wiring) because the U3 memo
  // answer path needs it in the worker deps a few lines down.
  const moneyDashboardRepo = new PgMoneyDashboardRepository(
    invoiceRepo,
    paymentRepo,
    expenseRepo,
  );
  // RV-062 — shared by the digest worker (writes) and the /api/digests
  // web-view router (reads). Created once here so both wire to the same
  // instance (Pg-backed in prod, in-memory in dev where the sweep no-ops).
  const dailyDigestRepo = pool
    ? new PgDailyDigestRepository(pool)
    : new InMemoryDailyDigestRepository();
  // U3 — DB-authoritative role of a memo's creator for the owner-grade
  // lookup gate (revenue / job profit / pending items / digest). The
  // recording's created_by is the Clerk subject, so the Pg path reuses the
  // SAME membership lookup resolveAuthorization gates requests with; the
  // in-memory dev path matches the users roster by clerk id or row id.
  // A null / inactive membership fails closed to a refusal in the adapter.
  const voiceMemoMembershipLoader = pool ? createAuthorizationLoader(pool) : undefined;
  const resolveVoiceMemberRole = async (
    tenantId: string,
    userId: string,
  ): Promise<string | null> => {
    if (voiceMemoMembershipLoader) {
      const membership = await voiceMemoMembershipLoader(userId, tenantId);
      if (!membership || membership.deleted || membership.status !== 'active') return null;
      return membership.role;
    }
    const users = await userRepo.findByTenant(tenantId);
    const user = users.find((u) => u.clerkUserId === userId || u.id === userId);
    return user?.role ?? null;
  };
  const voiceActionRouterWorker = createVoiceActionRouterWorker({
    gateway: llmGateway,
    proposalRepo,
    // B8 — create_customer draft-time duplicate detection parity: the SAME
    // customerRepo the telephony FSM (twilio-adapter.ts) already uses to
    // build its duplicateLoader, so the worker's create_customer proposals
    // get the identical dedup-aware handler.
    customerRepo,
    ...(customerNegotiationContextProvider ? { customerNegotiationContextProvider } : {}),
    // P2-036 V2 — additive discount engine; fail-closed (dormant until a tenant
    // configures a discount policy via settings).
    settingsRepo,
    negotiationQuoteResolver,
    slotConflictChecker,
    availabilityFinder,
    thresholdResolver,
    tenantSchedulingResolver,
    // UB-D / D-015 — best-effort sink for `autonomous_booking_lane_evaluated`
    // (also serves the U5b negotiation discount audit when that path engages).
    auditRepo,
    // UB-D / D-015 — lane settings; the router consults this ONLY for
    // booking-classified segments.
    autonomousBookingResolver: async (tenantId: string) => {
      const s = await settingsRepo.findByTenant(tenantId);
      if (!s) return undefined;
      return {
        enabled: s.autonomousBookingEnabled ?? false,
        ...(s.autonomousBookingThreshold !== undefined
          ? { threshold: s.autonomousBookingThreshold }
          : {}),
      };
    },
    // D-015 amendment — platform-wide kill switch, checked before tenant
    // opt-in by evaluateAutonomousBookingLane.
    autonomousBookingPlatformDisabled: config.AUTONOMOUS_BOOKING_DISABLED === 'true',
    appointmentRepo,
    // RV-042 — lets update_estimate proposals stamp the acceptance-void
    // marker at creation when they target a currently accepted estimate.
    estimateRepo,
    // P22 — catalog grounding: drafted invoice/estimate line items get
    // priced from the tenant's catalog instead of trusting the LLM.
    catalogRepo,
    // P21-003 — batch_invoice voice on-ramp: enumerates completed-unbilled
    // jobs (findJobsRequiringInvoicing) so "invoice all my completed jobs"
    // mints one batch_invoice proposal. Same repos the batch sweep + digest use.
    invoicingDeps: { jobRepo, invoiceRepo, estimateRepo },
    // Layer 3 — draft-time duplicate-reminder marker for the voice
    // send_payment_reminder on-ramp (best-effort; advisory only).
    dunningEventRepo,
    // P8 — "three Bobs": free-text customer/job references resolve to
    // verified tenant IDs (pg_trgm) before drafting; ambiguous matches
    // become one-tap clarifications. In-memory mode (no pool) skips
    // resolution, same as before.
    ...(pool
      ? {
          entityResolver: entityAliasRepo
            ? new AliasFirstEntityResolver(
                entityAliasRepo,
                new PgEntityResolver(pool),
                pool,
              )
            : new PgEntityResolver(pool),
        }
      : {}),
    // Lets reschedule/cancel/confirm scope appointment resolution to the
    // verified caller's own appointments (appointment → job → customerId).
    jobRepo,
    // §3B/3D/3E — operator voice commands need the same vertical
    // terminology + intake-question disambiguation the customer-facing
    // adapters get. The shim is wired here because the real resolver
    // is built ~280 lines below; once `verticalPromptResolver` is
    // constructed, `operatorVerticalPromptResolver` is assigned and the
    // shim starts returning live data on the next classifier call.
    verticalPromptResolver: operatorVerticalResolverShim,
    // UB-A3 — owner standing instructions injected into drafting prompts.
    // Active list resolved once per request; selection per classified intent
    // happens inside the router. Failure-soft (a repo error drafts without).
    standingInstructionsResolver: (tenantId: string) =>
      standingInstructionRepo.listActive(tenantId),
    extendedIntentsEnabled: voiceExtendedIntentsFlagShim,
    // U3 — respond_to_review on-ramp: recent-review lookup + the SAME
    // build-proposal dep bundle the google-reviews polling worker wires, so
    // voice-initiated drafts are identical to poll-initiated ones.
    ...(googleReviewsReviewRepo ? { reviewRepo: googleReviewsReviewRepo } : {}),
    ...(serviceCreditRepo && googleReviewsCustomerLoader
      ? {
          reviewResponseDraftDeps: {
            llmGateway,
            customerLoader: googleReviewsCustomerLoader,
            brandVoiceLoader: googleReviewsBrandVoiceLoader,
            serviceCreditRepo,
          },
        }
      : {}),
    // P12-004 — unsupervised proposal routing: when no supervisor is
    // present and the tenant routing is queue_and_sms (default), send the
    // owner a one-tap approve SMS with a signed single-use link. Audit
    // event `unsupervised_proposal_routed` fires on every routed proposal.
    unsupervisedRouting: {
      auditRepo,
      ...(oneTapSmsSender ? { sendSms: oneTapSmsSender } : {}),
      // U7 — stable wrapper reads the late-bound notifier at call time (the
      // device-token repo + push provider are built further down).
      notifyPush: async (args) => {
        await notifyNeedsApprovalPush?.(args);
      },
      ...(oneTapSecret ? { secret: oneTapSecret } : {}),
      buildApproveUrl: (token: string) =>
        `${oneTapApiBaseUrl}/public/proposals/one-tap-approve?token=${encodeURIComponent(token)}`,
      // UB-D / D3 — one-tap UNDO link for lane auto-approved bookings
      // (minted with the same one-tap secret).
      buildUndoUrl: (token: string) =>
        `${oneTapApiBaseUrl}/public/proposals/one-tap-undo?token=${encodeURIComponent(token)}`,
      resolveOwnerPhone: resolveUnsupervisedOwnerPhone,
      resolveRouting: async (tenantId: string) =>
        (await settingsRepo.findByTenant(tenantId))?.unsupervisedProposalRouting,
      // P2-034 — persist each outbound render so inbound Y/N/EDIT replies
      // can resolve which proposal the owner is answering.
      recordSmsEvent: recordProposalSmsRender,
    },
    // U3 — E-lane answers on the recorded-memo path: the routed outcome
    // (answer_status) is stamped on the recording row, and lookup intents
    // execute their skill instead of skipping. `voiceRepo` doubles as the
    // memo-creator resolver for the owner-grade authorization gate.
    voiceRepo,
    lookupAnswers: {
      invoiceRepo,
      estimateRepo,
      agreementRepo,
      moneyDashboardRepo,
      dailyDigestRepo,
      dunningConfigRepo,
      timeEntryRepo,
      expenseRepo,
      settingsRepo,
      // Mirrors the telephony adapter wiring: the memo path now writes the
      // same lookup_events analytics rows (keyed by recordingId).
      lookupEvents: lookupEventService,
      resolveMemberRole: resolveVoiceMemberRole,
    },
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
  //
  // In-flight guard: setInterval fires every 250ms regardless of whether the
  // previous async callback has resolved. Without the guard, slow workers
  // (e.g. the image pipeline holding large in-memory buffers) can stack up
  // unbounded concurrent ticks → OOM. The boolean flag ensures at most one
  // tick body runs at a time; overlapping ticks are silently skipped.
  //
  // Scale-to-1000 (P3): claim a BATCH of up to QUEUE_POLL_BATCH_SIZE messages per
  // tick and process them CONCURRENTLY, lifting the single-process ceiling from
  // ~1 msg/250ms (~4/s) to ~batch/250ms while staying multi-replica-safe (each
  // tick claims a disjoint set via FOR UPDATE SKIP LOCKED). The pollInFlight
  // guard still serializes ticks, so peak in-flight work is bounded by the batch
  // size — backpressure unchanged, just wider per tick.
  const QUEUE_POLL_BATCH_SIZE = Math.max(
    1,
    Number(process.env.QUEUE_POLL_BATCH_SIZE) || 10,
  );
  // Process one claimed message end-to-end. Self-contained error handling so one
  // message's failure never rejects the batch (Promise.all below stays settled).
  const handleQueueMessage = async (message: QueueMessage): Promise<void> => {
    try {
      const handler = workerRegistry.get(message.type);
      if (!handler) {
        workerLogger.warn('No worker registered for message type', { type: message.type });
        await queue.delete(message.id);
        return;
      }
      const result = await processMessage(message, handler, workerLogger);
      if (result.success) {
        await queue.delete(message.id);
      } else {
        // T4-F10 — persist the real failure reason on every failed attempt
        // (not only the final one), so an operator inspecting a still-retrying
        // message can see why without digging through logs.
        await queue.recordFailure(message.id, result.error ?? 'unknown error');
        if (message.attempts >= message.maxAttempts) {
          // Fallback string should not normally trigger — processMessage
          // always populates `error` on a failure — but guards moveToDeadLetter
          // against ever receiving undefined.
          await queue.moveToDeadLetter(message, result.error ?? 'max attempts exceeded');
          workerLogger.error('Message moved to DLQ', {
            messageId: message.id,
            type: message.type,
            attempts: message.attempts,
          });
        }
      }
    } catch (err) {
      workerLogger.error('Queue message processing failed', {
        messageId: message.id,
        type: message.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  let pollInFlight = false;
  if (shouldRunWorkers) {
    registerInterval(setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const messages = await queue.receiveBatch(QUEUE_POLL_BATCH_SIZE);
        if (messages.length === 0) return;
        await Promise.all(messages.map((message) => handleQueueMessage(message)));
      } catch (err) {
        workerLogger.error('Queue poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        pollInFlight = false;
      }
    }, 250));
  }

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
    // EE-4 — resolve each line's frozen image_file_id to a signed URL
    // (tenant-scoped via fileRepo.findById). Absent → no thumbnails.
    fileRepo,
    storage: storageProvider,
    stripeConfig: process.env.STRIPE_SECRET_KEY
      ? { apiKey: process.env.STRIPE_SECRET_KEY }
      : null,
    // D2-1d: emit public_estimate.{approved,declined} with the
    // synthetic public:<tokenHash> actor on every public approve/decline.
    auditRepo,
    // Roll up job money state when a lapsed estimate is auto-expired on the
    // public path, so the job doesn't stay stuck in 'estimate_sent'.
    moneyStateDeps: { jobRepo, estimateRepo, invoiceRepo, auditRepo, logger: requestLogger },
    connectAccountResolver: connectService
      ? {
          resolveTenantConnectAccount: async (tenantId: string) => {
            const view = await connectService.getAccount(tenantId);
            if (!view.accountId) return null;
            return { accountId: view.accountId, chargesEnabled: view.chargesEnabled };
          },
        }
      : undefined,
  });
  app.use('/public/estimates', createPublicEstimatesRouter(publicEstimateService));

  // P12-004 — public one-tap proposal approval (token-gated, single-use).
  // The owner SMS from the unsupervised queue_and_sms routing links here.
  // Approval flows through the existing approveProposal path (status guard,
  // undo window, audit, execution worker); the signed nonce is consumed
  // durably via webhook_events so links are single-use across instances.
  app.use(
    '/public/proposals',
    createOneTapApproveRouter({
      proposalRepo,
      auditRepo,
      ...(oneTapSecret ? { secret: oneTapSecret } : {}),
      consumeNonce: consumeOneTapNonce,
      // P2-034 — a pending manual edit request blocks the link too, not
      // just SMS Y replies; both paths approve the same stale payload.
      smsEventRepo: proposalSmsEventRepo,
      // RV-065 — digest "invoice it" tokens: mint a draft_invoice proposal
      // for the bound job (batch-invoice eligibility machinery), then
      // redirect into the standard approve flow.
      invoiceMintDeps: { jobRepo, invoiceRepo, estimateRepo },
    }),
  );

  // UB-D / D3 — public one-tap UNDO for autonomous-lane bookings. Same
  // token-gated posture as the approve route above; still-approved
  // proposals go through undoProposal, executed ones get a compensating
  // cancel + fixed-template, consent/DNC-gated customer apology SMS.
  app.use(
    '/public/proposals',
    createOneTapUndoRouter({
      proposalRepo,
      appointmentRepo,
      auditRepo,
      ...(oneTapSecret ? { secret: oneTapSecret } : {}),
      consumeNonce: consumeOneTapUndoNonce,
      jobRepo,
      customerRepo,
      ...(messageDelivery
        ? {
            customerMessageDeps: {
              delivery: messageDelivery,
              dispatchRepo,
              // T4-F01 — claim-before-send pool for the apology SMS.
              pool: pool ?? null,
              logger: transactionalCommsLogger,
            },
          }
        : {}),
    }),
  );

  // Public unauthenticated invoice payment flow (token-authenticated).
  // Stripe Payment Link creation is enabled when STRIPE_SECRET_KEY is set.
  // Tier 4 (Payment methods — PR 2). When the connectService is
  // wired AND the tenant has an active Connect account with charges
  // enabled, payments route directly to the tenant's account via
  // the Stripe-Account header. Without it, payments stay on the
  // legacy platform path. Shared by the invoice service and the portal
  // save-card flow (#6 phase 4) — both must scope Stripe calls to the
  // same connected account.
  const connectAccountResolver = connectService
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
    : undefined;
  const publicInvoiceService = new PublicInvoiceService({
    paymentLinkProvider,
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
    connectAccountResolver,
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
      // #6 phase 4 — card-on-file for membership auto-billing.
      customerPaymentMethodRepo,
      stripeConfig: process.env.STRIPE_SECRET_KEY
        ? { apiKey: process.env.STRIPE_SECRET_KEY }
        : undefined,
      connectAccountResolver,
    }),
  );

  // Public, token-less online booking — the prospect acquisition funnel
  // (Jobber "Online Booking" parity). Mounted BEFORE the global /api Clerk
  // auth: there is no session, the tenant is the UUID in the path (same as
  // public-intake). A booking never auto-confirms — it creates a held
  // appointment + `create_booking` proposal for the owner to approve.
  app.use(
    '/api/public/booking',
    // Stricter than the global /api limiter: an unauthenticated write path that
    // creates customers/jobs/appointments + holds calendar slots. Mirrors the
    // /public/intake limiter (booking is heavier, so a touch tighter).
    rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    createPublicBookingRouter({
      tenantRepo: intakeTenantRepo,
      customerRepo,
      locationRepo,
      jobRepo,
      appointmentRepo,
      proposalRepo,
      auditRepo,
      assignmentRepo,
      settingsRepo,
      transactionRunner: pool
        ? new PgTenantTransactionRunner(pool)
        : new InMemoryTransactionRunner(),
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
      connectAccountResolver,
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
    // Feature 5 — seed a 7-day availability template from the connected
    // calendar in the OAuth callback. Pool-gated (skipped in-memory).
    ...(pool ? { pool } : {}),
  };
  app.use(
    '/api/calendar-integrations',
    createCalendarOAuthCallbackRouter(calendarRouterDeps),
  );

  // F17 / P15-001 — QuickBooks accounting OAuth callback (unauthenticated).
  const accountingIntegrationRepo = pool
    ? new PgAccountingIntegrationRepository(pool)
    : new InMemoryAccountingIntegrationRepository();
  const accountingSyncLogRepo = pool
    ? new PgAccountingSyncLogRepository(pool)
    : new InMemoryAccountingSyncLogRepository();
  const accountingOAuthStateRepo = pool
    ? new PgAccountingOAuthStateRepository(pool)
    : new InMemoryAccountingOAuthStateRepository();
  const qboConfig = resolveQuickBooksOAuthConfig(googleApiUrl);
  const integrationsRouterDeps = {
    integrationRepo: accountingIntegrationRepo,
    syncLogRepo: accountingSyncLogRepo,
    oauthStateRepo: accountingOAuthStateRepo,
    invoiceRepo,
    customerRepo,
    jobRepo,
    qboConfig,
    appBaseUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:5173',
    auditRepo,
    logger: createLogger({
      service: 'accounting-integrations',
      environment: process.env.NODE_ENV ?? 'development',
    }),
  };
  app.use(
    '/api/integrations',
    createIntegrationsOAuthCallbackRouter(integrationsRouterDeps),
  );

  // ── Twilio telephony webhooks (P8-011) ────────────────────────────────────
  // Mounted under /api/telephony but BEFORE the Clerk auth middleware so
  // Twilio's signed POSTs aren't rejected for missing a Clerk session.
  // Authentication is enforced inside the router via X-Twilio-Signature
  // verification (twilio-signature.ts).
  // Single shared voice session store: in-app and telephony both create
  // sessions in the same VoiceSessionStore so the FSM/cost-tracker pool
  // is uniform across channels. Process-local; idle-reaped via setInterval.
  // U3d — voice event fan-out across replicas. Double-gated: REDIS_URL must be
  // set AND VOICE_FANOUT_ENABLED=true (dark-launch switch); otherwise a no-op
  // transport preserves single-replica behavior. Additive + best-effort: the
  // in-process EventEmitter stays the synchronous same-replica path.
  const voiceEventTransport = createVoiceEventTransport(
    process.env.VOICE_FANOUT_ENABLED === 'true' ? process.env.REDIS_URL : undefined,
  );
  const voiceSessionStore = new VoiceSessionStore({ transport: voiceEventTransport });
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
    ['painting', createPaintingPack()],
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
  // moneyDashboardRepo / dailyDigestRepo are constructed further up (U3 —
  // the voice-action-router worker's E-lane answer deps need them before
  // this telephony wiring block).
  // RV-115/RV-116 — durable dropped-call recovery: the scheduler persists
  // the FSM context snapshot at termination; the resume handler picks the
  // thread back up when the caller replies to the recovery SMS.
  const droppedCallRecoveryRepo = pool
    ? new PgDroppedCallRecoveryRepository(pool)
    : new InMemoryDroppedCallRecoveryRepository();
  const droppedCallScheduler = new DroppedCallScheduler(
    droppedCallRecoveryRepo,
    createLogger({
      service: 'sms.dropped-call-recovery',
      environment: process.env.NODE_ENV || 'development',
    }),
  );
  if (messageDelivery) {
    registerRecoveryResumeHandler(
      createDroppedCallResumeHandler({
        recoveryRepo: droppedCallRecoveryRepo,
        proposalRepo,
        callMeBackRepo,
        // Customer-class: recovery reply to the dropped caller. Resolve the
        // caller's consent by phone; unknown/ambiguous → fail closed via the gate.
        sendSms: async (args: { to: string; body: string; tenantId?: string }) => {
          const consent = args.tenantId
            ? await resolveCustomerConsentByPhone(args.tenantId, args.to)
            : undefined;
          return messageDelivery.sendSms({
            to: args.to,
            body: args.body,
            ...(args.tenantId ? { tenantId: args.tenantId } : {}),
            recipientClass: 'customer',
            ...(consent ? { consent } : {}),
          });
        },
        auditRepo,
        businessName: process.env.TWILIO_BUSINESS_NAME ?? 'our team',
      }),
      { overwrite: true },
    );
    // N-003 (P2-036) — inbound-SMS negotiation guardrail. Runs last; only
    // fires on a customer negotiation ask no other handler claimed. Declines
    // to negotiate: drafts an owner callback + replies with a brand-voiced
    // holding line.
    const resolveNegotiationCustomerContext = async (tenantId: string, phoneE164: string) => {
      if (!customerNegotiationContextProvider) return null;
      try {
        const matches = await customerRepo.findByPhoneNormalized(tenantId, normalizePhone(phoneE164));
        if (matches.length !== 1) return null; // zero or many matches → no silent guess
        return await customerNegotiationContextProvider.getContext(tenantId, matches[0].id);
      } catch {
        return null;
      }
    };
    // P2-036 V2 — phone → single-match customer → discount evaluation (fail-
    // closed; null when unconfigured / no quote / unresolved phone).
    const evaluateNegotiationDiscountForPhone = async (
      tenantId: string,
      phoneE164: string,
      askText: string,
    ) => {
      try {
        const matches = await customerRepo.findByPhoneNormalized(tenantId, normalizePhone(phoneE164));
        if (matches.length !== 1) return null;
        return await evaluateNegotiationDiscount({
          tenantId,
          customerId: matches[0].id,
          askText,
          settingsRepo,
          quoteResolver: negotiationQuoteResolver,
        });
      } catch {
        return null;
      }
    };
    registerNegotiationHandler(
      createInboundNegotiationHandler({
        proposalRepo,
        resolveCustomerContext: resolveNegotiationCustomerContext,
        evaluateDiscount: evaluateNegotiationDiscountForPhone,
        // Customer-class: holding-line reply to the negotiating customer.
        sendSms: async (args: { to: string; body: string; tenantId?: string }) => {
          const consent = args.tenantId
            ? await resolveCustomerConsentByPhone(args.tenantId, args.to)
            : undefined;
          return messageDelivery.sendSms({
            to: args.to,
            body: args.body,
            ...(args.tenantId ? { tenantId: args.tenantId } : {}),
            recipientClass: 'customer',
            ...(consent ? { consent } : {}),
          });
        },
        auditRepo,
        resolveBrandContext: async (tenantId: string) => {
          const settings = await settingsRepo.findByTenant(tenantId);
          return {
            ...(settings?.brandVoice ? { brandVoice: settings.brandVoice } : {}),
            ...(settings?.businessName ? { businessName: settings.businessName } : {}),
          };
        },
      }),
      { overwrite: true },
    );
  }

  // U4 (CRM Jobber parity, Phase 2) — capture-all inbound SMS. Registered
  // unconditionally (it never sends, so it doesn't need messageDelivery) and
  // LAST in the dispatcher chain: any customer text no keyword/fallback/
  // recovery/negotiation handler claimed is threaded onto the sender's
  // conversation instead of being dropped, so it surfaces in the unified inbox.
  registerCaptureHandler(
    createInboundCaptureHandler({
      conversationRepo,
      customerRepo,
      leadRepo,
      auditRepo,
      logger: requestLogger,
    }),
    { overwrite: true },
  );

  // RV-130 — the consent ledger (constructed above, before the SMS gate)
  // appends implicit recording consent at disclosure and revocations on a
  // "stop recording" objection; the recording control pauses the live
  // recording.
  // Story 10.6 — register STOP/START now that DNC, the consent ledger, and the
  // customer repo all exist, so an opt-out updates every store at once.
  registerKeywordHandler(
    buildStopKeywordHandler({ dncRepo, consentRepo: consentEventRepo, customerRepo, pool }),
    { overwrite: true },
  );
  registerKeywordHandler(
    buildStartKeywordHandler({ dncRepo, consentRepo: consentEventRepo, customerRepo, pool }),
    { overwrite: true },
  );
  const twilioRecordingControl =
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
      ? new TwilioRecordingControl(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN,
        )
      : undefined;

  // Platform feature flags. Hoisted above the voice wiring so the
  // per-tenant flag repo (RV-001 / RV-122) can gate voice features.
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
    // N-011 — dark-launch the Brand-Voice Configurator. Default OFF; seeded so
    // it appears in the admin UI. Idempotent (only seeds when missing).
    try {
      const { BRAND_VOICE_CONFIGURATOR_FLAG } = await import('./tenants/brand/brand-voice');
      if (!(await featureFlagRepo.get(BRAND_VOICE_CONFIGURATOR_FLAG))) {
        await featureFlagRepo.upsert({
          name: BRAND_VOICE_CONFIGURATOR_FLAG,
          enabled: false,
          description:
            'N-011 Brand-Voice Configurator: six-field brand voice capture, ' +
            'versioning/rollback, and version-tagged utterances.',
        });
      }
    } catch {
      /* fire-and-forget */
    }
    await hydrateStoreFromRepository(featureFlagStore, featureFlagRepo);
  })();
  // RV-001 follow-up #8 / RV-122 — per-tenant feature-flag resolution
  // (tenant_feature_flags override → platform flag → false). This is the
  // first production wiring of PgTenantFeatureFlagRepository.
  const tenantFeatureFlags = pool
    ? new PgTenantFeatureFlagRepository(pool, featureFlagRepo)
    : null;
  const isFlagEnabledForTenant = async (
    tenantId: string,
    flagKey: string,
  ): Promise<boolean> => {
    if (tenantFeatureFlags) {
      return tenantFeatureFlags.isEnabledForTenant(tenantId, flagKey);
    }
    // In-memory dev: no tenant override table — evaluate the platform flag.
    const flag = await featureFlagRepo.get(flagKey);
    if (!flag) return false;
    return isFeatureEnabled(new InMemoryFeatureFlagStore([flag]), flagKey, {
      environment: process.env.NODE_ENV ?? 'development',
      tenantId,
    });
  };
  voiceExtendedIntentsFlagResolver = (tenantId: string) =>
    isFlagEnabledForTenant(tenantId, 'voice_extended_intents');

  // WS18d — assembled as a VARIABLE (not an inline literal) deliberately: the
  // adapter spreads its deps into createVoiceTurnProcessor, and the processor-
  // only WS18 keys below (consentEventRepo, autonomousClose) are not part of
  // TwilioAdapterDeps — a literal would trip TS excess-property checking. The
  // clean fix (extending TwilioAdapterDeps) belongs to the WS16 owner of
  // twilio-adapter.ts; this keeps that file untouched while the processor
  // receives its full dep surface at runtime.
  const twilioAdapterDeps = {
    store: voiceSessionStore,
    gateway: llmGateway,
    ...(pool ? { pool } : {}),
    proposalRepo,
    ...(customerNegotiationContextProvider ? { customerNegotiationContextProvider } : {}),
    // P2-036 V2 — live-call discount engine (fail-closed; dormant until a tenant
    // configures a discount policy). settingsRepo is wired below.
    negotiationQuoteResolver,
    auditRepo,
    onCallRepo: sharedOnCallRepo,
    callControl: telephonyCallControl,
    dispatcherPhoneResolver: createUserPhoneDispatcherResolver(userRepo),
    businessPhoneFallbackResolver: createBusinessPhoneFallback(settingsRepo),
    settingsRepo,
    // RV-070 — owner-line recognition: backup supervisor mobile lookup
    // (mirrors the SMS reply transport's approver identity).
    userRepo,
    // RV-071 — voice approval channel: pending-edit parity guard + the
    // one-tap SMS fallback for refused money/irreversible approvals
    // (same secret/sender/URL/owner-phone wiring as P12-004).
    smsEventRepo: proposalSmsEventRepo,
    voiceApprovalOneTap: {
      ...(oneTapSmsSender ? { sendSms: oneTapSmsSender } : {}),
      ...(oneTapSecret ? { secret: oneTapSecret } : {}),
      buildApproveUrl: (token: string) =>
        `${oneTapApiBaseUrl}/public/proposals/one-tap-approve?token=${encodeURIComponent(token)}`,
      resolveOwnerPhone: resolveUnsupervisedOwnerPhone,
      recordSmsEvent: recordProposalSmsRender,
    },
    whisperCache: sharedWhisperCache,
    ...(messageDelivery
      ? {
          deliveryProvider: {
            // Owner/dispatcher patch + on-call notify SMS — never customer-gated.
            sendSms: (args: { to: string; body: string }) =>
              messageDelivery.sendSms({ to: args.to, body: args.body, recipientClass: 'owner' }),
          },
        }
      : {}),
    // RV-143 — durable tail for the emergency page-retry ladder.
    callMeBackRepo,
    // UC-5a — the ladder itself is durable: each page is a delayed job on
    // the shared queue, consumed by the telephony.emergency_page worker
    // registered below.
    queue,
    // RV-115 — FSM context snapshot into dropped_call_recoveries.context.
    droppedCallScheduler,
    // RV-130 — consent ledger + live recording pause on objection.
    consentEvents: consentEventRepo,
    ...(twilioRecordingControl ? { recordingControl: twilioRecordingControl } : {}),
    leadRepo,
    // P11-001: lookup-skill family wiring. Without these the adapter
    // falls back to a "let me get a person to help" line on lookup_*
    // intents — the call doesn't crash, but the read-only path is
    // unavailable. agreementRepo lives a few hundred lines down.
    jobRepo,
    appointmentRepo,
    invoiceRepo,
    estimateRepo,
    customerRepo,
    // Handoff context pack — tags hydrate into escalate whisper/SMS/panel.
    tagRepo: customerTagRepo,
    // Inbound-call timeline logging — an identified caller's call is threaded
    // onto their conversation, mirroring the outbound click-to-call log.
    conversationRepo,
    agreementRepo,
    moneyDashboardRepo,
    catalogRepo,
    dailyDigestRepo,
    dunningConfigRepo,
    droppedCallRecoveryRepo,
    availabilityFinder,
    lookupEvents: lookupEventService,
    extendedIntentsEnabled: voiceExtendedIntentsFlagShim,
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
    // U3 — share the same TenantGlossaryProvider instance (and its per-
    // tenant TTL cache) between the Gather-hints path and the
    // transcription-correction worker, instead of the adapter lazily
    // building its own fallback provider. No LLM dependency here (unlike
    // the correction pass above, which is gated on AI_PROVIDER_API_KEY) —
    // wired unconditionally so Gather hints work even in a keyless-gateway
    // deployment.
    sttHintsResolver: (tenantId: string) => transcriptionGlossaryProvider.termsForTenant(tenantId),
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
            // Activation milestone — fire first_real_call_received (+ email +
            // banner state) on the first real inbound call after go-live.
            // Runs AFTER auto-go-live so voice_agent_live_at is already set
            // for the test call. Failure-soft: must never block session end.
            try {
              await maybeFireFirstRealCallActivation(
                {
                  pool,
                  auditRepo,
                  ...(messageDelivery
                    ? {
                        sendEmail: (msg) =>
                          messageDelivery.sendEmail({
                            to: msg.to,
                            subject: msg.subject,
                            text: msg.text,
                            ...(msg.html ? { html: msg.html } : {}),
                          }),
                      }
                    : {}),
                },
                { tenantId, channel },
              );
            } catch {
              // swallow — activation analytics must not break call teardown
            }
          },
        }
      : {}),
    // ── WS18 processor-only deps (flow through the adapter's spread into
    //    createVoiceTurnProcessor; see the variable-assembly note above) ──
    // WS18b — on-call SMS consent capture (ledger + customers.sms_consent).
    consentEventRepo,
    // QUALITY-2026-07-12 WS2 — on-call close PREPARATION (supersedes the D-018
    // autonomous close): both platform kill switches and the owner SMS/one-tap
    // approve wiring for the staged owner-approval chain. No executor — nothing
    // is approved or executed by the system; the owner's one-tap is the only
    // approval.
    autonomousClose: {
      platformDisabled: config.AUTONOMOUS_CLOSE_DISABLED === 'true',
      bookingPlatformDisabled: config.AUTONOMOUS_BOOKING_DISABLED === 'true',
      ownerPhoneResolver: resolveUnsupervisedOwnerPhone,
      ...(oneTapSmsSender ? { sendOwnerSms: oneTapSmsSender } : {}),
      ...(oneTapSecret ? { oneTapSecret } : {}),
      buildApproveUrl: (token: string) =>
        `${oneTapApiBaseUrl}/public/proposals/one-tap-approve?token=${encodeURIComponent(token)}`,
    },
  };
  const twilioAdapter = new TwilioGatherAdapter(twilioAdapterDeps);

  // UC-5a — consumer half of the durable emergency page-retry ladder: the
  // adapter above enqueues delayed `telephony.emergency_page` jobs; this
  // worker (dispatched by the unified queue poll loop) re-checks resolution
  // against the live store and then the persisted voice_sessions row (so a
  // transfer answered on another replica still cancels the ladder), pages
  // the owner, and lands the durable call_me_back tail on exhaustion.
  // Registered only when an SMS provider exists — the adapter's arm gate
  // mirrors this, so no job is ever enqueued without its consumer.
  if (messageDelivery) {
    const emergencyPageWorker = createEmergencyPageWorker({
      queue,
      // Emergency page → owner / on-call. Never customer-gated.
      sendSms: (args: { to: string; body: string }) =>
        messageDelivery.sendSms({ to: args.to, body: args.body, recipientClass: 'owner' }),
      resolvePagePhone: async (tenantId: string) => {
        try {
          const settings = await settingsRepo.findByTenant(tenantId);
          return settings?.ownerPhone ?? settings?.transferNumber ?? null;
        } catch {
          return null;
        }
      },
      isResolved: createEmergencyPageResolvedCheck({
        store: voiceSessionStore,
        voiceSessionRepo,
      }),
      callMeBackRepo,
      auditRepo,
    });
    workerRegistry.set(
      emergencyPageWorker.type,
      emergencyPageWorker as import('./queues/queue').WorkerHandler<unknown>,
    );
  }

  // P8-012 / WS7: feature flag the Media Streams (live audio) path. `'false'`
  // (kill switch) → the existing Gather adapter is the only telephony surface.
  // `'true'` → forced on (validated stack). Unset/`'auto'` → on iff the full
  // ElevenLabs+Deepgram streaming stack is present. When on, /voice returns a
  // <Connect><Stream/> TwiML and audio flows over the WebSocket attached below.
  const mediaStreamsEnabled = resolveMediaStreamsEnabled(process.env);

  // WS3 (voice ingestion resilience) — shared realtime health signals. The
  // /voice TwiML branch reads the circuit (isOpen) and prereq probe to decide
  // Stream vs Gather; the mediastream adapter feeds the same circuit instance.
  // `realtimeCapabilities` is the single source the /health canary AND the
  // route's prereq gate both derive from (STT + TTS configured), so they never
  // drift.
  const realtimeCapabilities = (): { ttsEnabled: boolean; sttEnabled: boolean } => ({
    ttsEnabled: !!process.env.ELEVENLABS_API_KEY || !!config.AI_PROVIDER_API_KEY,
    sttEnabled: !!process.env.DEEPGRAM_API_KEY,
  });
  const realtimeHealthCircuit = new RealtimeHealthCircuit();

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
      } catch (err) {
        // Roll back before release: the outer catch swallows the error to a
        // fallback, so without this the connection would silently return to
        // the pool with the transaction (and system_lookup GUC) still open.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
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
      } catch (err) {
        // Same dirty-connection guard as resolveTwilioAuthTokenForSubaccount.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
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
      // WS8 — a worker-role process never attaches the media-streams WS
      // handler (see the role gate on attachMediaStreamServer below), so its
      // /voice must never emit <Connect><Stream/> pointing at a socket this
      // process will reject — degrade to Gather instead. WS14 — 'voice' is
      // NOT excluded here (only 'worker' is): the dedicated voice service
      // attaches the WS the same as 'web' does, so its /voice keeps emitting
      // <Connect><Stream/> normally.
      mediaStreamsEnabled: mediaStreamsEnabled && config.PROCESS_ROLE !== 'worker',
      // WS7 — mid-call degrade to Gather: /voice/gather-fallback resolves the
      // live session by CallSid to continue the SAME FSM state on Gather.
      voiceSessionStore,
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
      // WS3 — per-tenant staged rollout of the realtime path (default ON) and
      // the pre-connect health signals. tenantFeatureFlags is null in
      // in-memory dev, in which case the global flag alone decides.
      ...(tenantFeatureFlags ? { tenantFeatureFlags } : {}),
      realtimeCircuit: realtimeHealthCircuit,
      realtimePrerequisitesMet: () => {
        const c = realtimeCapabilities();
        return c.sttEnabled && c.ttsEnabled;
      },
      getHealth: () => {
        const { ttsEnabled, sttEnabled } = realtimeCapabilities();
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
      callMeBackRepo,
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

  // Owner→customer click-to-call. The authed POST /api/calls is wired only when
  // the structural prerequisites are present — a Postgres pool (per-tenant cred
  // + repo access) and PUBLIC_API_URL; without them POST /api/calls returns 503.
  // We do NOT gate on a global TWILIO_ACCOUNT_SID: Twilio creds are resolved
  // per-tenant at call time by getTenantTwilioCreds, which fails closed (→ 503
  // not_configured) for a tenant with no active integration. Prod multi-tenant
  // deployments use per-tenant tenant_integrations and often have NO global SID,
  // so gating on it left click-to-call dark for every tenant on that path.
  // The bridge TwiML callback is mounted HERE — before the global
  // /api Clerk-auth chain — because Twilio carries no Clerk JWT (same reason the
  // telephony webhooks above are). The authed POST /api/calls is mounted after
  // auth, further down. Both share these deps.
  // Click-to-call requires PUBLIC_API_URL: it is the host Twilio calls back for
  // the bridge TwiML. Without it we'd build the callback against the frontend
  // origin (APP_PUBLIC_URL), which doesn't serve /api/calls/bridge, so the call
  // would ring the owner but never connect. Gate the feature on it instead.
  const callDeps =
    pool && process.env.PUBLIC_API_URL
      ? {
          customerRepo,
          conversationRepo,
          dncRepo,
          auditRepo,
          logger: requestLogger,
          getCreds: (tid: string) => getTenantTwilioCreds(tid, pool),
          publicApiUrl: process.env.PUBLIC_API_URL,
          // TCPA express-consent gate — off by default (prod behavior unchanged).
          // The gate must NOT emit its own audit event; initiateOutboundCall owns
          // the consent-decision audit, so bind checkOutboundConsent WITHOUT an
          // auditRepo (otherwise 'warn' mode would record a false "blocked").
          consentEnforcement: config.TCPA_CONSENT_ENFORCEMENT,
          checkConsent: (ctx: OutboundConsentContext) => checkOutboundConsent({ pool }, ctx),
        }
      : undefined;
  app.use(
    '/api/calls',
    createCallBridgeRouter({
      ...(callDeps ? { callDeps } : {}),
      twilioAuthTokenGetter: ({ accountSid }) => resolveTwilioAuthTokenForSubaccount(accountSid),
      // Verify the signature against the SAME base the bridge URL is built from
      // (outbound-call-service uses PUBLIC_API_URL ?? publicBaseUrl); otherwise
      // the signed URL and the reconstructed URL diverge when PUBLIC_API_URL is
      // unset and every callback 403s.
      publicBaseUrl: process.env.PUBLIC_API_URL ?? publicBaseUrl,
    }),
  );

  // P8-012: attach the Media Streams WebSocketServer to the http.Server
  // returned by app.listen(). We override `app.listen` so the bare
  // `index.ts` entry point doesn't need any new wiring — when the
  // server starts listening, the upgrade handler is already attached.
  // The flag also gates whether DeepgramStreamingProvider is constructed
  // (no DEEPGRAM_API_KEY required when the feature is disabled).
  //
  // WS8 — a PROCESS_ROLE=worker deploy never accepts voice WS upgrades:
  // Twilio can't reach it anyway (private networking, no public ingress),
  // so constructing the Deepgram streaming provider, the shared TTS
  // provider, and wrapping app.listen would be dead weight — and would
  // boot-warn/crash the worker on a misconfigured TTS_PROVIDER for a
  // surface it never serves. /health stays role-agnostic (index.ts listens
  // in every role); only this voice-WS attach is role-gated.
  // WS14 — PROCESS_ROLE=voice attaches this exactly like 'web' does (only
  // 'worker' is excluded); it's the intended home for the WS upgrade in the
  // three-service topology.
  if (mediaStreamsEnabled && config.PROCESS_ROLE !== 'worker') {
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
      // UB-C2 — same voice id scripts/render-fillers.ts renders with, so
      // filler clips and live TTS speak with one voice.
      ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
      AI_PROVIDER_API_KEY: config.AI_PROVIDER_API_KEY,
    });
    // P0 voice-output fail-fast: Twilio Media Streams requires raw PCM16
    // audio (mediastream-adapter.ts encodes it to mu-law itself via
    // streamPcmAsMedia). A TtsProvider that only implements synthesize()
    // (OpenAI tts-1, ElevenLabs' non-streaming call) returns compressed
    // audio (mp3) with no transcoder in the media-streams path — feeding
    // that into streamPcmAsMedia produces inaudible static on every call.
    // Only synthesizeStream() implementations (currently ElevenLabs) emit
    // raw PCM. Crash at boot rather than ship a silent voice outage — same
    // fail-fast posture as the DATABASE_URL check above.
    assertTtsProviderSupportsMediaStreams({
      mediaStreamsEnabled,
      provider: sharedTtsProvider,
      ttsProviderEnv: process.env.TTS_PROVIDER,
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
                    // Top-level tenantId so the gateway keys this tenant's
                    // concurrency quota / cache bucket correctly (never the
                    // shared SYSTEM_TENANT_ID).
                    tenantId: input.tenantId,
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

      // RV-120/RV-121/RV-122 — per-turn vulnerability triage. The hook gates
      // itself on the per-tenant `voice_vulnerability_triage` flag, grades
      // the turn via the `grade_vulnerability` gateway task, persists every
      // evaluateTriage outcome to triage_events, and patches vulnerable +
      // urgent callers straight through to the owner (fallback ladder:
      // owner → on-call → voicemail + urgent SMS + call_me_back).
      const triageEventsRepo = pool
        ? new PgTriageEventRepository(pool)
        : new InMemoryTriageEventRepository();
      const mediaStreamPublicBase = (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
      // WS7 — mid-call REST redirector: on a terminal realtime failure the
      // mediastream adapter steers the LIVE call back to the Gather-fallback
      // webhook instead of hanging up. Wired only when PUBLIC_API_URL is set
      // (Twilio must POST an absolute URL); absent → adapter keeps 1011-close.
      const twilioCallRedirector = process.env.PUBLIC_API_URL
        ? createTwilioCallRedirector({
            resolveAuthToken: (accountSid) => resolveTwilioAuthTokenForSubaccount(accountSid),
            ...(process.env.TWILIO_ACCOUNT_SID
              ? { defaultAccountSid: process.env.TWILIO_ACCOUNT_SID }
              : {}),
            publicBaseUrl: process.env.PUBLIC_API_URL,
          })
        : undefined;
      const vulnerabilityTriageHookDep = llmGateway
        ? createVulnerabilityTriageHook({
            isEnabledForTenant: isFlagEnabledForTenant,
            grade: (input, budget) =>
              gradeVulnerability(input, {
                llm: {
                  complete: async ({ prompt }: { prompt: string }) => {
                    const res = await llmGateway.complete({
                      taskType: 'grade_vulnerability',
                      // Top-level tenantId so the gateway keys this tenant's
                      // concurrency quota / cache bucket correctly (never the
                      // shared SYSTEM_TENANT_ID).
                      tenantId: input.tenantId,
                      messages: [{ role: 'user' as const, content: prompt }],
                    });
                    return { text: res.content };
                  },
                },
                ...budget,
              }),
            triageEvents: triageEventsRepo,
            onPatchOwner: async ({ session, tenantId, decision }) => {
              const patchCallerPhone = twilioAdapter.getCallerPhone(session.id);
              const result = await patchOwnerThrough(
                {
                  tenantId,
                  sessionId: session.id,
                  ...(session.callSid ? { callSid: session.callSid } : {}),
                  dialActionUrl: `${mediaStreamPublicBase}/api/telephony/dial-result?sid=${encodeURIComponent(session.id)}`,
                  reason: decision.reason,
                  ...(patchCallerPhone ? { callerPhone: patchCallerPhone } : {}),
                  shopName: process.env.TWILIO_BUSINESS_NAME ?? 'our team',
                  voicemailRecordingCallbackUrl: `${mediaStreamPublicBase}/api/telephony/recording`,
                },
                {
                  callControl: telephonyCallControl,
                  ownerPhoneResolver: createSettingsOwnerPhoneResolver(settingsRepo),
                  onCallRepo: sharedOnCallRepo,
                  dispatcherPhoneResolver: createUserPhoneDispatcherResolver(userRepo),
                  businessPhoneFallbackResolver: createBusinessPhoneFallback(settingsRepo),
                  ...(messageDelivery
                    ? {
                        // Patch-owner-through page → owner. Never customer-gated.
                        sendSms: (args: { to: string; body: string }) =>
                          messageDelivery.sendSms({ to: args.to, body: args.body, recipientClass: 'owner' }),
                      }
                    : {}),
                  callMeBackRepo,
                  auditRepo,
                },
              );
              if (result.kind === 'bridged') {
                twilioAdapter.setPendingTransferTwiml(session.id, result.twiml);
                return `patch_owner:bridged_${result.target}`;
              }
              if (result.voicemailTwiml) {
                twilioAdapter.setPendingTransferTwiml(session.id, result.voicemailTwiml);
              }
              return `patch_owner:fallback${result.smsSent ? '+sms' : ''}${result.callMeBackTaskId ? '+callback' : ''}`;
            },
            // RV-123 — queue a human-approved update_customer proposal that
            // stamps the vulnerability marker into communication notes (the
            // EXISTING payload's `notes` field; see vulnerable-customer.ts).
            markCustomerVulnerable: async ({ tenantId, customerId, decision, sessionId }) => {
              const existing = await customerRepo.findById(tenantId, customerId);
              const payload = buildMarkCustomerVulnerablePayload(
                customerId,
                decision,
                existing?.communicationNotes,
              );
              if (!payload) return; // already marked
              await proposalRepo.create(
                buildProposalRow({
                  tenantId,
                  proposalType: 'update_customer',
                  payload,
                  summary: 'Flag customer as potentially vulnerable (voice triage)',
                  sourceContext: {
                    source: 'calling-agent',
                    channel: 'telephony',
                    sessionId,
                    reason: 'vulnerability_triage',
                  },
                  createdBy: 'system:vulnerability-triage',
                }),
              );
            },
          })
        : undefined;

      // U4 — give the SAME hook to the Gather/PSTN adapter so a Gather-mode
      // turn grades identically to a streaming turn (the hook was previously
      // only handed to the media-streams server below). Late-bound because the
      // hook's onPatchOwner closure references twilioAdapter, which is built
      // earlier. Fires fire-and-forget, gated inside the hook by the per-tenant
      // voice_vulnerability_triage flag.
      if (vulnerabilityTriageHookDep) {
        twilioAdapter.setVulnerabilityTriageHook(vulnerabilityTriageHookDep);
      }

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
            connectionRegistry,
            streamingProvider,
            // WS3 — feed the shared realtime health circuit (the /voice branch
            // reads it) and emit the alertable resilience audit events
            // (session_failed / disclosure.init_failed).
            realtimeCircuit: realtimeHealthCircuit,
            ...(twilioCallRedirector ? { restRedirect: twilioCallRedirector } : {}),
            ...(auditRepo ? { auditRepo } : {}),
            ...(sharedTtsProvider ? { ttsProvider: sharedTtsProvider } : {}),
            terminologyProvider,
            // UB-C1 — resolve the language the call OPENS in, before the
            // Deepgram socket is created: identified caller's
            // preferredLanguage > tenant default, both gated by the
            // tenant's supported_languages opt-in (detectLanguage applies
            // the gate internally). Failure-soft: any error falls back to
            // the tenant default / English rather than blocking audio.
            initialLanguageResolver: async (
              tenantId: string,
              ctx: { callSid: string; sessionId: string },
            ) => {
              const settings = await settingsRepo.findByTenant(tenantId).catch(() => null);
              let customerPreferred: 'en' | 'es' | null = null;
              const callerPhone = twilioAdapter.getCallerPhone(ctx.sessionId);
              if (pool && callerPhone) {
                try {
                  const identified = await identifyCaller({
                    tenantId,
                    fromPhone: callerPhone,
                    pool,
                  });
                  if (identified.status === 'matched') {
                    const customer = await customerRepo.findById(tenantId, identified.customerId);
                    const pref = customer?.preferredLanguage;
                    if (pref === 'en' || pref === 'es') customerPreferred = pref;
                  }
                } catch {
                  /* failure-soft — fall through to the tenant default */
                }
              }
              return detectInitialCallLanguage({
                customerPreferredLanguage: customerPreferred,
                tenantDefaultLanguage: settings?.defaultLanguage === 'es' ? 'es' : 'en',
                supportedLanguages: settings?.supportedLanguages ?? ['en'],
              });
            },
            fillerEngine,
            fillerCache,
            speechTurn: async ({ session, speechResult, callSid, tenantId }) =>
              twilioAdapter.processCallerUtterance({
                sessionId: session.id,
                callSid,
                speechResult,
                tenantId,
              }),
            // RV-130 (CRITICAL) — greeting + recording-disclosure bootstrap
            // once Deepgram opens. initializeStreamSession speaks the
            // greeting/disclosure via the stream TTS path AND appends the
            // implicit recording-consent event to the ledger (the gather
            // adapter carries consentEvents). Without this hook wired,
            // flag-enabled streaming calls start silent and ledger nothing.
            initializeSession: ({ callSid, tenantId }) =>
              twilioAdapter.initializeStreamSession({ callSid, tenantId }),
            // RV-140 (interim) — emergency keywords escalate on interim
            // transcripts (keywords only; objection scan stays finals-only).
            interimEmergencyScan: ({ session, speechResult, tenantId }) =>
              twilioAdapter.scanInterimForEmergency({
                sessionId: session.id,
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
            // Codex P2 (PR #702) — T2-F05 silence-timer parity with the
            // Gather/WS-finals pending-approval (RV-071) / SMS-consent
            // (WS18) handling: a silent caller mid-dialogue gets
            // keep-pending / fail-closed semantics instead of being
            // reprompted and (on a second silence) escalated+end-sessioned
            // with the dialogue stranded.
            handlePendingDialogueSilence: (session, tenantId) =>
              twilioAdapter.handlePendingDialogueSilence(session, tenantId),
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
            // RV-122 — per-turn vulnerability triage (flag-gated inside the
            // hook). DELIBERATE scope (v1): streaming-only — the hook is
            // wired into the media-streams adapter exclusively, so Gather
            // turns don't grade. The Gather path is the legacy/fallback
            // transport; triage targets the launch transport first, and
            // extending the hook to _handleGatherLocked is a follow-up.
            ...(vulnerabilityTriageHookDep
              ? { vulnerabilityTriageHook: vulnerabilityTriageHookDep }
              : {}),
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
        registry: connectionRegistry,
        // UC-3 — dispatch presence heartbeats/reads ride this socket
        // instead of a 5s HTTP PUT per board user.
        dispatchPresence: createDispatchPresenceGatewayDeps(),
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
    app.use(
      '/api',
      devAuthBypass({
        tenantRepo,
        settingsRepo,
        userRepo,
        ...(inMemoryUserModeService ? { userModeService: inMemoryUserModeService } : {}),
      }),
    );
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

  // QUALITY-2026-07-12 WS4 — DB-authoritative authorization. Runs immediately
  // after requireAuth (so req.auth is populated) and BEFORE any route or the
  // per-tenant limiter, so every /api/* request has its role re-resolved from
  // the DB and deleted/suspended/non-member callers are rejected regardless of
  // what their (still-valid) Clerk token claims. The loader is wired below only
  // when a Pool exists and dev-auth-bypass is off; otherwise this is a no-op
  // pass-through that keeps the JWT claim (see resolveAuthorization).
  app.use('/api', resolveAuthorization);

  // P3/U-P3c: per-tenant fairness limiter. The pre-auth /api limiter above is a
  // coarse per-IP DoS guard; this one runs AFTER requireAuth (so req.auth is
  // populated) and caps requests PER TENANT cluster-wide, so one tenant's
  // dashboards/integrations can't monopolize a replica's capacity. Keyed by
  // tenantId (fallback userId, then the IPv6-safe client IP for the rare
  // authenticated-but-tenantless request). Shared Redis store; per-process
  // MemoryStore when REDIS_URL is unset.
  const tenantRateMax = Math.max(1, Number(process.env.API_TENANT_RATE_LIMIT_MAX) || 1000);
  app.use('/api', rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: isDev ? 100_000 : tenantRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const auth = (req as AuthenticatedRequest).auth;
      return auth?.tenantId ?? auth?.userId ?? ipKeyGenerator(req.ip ?? '');
    },
    skip: () => isDev && process.env.DEV_AUTH_BYPASS === 'true',
    store: createRateLimitStore(process.env.REDIS_URL, 'tenant:'),
  }));

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
  app.use(
    '/api/customers',
    createCustomerRouter(
      customerRepo,
      auditRepo,
      // P9-002 / Story 4.9 — wire the unified customer timeline so
      // GET /api/customers/:id/timeline (consumed by the web
      // CommunicationTimeline) resolves instead of quietly 404ing.
      {
        noteRepo,
        jobRepo,
        jobTimelineRepo: timelineRepo,
        estimateRepo,
        invoiceRepo,
        paymentRepo,
        conversationRepo,
        appointmentRepo,
      },
      customerContactRepo,
      customerTagRepo,
      customerCustomFieldRepo,
      customerMergeRepo,
      // WS12 — manual sms_consent toggles ledger to consent_events so a
      // dashboard opt-out suppresses BOTH outbound channels.
      consentEventRepo
    )
  );
  app.use(
    '/api/customer-custom-fields',
    createCustomerCustomFieldRouter(customerCustomFieldRepo, auditRepo)
  );
  app.use('/api/job-forms', createJobFormRouter(jobFormRepo, auditRepo, jobRepo));
  app.use('/api/job-custom-fields', createJobCustomFieldRouter(jobCustomFieldRepo, auditRepo, jobRepo));
  app.use('/api/customer-groups', createCustomerGroupRouter(customerGroupRepo, auditRepo));
  app.use(
    '/api/standing-instructions',
    createStandingInstructionRouter(standingInstructionRepo, auditRepo)
  );
  app.use(
    '/api/marketing',
    createMarketingRouter({
      campaignRepo,
      customerRepo,
      tagRepo: customerTagRepo,
      delivery: messageDelivery,
      groupMemberIds: (tid, gid) => customerGroupRepo.listMemberIds(tid, gid),
      auditRepo,
    })
  );
  app.use(
    '/api/financing',
    createFinancingRouter({
      financingRepo,
      invoiceRepo,
      jobRepo,
      customerRepo,
      provider: financingProvider,
      auditRepo,
    })
  );
  app.use(
    '/webhooks/wisetack',
    createFinancingWebhookRouter({
      financingRepo,
      auditRepo,
      webhookSecret: process.env.WISETACK_WEBHOOK_SECRET,
    })
  );
  app.use(
    '/api/recurring-jobs',
    createRecurringJobRouter(recurringJobRepo, auditRepo, {
      jobRepo,
      appointmentRepo,
      locationRepo,
      resolveTimezone: async (tenantId: string) => {
        const s = await settingsRepo.findByTenant(tenantId);
        return s?.timezone ?? 'America/New_York';
      },
    },
    customerRepo)
  );
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
  app.use('/api/leads', createLeadsRouter(leadRepo, customerRepo, auditRepo, locationRepo));
  app.use('/api/locations', createLocationRouter(locationRepo, ownership, auditRepo));
  app.use('/api/jobs', createJobRouter(jobRepo, timelineRepo, auditRepo, ownership, queue, feedbackDispatcher, customerRepo, locationRepo, {
    estimateRepo,
    invoiceRepo,
    proposalRepo,
    settingsRepo,
    auditRepo,
    timeEntryRepo,
    scheduleRepo: invoiceScheduleRepo,
  }, {
    estimateRepo,
    jobRepo,
    appointmentRepo,
    assignmentRepo,
    userRepo,
    invoiceRepo,
    auditRepo,
    settingsRepo,
  }, {
    appointmentRepo,
    assignmentRepo,
    userRepo,
  }));
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
      // RV-005: attachmentRepo enables the dual-write shadow — every job
      // photo created through this flow also lands in `attachments`.
      // RV-006: queue kicks the image post-process pipeline per photo.
      service: new JobPhotoService(jobPhotoRepo, fileRepo, storageProvider, attachmentRepo, queue),
      fileRepo,
      storage: storageProvider,
      bucket: storageBucket,
      auditRepo,
    })
  );
  app.use(
    '/api/attachments',
    createAttachmentsRouter({
      service: new AttachmentService(attachmentRepo, fileRepo, storageProvider, auditRepo, {
        // RV-005: entity-existence lookups for the supported types. The
        // remaining entity types (form_response, expense, agreement_run,
        // customer) return NOT_SUPPORTED until later tasks wire them.
        job: async (tenantId, id) => (await jobRepo.findById(tenantId, id)) !== null,
        invoice: async (tenantId, id) => (await invoiceRepo.findById(tenantId, id)) !== null,
        estimate: async (tenantId, id) => (await estimateRepo.findById(tenantId, id)) !== null,
        // RV-006: queue kicks the image post-process pipeline per attach.
      }, queue),
      fileRepo,
      storage: storageProvider,
      bucket: storageBucket,
      auditRepo,
    })
  );
  // RV-050 — inbound MMS photo ingestion. P0-009 async split: the media
  // handler registered with the P2-034 dispatcher only ENQUEUES an
  // `mms_ingest` job (idempotency-keyed on the Twilio MessageSid, so
  // webhook retry-duplicates dedupe at the queue) and the worker below
  // runs the pipeline: photos texted from a REGISTERED TECH phone attach
  // to the tech's active job (open time entry); media bytes are fetched
  // from Twilio with the tenant's subaccount Basic-auth credentials (same
  // pattern as the recording webhook). The "clock in first" reply is sent
  // by the worker through the same MessageDelivery transport. Webhook
  // latency stays in the ms; failures ride the queue retry/DLQ semantics.
  registerMmsIngestHandler({ queue }, { overwrite: true });
  // U6 — inbound MMS cost/abuse guard (per-sender photo-quote cap). One limiter
  // instance reused across calls; absent without a pool (dev/in-memory).
  const customerMmsRateLimiter = pool ? new PhoneRateLimiter(pool) : undefined;
  const mmsIngestWorker = createMmsIngestWorker({
    userRepo,
    timeEntries: new TimeEntryService(timeEntryRepo, auditRepo),
    attachmentService: new AttachmentService(
      attachmentRepo,
      fileRepo,
      storageProvider,
      auditRepo,
      {
        job: async (tenantId, id) => (await jobRepo.findById(tenantId, id)) !== null,
      },
      queue,
    ),
    fileRepo,
    storage: storageProvider,
    storageBucket,
    fetchMedia: createTwilioMediaFetcher(async (tenantId) => {
      const integration = await integrationResolver?.(tenantId, 'twilio');
      if (
        !integration ||
        integration.provider !== 'twilio' ||
        !integration.subaccountSid ||
        !integration.authTokenPrimary
      ) {
        return null;
      }
      return {
        accountSid: integration.subaccountSid,
        authToken: integration.authTokenPrimary,
      };
    }),
    ...(messageDelivery
      ? {
          sendReply: async (tenantId: string, to: string, body: string) => {
            // Reply to an inbound tech MMS — the sender is a registered tech
            // (owner-side), not a customer.
            await messageDelivery!.sendSms({ to, body, tenantId, recipientClass: 'owner' });
          },
        }
      : {}),
    auditRepo,
    // U2 — customer MMS-to-quote. When the sender is NOT a registered
    // tech, the worker hands the same inbound MMS to this intake:
    // resolve/create the customer (ambiguous → clarification, never a
    // silent guess), store + presign the photo(s), then draft a
    // catalog-grounded draft_estimate proposal into the owner approval
    // queue (never auto-issued). Reuses the same Twilio fetcher + files
    // pipeline + LLM gateway as the rest of the app.
    customerIntake: {
      customerRepo,
      proposalRepo,
      fileRepo,
      storage: storageProvider,
      storageBucket,
      fetchMedia: createTwilioMediaFetcher(async (tenantId) => {
        const integration = await integrationResolver?.(tenantId, 'twilio');
        if (
          !integration ||
          integration.provider !== 'twilio' ||
          !integration.subaccountSid ||
          !integration.authTokenPrimary
        ) {
          return null;
        }
        return {
          accountSid: integration.subaccountSid,
          authToken: integration.authTokenPrimary,
        };
      }),
      gateway: llmGateway,
      catalogRepo,
      auditRepo,
      ...(messageDelivery
        ? {
            notifyOwner: async (tenantId: string, body: string) => {
              const ownerPhone = await resolveUnsupervisedOwnerPhone(tenantId);
              if (ownerPhone) {
                await messageDelivery!.sendSms({ to: ownerPhone, body, tenantId, recipientClass: 'owner' });
              }
            },
          }
        : {}),
      ...(customerMmsRateLimiter
        ? {
            checkRateLimit: (tenantId: string, fromPhone: string) =>
              customerMmsRateLimiter.tryConsume(
                tenantId,
                CUSTOMER_MMS_RATE_SCOPE,
                fromPhone,
                CUSTOMER_MMS_RATE_LIMIT,
                CUSTOMER_MMS_RATE_WINDOW_MS,
              ),
          }
        : {}),
    },
  });
  workerRegistry.set(
    mmsIngestWorker.type,
    mmsIngestWorker as import('./queues/queue').WorkerHandler<unknown>,
  );

  app.use(
    '/api/appointments',
    createAppointmentRouter(appointmentRepo, ownership, jobRepo, timelineRepo, {
      delayNotificationCoordinator,
    }, auditRepo)
  );
  // UC-3 — presence store goes cluster-wide when REDIS_URL is set (in-memory
  // and byte-identical to single-replica behavior otherwise).
  initDispatchPresenceStore(process.env.REDIS_URL);
  // UC-4 — dispatch-board event/revision fan-out across replicas. Double-gated
  // like the voice fan-out (U3d): REDIS_URL must be set AND
  // DISPATCH_FANOUT_ENABLED=true; otherwise the bus stays process-local.
  initDispatchBoardFanout(
    process.env.DISPATCH_FANOUT_ENABLED === 'true' ? process.env.REDIS_URL : undefined,
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
      userRepo,
      settingsRepo,
      auditRepo,
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
      { gateway: llmGateway, proposalRepo, catalogRepo },
      { jobRepo, invoiceRepo },
      { docRevisionRepo: documentRevisionRepo, editDeltaRepo: deltaRepo },
      paymentRepo,
      agreementRepo,
      templateRepo,
      customerRepo,
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
      agreementRepo,
      customerRepo,
      connectAccountResolver,
    ),
  );

  // Mobile push-token registration store (also consumed by account deletion
  // below and the /api/devices router mounted later). Pg-backed when a DB is
  // configured; in-memory otherwise.
  const deviceTokenRepo = pool
    ? new PgDeviceTokenRepository(pool)
    : new InMemoryDeviceTokenRepository();

  // Tier 4 (Team members — PR 1+2+3). User roster, role editing, and
  // invitation flow. Tenant scoping is enforced by the route's
  // requireTenant + the repo's tenant context. Clerk integration is
  // best-effort: missing CLERK_SECRET_KEY just persists the local
  // intent; the operator can still re-send via dashboard and the
  // webhook still attaches the invitee on accept (lookup is by email).
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
        // Account deletion purges the user's push tokens server-side.
        deviceTokenRepo,
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

  app.use(
    '/api/integrations',
    createIntegrationsRouter(integrationsRouterDeps),
  );

  // billingService is hoisted earlier so the Stripe webhook can use
  // the same instance.
  app.use('/api/billing', createBillingRouter({ billingService, connectService, auditRepo, pool: pool ?? undefined }));

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
      // HFCR hero metric (GET /api/reports/hfcr) — reads paid payments +
      // their gating proposals' approval channels.
      proposalRepo,
      auditRepo,
      // P22-005 (U7) — per-job profit (GET /api/reports/job-profit/:jobId).
      // Aggregates the job's invoices + tracked labor + expenses against the
      // tenant labor rate. No materialsResolver: the P14 job_parts table is not
      // built, so materials default to 0 (job-profit.ts handles its absence).
      jobRepo,
      timeEntryRepo,
      settingsRepo,
      // Look up the tenant tz so /money-dashboard buckets by local
      // month boundaries. Without this the dashboard would default
      // to America/New_York (matches tenant_settings.timezone's DB
      // default) — close-enough for most US tenants but wrong for
      // anyone on PST or other zones. Delegates to the existing
      // settingsRepo so we don't add a second tenant_settings query
      // path (and inherit its RLS / withTenant handling for free).
      getTenantTimezone: async (tenantId: string) => {
        const settings = await settingsRepo.findByTenant(tenantId);
        return settings?.timezone ?? DEFAULT_TENANT_TIMEZONE;
      },
    }),
  );

  // Epic 12.5 — Voice ROI headline (inbound / answered / booked / after-hours /
  // would-have-hit-voicemail). Composes the existing voice-session + proposal
  // repos with the tenant business-hours loader (after-hours attribution). The
  // loader is only wired when a pool exists; the in-memory boot path leaves it
  // undefined, so after-hours fails open (counts as zero) rather than erroring.
  const voiceRoiReporter = new RepoBackedVoiceRoiReporter(
    voiceSessionRepo,
    proposalRepo,
    pool ? (tenantId: string) => loadTenantBusinessHours(pool, tenantId) : undefined,
  );
  app.use('/api/analytics/voice-roi', createVoiceRoiRouter({ voiceRoiReporter }));

  // Epic 12.4 — jobs-booked KPI (this month vs last). Pool-backed RLS-scoped
  // counts; left unwired (→ 503) on the in-memory boot path that has no pool.
  const jobsBookedReporter = pool ? new PgJobsBookedReporter(pool) : undefined;
  app.use('/api/analytics/jobs-booked', createJobsBookedRouter({ jobsBookedReporter }));

  // Epic 12.7 — tenant-wide activity feed over the audit log (both the Pg and
  // in-memory audit repos support findRecentByTenant).
  const activityFeedReporter = new RepoBackedActivityFeedReporter(auditRepo);
  app.use('/api/analytics/activity', createActivityFeedRouter({ activityFeedReporter }));

  // RV-062 — end-of-day digest web view (SMS deep link target).
  app.use('/api/digests', createDigestsRouter({ digestRepo: dailyDigestRepo }));
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
  // Stripe Terminal — field card-present collect (Connect direct charges).
  app.use(
    '/api/terminal',
    createTerminalRouter({
      invoiceRepo,
      connectAccountResolver,
      stripeApiKey: process.env.STRIPE_SECRET_KEY ?? null,
      auditRepo,
      terminalLocation: connectService
        ? {
            getExistingLocationId: async (tenantId) => {
              const view = await connectService.getAccount(tenantId);
              return view.terminalLocationId;
            },
            persistLocationId: (tenantId, locationId) =>
              connectService.setTerminalLocationId(tenantId, locationId),
            resolveDisplayName: async (tenantId) => {
              if (!pool) return 'Field location';
              const { rows } = await pool.query(
                `SELECT name FROM tenants WHERE id = $1`,
                [tenantId],
              );
              const name = rows[0]?.name as string | undefined;
              return name?.trim() || 'Field location';
            },
          }
        : undefined,
    }),
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
            `SELECT id, clerk_user_id, tenant_id, role,
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
            // Sweep-2 S5 — internal users.id UUID; this is what
            // appointment_assignments.technician_id references, so the
            // web technician surfaces resolve THIS, not the Clerk sub.
            internal_user_id: String(row.id),
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
                    COALESCE(unsupervised_proposal_routing, 'queue_and_sms') AS unsupervised_proposal_routing,
                    COALESCE(timezone, $2) AS timezone
             FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
            [tenantId, DEFAULT_TENANT_TIMEZONE],
          );
          if (r.rowCount === 0) {
            return {
              backup_supervisor_user_id: null,
              unsupervised_proposal_routing: 'queue_and_sms',
              timezone: DEFAULT_TENANT_TIMEZONE,
            } as MeTenantSettings;
          }
          const row = r.rows[0] as Record<string, unknown>;
          return {
            backup_supervisor_user_id: row.backup_supervisor_user_id
              ? String(row.backup_supervisor_user_id)
              : null,
            unsupervised_proposal_routing:
              row.unsupervised_proposal_routing as MeTenantSettings['unsupervised_proposal_routing'],
            timezone: String(row.timezone),
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
    : inMemoryUserModeService!;

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

  // QUALITY-2026-07-12 WS4 — wire the DB-authoritative authorization loader.
  // Only when a real Pool exists AND dev-auth-bypass is off: dev-bypass already
  // trusts unsigned tokens by design, and the no-DB dev path has no membership
  // table to be authoritative over — both keep the JWT claim (resolveAuthorization
  // no-ops when no loader is wired). `userId` here is the Clerk subject
  // (req.auth.userId = payload.sub), so the lookup matches on clerk_user_id,
  // exactly like userModeService.getUser. Errors are DELIBERATELY allowed to
  // propagate (not caught) so resolveAuthorization fails closed on a DB blip
  // instead of falling back to the token's role claim.
  if (pool && !isDevAuthBypassEnabled()) {
    setAuthorizationLoader(createAuthorizationLoader(pool));
  }

  // Phase 12 — wire the tenant-wide supervisor-presence loader. The
  // proposal auto-approve threshold and the emergency-immediate-Dial
  // helper both consult this. Keep wired in dev only when a Pool is
  // available; otherwise the in-memory permissive default applies.
  if (pool) {
    setSupervisorPresenceLoader(pgSupervisorPresenceLoader(pool));
  }

  app.use(
    '/api/me',
    createMeRouter(userModeService, auditRepo, {
      // N-011 — surface the brand_voice_configurator flag so the web gates the
      // onboarding step + settings sheet. Tenant-aware (tenant override →
      // platform flag → false) so a per-tenant dark launch actually exposes
      // the UI; default off.
      isBrandVoiceConfiguratorEnabled: (tenantId: string) =>
        isFlagEnabledForTenant(tenantId, 'brand_voice_configurator'),
    }),
  );

  app.use('/api/devices', createDevicesRouter(deviceTokenRepo, auditRepo));

  // U10 — per-user notification preferences (opt-out by category).
  const notificationPreferenceRepo = pool
    ? new PgNotificationPreferenceRepository(pool)
    : new InMemoryNotificationPreferenceRepository();
  app.use(
    '/api/notification-preferences',
    createNotificationPreferencesRouter(notificationPreferenceRepo, auditRepo),
  );

  // U7 — bind the push notifiers into the late-bound slots now that the
  // device-token repo exists.
  const expoPushProvider = new ExpoPushDeliveryProvider(fetch, process.env.EXPO_ACCESS_TOKEN);
  // Only the approver/owner devices should receive proposal pushes — never a
  // technician who happens to have signed into the app.
  const resolveApproverUserIds = approverUserIdsResolver(userRepo);
  notifyExecutedPush = (tenantId, proposalId) =>
    notifyExecutedPush_(
      { deviceTokenRepo, provider: expoPushProvider, resolveApproverUserIds },
      { tenantId, proposalId },
    );
  notifyNeedsApprovalPush = (args) =>
    notifyNeedsApprovalPush_(
      { deviceTokenRepo, provider: expoPushProvider, resolveApproverUserIds },
      args,
    );
  // Register the generic owner-notification fan-out used by the non-proposal
  // producer seams (inbound call/SMS, appointment reminder/cancellation,
  // payment, lead, escalation). Each type targets the permission its descriptor
  // declares (owner+dispatcher, never a technician device).
  setOwnerNotifications(
    new OwnerNotificationService({
      deviceTokenRepo,
      provider: expoPushProvider,
      resolveUserIds: userIdsWithPermissionResolver(userRepo),
      // U10 — honor per-user category opt-outs before sending.
      resolveMutedUserIds: (tenantId, type) =>
        notificationPreferenceRepo.listMutedUserIds(tenantId, type),
    }),
  );
  // Render the real customer name in payment/cancellation pushes (best-effort;
  // falls back to "A customer" on any miss) without threading a resolver
  // through every recordPayment / cancellation call site.
  setOwnerNotificationNameResolvers({
    invoiceCustomerName: async (tid, invoiceId) => {
      const invoice = await invoiceRepo.findById(tid, invoiceId);
      if (!invoice?.jobId) return undefined;
      const job = await jobRepo.findById(tid, invoice.jobId);
      if (!job?.customerId) return undefined;
      const customer = await customerRepo.findById(tid, job.customerId);
      return customer?.displayName;
    },
    appointmentCustomerName: async (tid, appointmentId) => {
      const appointment = await appointmentRepo.findById(tid, appointmentId);
      if (!appointment?.jobId) return undefined;
      const job = await jobRepo.findById(tid, appointment.jobId);
      if (!job?.customerId) return undefined;
      const customer = await customerRepo.findById(tid, job.customerId);
      return customer?.displayName;
    },
  });
  app.use('/api/feedback/responses', createFeedbackResponsesRouter(feedbackResponseRepo));
  app.use(
    '/api/conversations',
    createConversationRouter(
      conversationRepo,
      auditRepo,
      {
        gateway: llmGateway,
        settingsRepo,
        // UB-A3 — owner standing instructions injected into suggested replies.
        standingInstructionRepo,
      },
      // U6 — owner reply send path. Only wired when a delivery provider exists
      // (prod/dev with creds); otherwise POST /:id/reply returns 503.
      messageDelivery
        ? {
            customerRepo,
            leadRepo,
            dncRepo,
            dispatchRepo,
            delivery: messageDelivery,
            settingsRepo,
          }
        : undefined,
      // Lets POST /customer/:customerId 404 unknown customers before creating.
      customerRepo,
    ),
  );
  app.use('/api/dnc', createDncRouter({ dncRepo, auditRepo }));

  // Owner→customer click-to-call (authed POST). Mounted after the global /api
  // auth chain; the unauthenticated Twilio /bridge callback was mounted earlier
  // (before auth). Shares callDeps built above; 503 when Twilio is unconfigured.
  app.use('/api/calls', createCallsRouter(callDeps ? { callDeps } : {}));

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
  // N-011 — Brand-Voice Configurator (behind the brand_voice_configurator flag,
  // enforced at the web surface; the API is permission-gated as normal).
  const brandVoiceRepo = pool
    ? new PgBrandVoiceRepository(pool)
    : new InMemoryBrandVoiceRepository();
  app.use(
    '/api/settings/brand-voice',
    createBrandVoiceRouter(brandVoiceRepo, settingsRepo, auditRepo),
  );
  app.use('/api/settings/packs', createPackActivationRouter(packActivationRepo, canonicalPackRegistry, auditRepo, settingsRepo));
  app.use('/api/verticals', createVerticalRouter(canonicalPackRegistry));
  app.use('/api/vertical-training-assets', createVerticalTrainingAssetsRouter(trainingAssetService));
  app.use('/api/templates', createTemplateRouter(templateRepo, auditRepo));
  app.use('/api/message-templates', createMessageTemplateRouter(messageTemplateRepo, settingsRepo, auditRepo));
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
    createVoiceRouter(voiceRepo, queue, transcribeAudio, auditRepo, voiceLogger, {
      ...(pool ? { pool } : {}),
      // RV-132 — purged-recording download guard (410 instead of a
      // dangling S3 404 after the retention worker deletes the object).
      fileRepo,
      storage: storageProvider,
      jobRepo,
    }),
  );
  app.use(
    '/api/onboarding',
    createOnboardingRouter({
      settingsRepo,
      packActivationRepo,
      auditRepo,
      pool,
      billingService,
      queue,
      packSeedDeps: { catalogRepo, templateRepo },
    }),
  );

  // U1 — conversational onboarding lane. Mounted as a sub-path of the
  // existing V2 onboarding routes so the web client can post turns to
  // POST /api/onboarding/conversation/turn while the form-based
  // wizard's other endpoints stay unchanged.
  const onboardingSessionRepo = pool
    ? new PgOnboardingSessionRepository(pool)
    : new InMemoryOnboardingSessionRepository();
  app.use(
    '/api/onboarding/conversation',
    createOnboardingConversationRouter({
      orchestrator: new OnboardingConversationOrchestrator({
        gateway: llmGateway,
        sessionRepo: onboardingSessionRepo,
        proposalRepo,
        auditRepo,
      }),
    }),
  );
  app.use(
    '/api/technician-location',
    createTechnicianLocationRouter({
      repository: technicianLocationPingRepo,
      canSubmitForTechnician: (auth, technicianId) =>
        technicianLocationAuthorizer.canSubmitForTechnician(auth, technicianId),
      isAppointmentAssignedToTechnician: async (tenantId, appointmentId, technicianId) => {
        const assignments = await assignmentRepo.findByAppointment(tenantId, appointmentId);
        return assignments.some((assignment) => assignment.technicianId === technicianId);
      },
      auditRepo,
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
      // QA-2026-06-05 (AST-05): read-only query intents answer from data.
      invoiceRepo,
      // RV-042 — acceptance-void marker on update_estimate proposals.
      estimateRepo,
      // P22 — catalog grounding for assistant-drafted invoices/estimates.
      catalogRepo,
      // B5 — the scheduling / invoice-follow-up intents wired into the
      // assistant surface need the same repos the voice worker passes so
      // their handlers resolve concrete ids instead of degrading to gated.
      appointmentRepo,
      jobRepo,
      dunningEventRepo,
      // B8 — create_customer draft-time duplicate detection parity, same
      // customerRepo the voice worker and telephony FSM already use.
      customerRepo,
      // §3B/3D/3E — assistant chat shares the operator-side resolver
      // shim with the voice-action-router so the same vertical context
      // reaches both text and voice classification paths.
      verticalPromptResolver: operatorVerticalResolverShim,
      // UB-A3 — owner standing instructions injected into assistant-drafted
      // estimates/invoices (same resolver contract as the voice router).
      standingInstructionsResolver: (tenantId: string) =>
        standingInstructionRepo.listActive(tenantId),
      // Story 3.11 — persist each chat turn so the running conversation
      // survives reload and is searchable.
      conversationRepo,
      auditRepo,
    }),
  );
  // D2-1c — audit-log proposal approve / reject / edit / undo.
  app.use('/api/dispatch', createSchedulingRouter(feasibilityDeps, userRepo, settingsRepo ?? undefined));
  const entityAliasCandidateCapture =
    entityAliasRepo && auditRepo
      ? createEntityAliasCandidateService({ proposalRepo, auditRepo })
      : undefined;
  app.use(
    '/api/proposals',
    createProposalsRouter(
      proposalRepo,
      appointmentRepo,
      auditRepo,
      feasibilityDeps,
      // N-009 / P2-038 — undoing a proposal reverses the structured correction
      // lessons it recorded. Pool-gated: only present when lessons can persist.
      correctionLessonRepo
        ? { lessonRepo: correctionLessonRepo, ports: correctionConfigPorts }
        : undefined,
      // Story 3.9 — editing a proposal logs each changed field to the
      // corrections training table (intent + field + before/after).
      correctionRepo,
      // U1 (E9) — re-draft handler factory: resolving an entity-disambiguation
      // clarification re-runs the original task handler (catalog-grounded for
      // invoice/estimate) with the chosen id and replaces the voice_clarification
      // with the drafted, executable proposal. Same gateway + catalog the voice
      // router uses, so grounding/summary/confidence stay identical.
      createRedraftHandlerFactory({ gateway: llmGateway, catalogRepo }),
      entityAliasCandidateCapture,
    ),
  );
  if (entityAliasRepo) {
    app.use('/api/entity-aliases', createEntityAliasesRouter(entityAliasRepo));
  }
  if (pool) {
    app.use('/api/interactions', createInteractionsRouter({ pool, dispatchRepo }));
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
  // from /api/agreements; persisted via PgMaintenanceContractRepository.
  app.use(
    '/api/maintenance-contracts',
    createMaintenanceContractsRouter(
      pool
        ? new PgMaintenanceContractRepository(pool)
        : new InMemoryMaintenanceContractRepository(),
      auditRepo,
    ),
  );

  // Recurring agreements sweep (P9-003). Runs every 60s. Uses the same
  // setInterval driver pattern as the execution-worker (P0-009). The
  // tenant lister falls back to an empty list outside of pg mode so
  // the in-memory dev server doesn't churn.
  const agreementsLogger = createLogger({
    service: 'recurring-agreements-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  // #6 phase 4 — off-session dues collection. Gated on pool + Stripe key; the
  // sweep skips collection when either is absent. The invoice is issued before
  // charging so a decline leaves a payable invoice (dunning), never a draft.
  const duesInvoiceOps: DuesInvoiceOps = {
    ensureIssuedAmountDue: async (tenantId, invoiceId) => {
      let inv = await invoiceRepo.findById(tenantId, invoiceId);
      if (inv && inv.status === 'draft') {
        inv = (await issueInvoice(tenantId, invoiceId, 30, invoiceRepo)) ?? inv;
      }
      return inv?.amountDueCents ?? 0;
    },
    recordPayment: async ({ tenantId, invoiceId, amountCents, providerReference, createdBy }) => {
      await recordPayment(
        {
          tenantId,
          invoiceId,
          amountCents,
          method: 'credit_card',
          providerReference,
          processedBy: createdBy,
          note: 'Membership dues (auto-collected)',
        },
        invoiceRepo,
        paymentRepo,
        undefined,
        undefined,
        auditRepo,
      );
    },
  };
  const duesCollector =
    pool && process.env.STRIPE_SECRET_KEY
      ? new StripeDuesCollector({
          customerPaymentMethodRepo,
          stripeConfig: { apiKey: process.env.STRIPE_SECRET_KEY },
          invoiceOps: duesInvoiceOps,
          // No connect resolver: charges target the account stored on the card
          // (set at save time from the webhook's event.account).
        })
      : undefined;
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.recurringAgreements, async () => {
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
          duesCollector,
          logger: agreementsLogger,
        });
      }).catch((err) => {
        agreementsLogger.error('Recurring-agreements sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60_000));
  }

  // RV-132 — recording retention purge. Hourly; pool-gated (the Pg repo is
  // the only implementation that can see the cross-tenant horizon query).
  // WS2: worker-only — the repo/logger below exist solely to feed this sweep.
  if (pool && shouldRunWorkers) {
    const retentionPool = pool;
    const recordingRetentionLogger = createLogger({
      service: 'recording-retention-worker',
      environment: process.env.NODE_ENV || 'development',
    });
    const recordingRetentionRepo = new PgRecordingRetentionRepository(retentionPool);
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.recordingRetention, async () => {
        await runRecordingRetentionSweep({
          repo: recordingRetentionRepo,
          storage: storageProvider,
          auditRepo,
          logger: recordingRetentionLogger,
        });
      }).catch((err) => {
        recordingRetentionLogger.error('Recording-retention sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60 * 60_000));
  }

  // Voice-parity (Feature 7) — call_me_back sweep. Notifies the CSR
  // (transfer_number) of callbacks captured when a warm transfer failed. Runs
  // every 60s; in-memory dev returns no tenants so it no-ops locally.
  const callMeBackLogger = createLogger({
    service: 'call-me-back-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.callMeBack, async () => {
        await runCallMeBackSweep({
          callMeBackRepo,
          settingsRepo,
          ...(messageDelivery
            ? {
                deliveryProvider: {
                  // Callback notice → CSR/transfer number (owner-side).
                  sendSms: (args: { to: string; body: string }) =>
                    messageDelivery.sendSms({ to: args.to, body: args.body, recipientClass: 'owner' }),
                },
              }
            : {}),
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          auditRepo,
          logger: callMeBackLogger,
        });
      }).catch((err) => {
        callMeBackLogger.error('call_me_back sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60_000));
  }

  // P8-015 — dropped-call recovery drain. The scheduler (wired above) has
  // been inserting durable dropped_call_recoveries rows since RV-115; this
  // sweep is what actually sends the ~60s recovery SMS. Dark by default:
  // every row is gated per-tenant on the DROPPED_CALL_RECOVERY_FLAG
  // (tenant override → platform flag → false), so enabling is an explicit
  // per-tenant action and the flag doubles as the kill switch.
  //
  // CORRECTNESS NOTE: findDue has no FOR UPDATE SKIP LOCKED row claiming —
  // the runAsLeader advisory lock is the only thing preventing two replicas
  // from sending the same row in the same tick. Never un-gate this sweep
  // without adding claiming; the per-row Twilio Idempotency-Key
  // (dropped_call_recovery:{row.id}) and markSent's sent_at IS NULL guard
  // are the second and third lines of defense.
  //
  // 30s cadence (not 60s): the product promise is "~60s after the drop";
  // rows are scheduled 60s out, so a 30s tick keeps worst-case latency
  // ≈90s instead of ≈2× the promise.
  // Gated on `pool` too, not just messageDelivery: with Twilio creds set but
  // no DATABASE_URL, messageDelivery is the REAL provider while the sweep would
  // otherwise install an always-allow rate-limiter stub — sending recovery SMS
  // with the one-per-caller cap silently disabled. No pool ⇒ no cross-process
  // limiter ⇒ don't run the sweep at all (matches PhoneRateLimiter's
  // no-in-memory-fallback rule).
  // WS2: worker-only — recoveryHandlerDeps below is built solely for this sweep.
  if (messageDelivery && pool && shouldRunWorkers) {
    const droppedCallLogger = createLogger({
      service: 'dropped-call-worker',
      environment: process.env.NODE_ENV || 'development',
    });
    const conversationLinkRepo = new PgConversationLinkRepository(pool);
    const recoveryHandlerDeps: Omit<DroppedCallHandlerDeps, 'repo'> = {
      audit: auditRepo,
      logger: droppedCallLogger,
      rateLimit: createRecoveryRateLimiter(new PhoneRateLimiter(pool), droppedCallLogger),
      resolvedSince: createDroppedCallResolvedSince({
        voiceSessionRepo,
        proposalRepo,
        logger: droppedCallLogger,
      }),
      // Compliance gate: a caller who texted STOP between the drop and the
      // send must never receive the recovery SMS. WS1 — also fail closed on
      // consent here (terminal markSuppressed) rather than at send time, so an
      // unknown/ambiguous caller under enforcement is suppressed once instead
      // of poison-pilling the sweep with a retryable SmsSuppressedError. The
      // central gate remains the send-time backstop.
      preSendSuppress: async (row) => {
        if (await dncRepo.isOnDnc(row.tenantId, normalizePhone(row.callerE164))) {
          return 'opted_out';
        }
        if (config.TCPA_CONSENT_ENFORCEMENT !== 'off') {
          const consent = await resolveCustomerConsentByPhone(row.tenantId, row.callerE164);
          if (!consent || consent.smsConsent !== true) return 'no_consent';
        }
        return null;
      },
      compose: createRecoveryComposer({
        composerDeps: { gateway: llmGateway, settingsRepo, standingInstructionRepo },
        businessName: process.env.TWILIO_BUSINESS_NAME ?? 'our team',
        // Brand-voice only with a real provider key — the mock gateway's
        // canned output must never reach a customer (digest precedent).
        aiEnabled: Boolean(config.AI_PROVIDER_API_KEY),
        logger: droppedCallLogger,
      }),
      // Unlike the callMeBack adapter above, this passes tenantId (per-tenant
      // Twilio subaccount routing) and the idempotency key (Twilio-side
      // double-send defense).
      // Customer-class: the ~60s recovery SMS to the dropped caller. preSendSuppress
      // above already blocks DNC'd numbers; the gate additionally enforces consent
      // (resolved by phone — unknown/ambiguous caller → fail closed).
      sendSms: async ({ tenantId, to, body, idempotencyKey }) => {
        const consent = await resolveCustomerConsentByPhone(tenantId, to);
        return (
          await messageDelivery.sendSms({
            to,
            body,
            tenantId,
            idempotencyKey,
            recipientClass: 'customer',
            ...(consent ? { consent } : {}),
          })
        ).providerMessageId;
      },
      // NOTE: no leadRepo — the dropped CALL is the lead-generating event and
      // is captured (source 'phone_call') by the inbound-call path. Passing
      // leadRepo here would make the OUTBOUND recovery SMS mint a lead with
      // inbound-text provenance ('system:sms-capture', source 'sms') and fire a
      // misleading "new text lead" owner push. Unknown callers thread under
      // sms_unmatched instead — still visible in the inbox, correct provenance.
      thread: createRecoveryThreader({
        conversationRepo,
        conversationLinkRepo,
        customerRepo,
        auditRepo,
        logger: droppedCallLogger,
      }),
    };
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.droppedCallRecovery, async () => {
        await runDroppedCallRecoverySweep({
          repo: droppedCallRecoveryRepo,
          handlerDeps: recoveryHandlerDeps,
          logger: droppedCallLogger,
          isEnabledForTenant: (tenantId) =>
            isFlagEnabledForTenant(tenantId, DROPPED_CALL_RECOVERY_FLAG),
        });
      }).catch((err) => {
        droppedCallLogger.error('dropped-call recovery sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 30_000));
  }

  // P21-003 — batch-invoice sweep. Daily-grained work; an hourly tick surfaces
  // newly-completed jobs promptly. Opt-in per tenant (settings.batchInvoiceEnabled);
  // in-memory dev returns no tenants so it no-ops locally.
  const batchInvoiceLogger = createLogger({
    service: 'batch-invoice-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.batchInvoice, async () => {
        await runBatchInvoiceSweep({
          jobRepo,
          invoiceRepo,
          estimateRepo,
          proposalRepo,
          settingsRepo,
          runRepo: batchInvoiceRunRepo,
          txRunner: batchInvoiceTxRunner,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          auditRepo,
          logger: batchInvoiceLogger,
        });
      }).catch((err) => {
        batchInvoiceLogger.error('Batch-invoice sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 3_600_000));
  }

  // RV-061 (F-9) — end-of-day digest sweep. Every 15 minutes, tenants whose
  // tenant-local digest_time fell in the just-passed bucket get their digest
  // computed (same query functions as the money dashboard), narrated via the
  // brand-voice composer (deterministic fallback when the LLM fails), stored
  // idempotently on (tenant, date), and sent to the owner's phone with
  // one-tap approve links. Same setInterval + leader-lock driver as the
  // other sweeps; in-memory dev returns no tenants so it no-ops locally.
  const dailyDigestLogger = createLogger({
    service: 'daily-digest-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  // Capture as const so the closure narrows (messageDelivery is a let).
  const digestDelivery = messageDelivery;
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.dailyDigest, async () => {
        await runDailyDigestSweep({
          settingsRepo,
          digestRepo: dailyDigestRepo,
          computeDeps: {
            paymentRepo,
            invoiceRepo,
            estimateRepo,
            jobRepo,
            appointmentRepo,
            proposalRepo,
            customerRepo,
            settingsRepo,
            feedbackResponseRepo,
            // N-005 — "what I learned today" (correction-loop lessons).
            correctionLessonRepo,
            // WS6 — "Checked: N proposals, M flagged" (supervisor reviews).
            supervisorReviewRepo: supervisorReviewsRepo,
            // WS22 — "K fixed" (flagged proposal edited after review).
            auditRepo,
          },
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          // Narrative through the brand-voice composer ONLY when a real LLM
          // provider is configured — the mock gateway's canned JSON must not
          // become an owner-facing narrative. Composer failures fall back to
          // the deterministic template inside the worker.
          ...(config.AI_PROVIDER_API_KEY
            ? {
                composeNarrative: async (tenantId: string, payload: DailyDigestPayload) => {
                  const result = await composeBrandVoiceMessage(
                    {
                      tenantId,
                      intent: 'digest_narrative',
                      // PII opt-in: counts only — no customer names or amounts
                      // beyond the aggregate figures the owner already sees.
                      context: {
                        moneyInCents: payload.revenueCents,
                        jobsCompleted: payload.jobsCompletedCount,
                        tomorrowVisits: payload.tomorrow.appointmentCount,
                        tomorrowFirstStart: payload.tomorrow.firstStartIso ?? 'none scheduled',
                        approvalsWaiting: payload.pendingApprovals.totalCount,
                        overdueInvoices: payload.overdueInvoicesCount,
                        unbilledCompletedJobs: payload.unbilledJobs.length,
                      },
                      maxChars: 420,
                    },
                    // UB-A3 — owner standing instructions (keyed on the
                    // digest_narrative intent) adjust the narrative content.
                    { gateway: llmGateway, settingsRepo, standingInstructionRepo },
                  );
                  return result.text;
                },
              }
            : {}),
          ...(digestDelivery ? { delivery: digestDelivery } : {}),
          dispatchRepo,
          ...(oneTapSecret ? { oneTapSecret } : {}),
          buildApproveUrl: (token: string) =>
            `${oneTapApiBaseUrl}/public/proposals/one-tap-approve?token=${encodeURIComponent(token)}`,
          publicBaseUrl,
          // U5 (JTBD #7) — record the "APPROVE ALL" anchor over the P2-034
          // transport. proposal_id is NOT NULL (FK), so the row uses the first
          // batch-approvable id as its representative; the full ordered set is
          // encoded in the body and read back by the reply handler.
          recordApproveAllAnchor: async ({ tenantId, proposalIds, body }) => {
            await proposalSmsEventRepo.create(
              createProposalSmsEvent({
                tenantId,
                proposalId: proposalIds[0]!,
                direction: 'outbound',
                kind: 'digest_approve_all_rendered',
                body: encodeDigestApproveAllBody(proposalIds),
              }),
            );
            // `body` is the rendered digest SMS; intentionally not stored on the
            // anchor (the id set is what the reply path needs, and the dispatch
            // row already records the send). Referenced to satisfy the seam.
            void body;
          },
          logger: dailyDigestLogger,
        });
      }).catch((err) => {
        dailyDigestLogger.error('Daily-digest sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, DIGEST_SWEEP_INTERVAL_MS));
  }

  // §6 Time-to-Cash: overdue-invoice sweep. Hourly — invoice due dates
  // have day granularity, so an hourly check surfaces newly-overdue
  // invoices promptly without churn. Same setInterval driver + tenant
  // lister pattern as the recurring-agreements sweep above; in-memory
  // dev returns no tenants so it no-ops locally.
  const overdueInvoiceLogger = createLogger({
    service: 'overdue-invoice-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.overdueInvoice, async () => {
        await runOverdueInvoiceSweep({
          jobRepo,
          estimateRepo,
          invoiceRepo,
          auditRepo,
          // §7 Collections cadence — raise owner-approved dunning proposals
          // (send_payment_reminder / apply_late_fee) per the tenant's dunning
          // policy, gated for idempotency by the dunning event ledger.
          proposalRepo,
          dunningConfigRepo,
          dunningEventRepo,
          // Owner `invoice_overdue` push dep (U6) — without it the push no-ops.
          customerRepo,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          logger: overdueInvoiceLogger,
        });
      }).catch((err) => {
        overdueInvoiceLogger.error('Overdue-invoice sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, Number(process.env.OVERDUE_SWEEP_INTERVAL_MS) > 0 ? Number(process.env.OVERDUE_SWEEP_INTERVAL_MS) : 60 * 60_000));
  }
  // QA-2026-06-05: interval is env-tunable (OVERDUE_SWEEP_INTERVAL_MS) so dev/QA
  // can observe the sweep inside a test window; default stays hourly.

  // HFCR weekly owner summary — one SMS per tenant per completed week,
  // idempotent via hfcr_weekly_sends. Only registered when an SMS sender is
  // wired (in-memory dev has none → no-op); reuses the owner-phone resolver
  // and the one-tap owner-SMS seam used by the unsupervised-routing path.
  //
  // Driven on a DAILY tick, not a 7-day one: a weekly setInterval would reset
  // on every redeploy (Railway redeploys far more often than weekly) and could
  // never elapse. The per-week hfcr_weekly_sends gate makes a daily run send
  // exactly one summary per tenant per completed week — restart-safe.
  if (oneTapSmsSender && shouldRunWorkers) {
    const oneTapOwnerSms = oneTapSmsSender;
    const hfcrWeeklyLogger = createLogger({
      service: 'hfcr-weekly-send-worker',
      environment: process.env.NODE_ENV || 'development',
    });
    registerInterval(
      setInterval(() => {
        void runAsLeader(SWEEP_LOCK.hfcrWeeklySend, async () => {
          await runHfcrWeeklySendSweep({
            paymentRepo,
            proposalRepo,
            auditRepo,
            hfcrSendRepo: hfcrWeeklySendRepo,
            resolveOwnerPhone: resolveUnsupervisedOwnerPhone,
            sendSms: (args) => oneTapOwnerSms(args.to, args.body),
            listTenantIds: async () => {
              if (!pool) return [];
              const r = await pool.query('SELECT id FROM tenants');
              return r.rows.map((row: { id: string }) => row.id);
            },
            logger: hfcrWeeklyLogger,
          });
        }).catch((err) => {
          hfcrWeeklyLogger.error('HFCR weekly send failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, 24 * 60 * 60_000),
    );
  }

  // Epic 12.6 — weekly feedback email. One advisor email per tenant per
  // completed week (performance snapshot + wins/misses/actions), idempotent
  // via a `weekly_feedback_email` audit event. Daily tick for restart-safety
  // (like the HFCR weekly sweep). Needs email delivery + a pool; suggestions
  // go through the LLM gateway only when a real provider is configured (the
  // mock gateway must not produce owner-facing text), else deterministic.
  if (messageDelivery && pool && shouldRunWorkers) {
    const weeklyFeedbackPool = pool;
    const weeklyFeedbackDelivery = messageDelivery;
    const weeklyFeedbackLogger = createLogger({
      service: 'weekly-feedback-worker',
      environment: process.env.NODE_ENV || 'development',
    });
    const runWeeklyFeedback = () => {
        void runAsLeader(SWEEP_LOCK.weeklyFeedback, async () => {
          await runWeeklyFeedbackSweep({
            auditRepo,
            // WS22 — "same mistake twice" weekly rate (repeatCorrections).
            buildSnapshot: (tenantId, weekStart, weekEnd) =>
              buildWeeklyFeedbackSnapshot(weeklyFeedbackPool, tenantId, weekStart, weekEnd, correctionRepo),
            resolveOwnerEmail: async (tenantId) => {
              const r = await weeklyFeedbackPool.query(
                'SELECT owner_email FROM tenants WHERE id = $1',
                [tenantId],
              );
              return (r.rows[0]?.owner_email as string | undefined) ?? null;
            },
            isFeedbackEnabled: async (tenantId) => {
              const s = await settingsRepo.findByTenant(tenantId);
              return s?.weeklyFeedbackEnabled !== false;
            },
            resolveBusinessName: async (tenantId) => {
              const s = await settingsRepo.findByTenant(tenantId);
              return s?.businessName ?? null;
            },
            sendEmail: (args) =>
              weeklyFeedbackDelivery.sendEmail({
                to: args.to,
                subject: args.subject,
                text: args.text,
                html: args.html,
              }),
            listTenantIds: async () => {
              const r = await weeklyFeedbackPool.query('SELECT id FROM tenants');
              return r.rows.map((row: { id: string }) => row.id);
            },
            logger: weeklyFeedbackLogger,
            ...(config.AI_PROVIDER_API_KEY
              ? {
                  composeSuggestions: async (tenantId, snapshot) => {
                    const res = await llmGateway.complete({
                      taskType: 'weekly_feedback_suggestions',
                      messages: [{ role: 'user', content: buildSuggestionsPrompt(snapshot) }],
                      responseFormat: 'json',
                      temperature: 0.4,
                      maxTokens: 400,
                      tenantId,
                    });
                    return parseSuggestions(res.content);
                  },
                }
              : {}),
          });
        }).catch((err) => {
          weeklyFeedbackLogger.error('Weekly feedback sweep failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    };
    // Run once on boot so frequent redeploys don't postpone the weekly send
    // indefinitely (a pure 24h setInterval never elapses if the process keeps
    // restarting). The per-week audit gate keeps this to one email per week.
    runWeeklyFeedback();
    registerInterval(setInterval(runWeeklyFeedback, 24 * 60 * 60_000));
  }

  // F17 — push paid invoices + customers to QuickBooks every 5 minutes.
  if (qboConfig && shouldRunWorkers) {
    const accountingSyncLogger = createLogger({
      service: 'accounting-sync-worker',
      environment: process.env.NODE_ENV || 'development',
    });
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.accountingSync, async () => {
        await runAccountingSyncSweep({
          integrationRepo: accountingIntegrationRepo,
          syncLogRepo: accountingSyncLogRepo,
          invoiceRepo,
          customerRepo,
          jobRepo,
          qboConfig,
          logger: accountingSyncLogger,
        });
      }).catch((err) => {
        accountingSyncLogger.error('Accounting sync sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, ACCOUNTING_SYNC_INTERVAL_MS));
  }

  const appointmentReminderLogger = createLogger({
    service: 'appointment-reminder-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (transactionalComms && shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.appointmentReminder, async () => {
        await runAppointmentReminderSweep({
          appointmentRepo,
          transactionalComms,
          // Owner `appointment_reminder` push deps (U4) — without all four the
          // owner push no-ops; message_dispatches gives it an independent
          // idempotency key from the customer SMS.
          jobRepo,
          customerRepo,
          settingsRepo,
          dispatchRepo,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          logger: appointmentReminderLogger,
        });
      }).catch((err) => {
        appointmentReminderLogger.error('Appointment-reminder sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60 * 60_000));
  }

  // U6 — held-slot reaper. Every 15 minutes, cancel tentative holds whose
  // hold_expiry_at has passed so the stale rows leave raw appointment reads.
  // Leader-locked + idempotent (only acts on rows still hold_pending_approval).
  const holdReaperLogger = createLogger({
    service: 'hold-reaper-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.holdReaper, async () => {
        await runHoldReaperSweep({
          appointmentRepo,
          auditRepo,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          logger: holdReaperLogger,
        });
      }).catch((err) => {
        holdReaperLogger.error('Hold-reaper sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 15 * 60_000));
  }

  // Estimate-reminder worker — nudges customers on estimates sent but
  // unviewed/unaccepted after 3 days (1 reminder, capped). Only runs when
  // SendService is configured (it re-sends via the unified send path).
  const estimateReminderLogger = createLogger({
    service: 'estimate-reminder-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (sendService && shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.estimateReminder, async () => {
        await runEstimateReminderSweep({
          estimateRepo,
          sendService,
          auditRepo,
          pool: pool ?? null,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          logger: estimateReminderLogger,
        });
      }).catch((err) => {
        estimateReminderLogger.error('Estimate-reminder sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60 * 60_000));
  }

  // Estimate-expiry worker — transitions sent estimates past their
  // valid_until date to 'expired' so stale quotes can't be accepted and
  // the pipeline reflects lapsed offers. Runs hourly; no SendService
  // dependency (it only changes status).
  const estimateExpiryLogger = createLogger({
    service: 'estimate-expiry-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.estimateExpiry, async () => {
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
      }).catch((err) => {
        estimateExpiryLogger.error('Estimate-expiry sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60 * 60_000));
  }

  // §5.5 Proposal-expiry worker — transitions schedule proposal cards
  // (create_appointment / create_booking / reschedule_appointment) past their
  // 48h `expiresAt` to 'expired' so stale bookings don't linger in the inbox.
  // Every other proposal type carries no expiry and is untouched. Hourly; no
  // SendService dependency (it only changes status).
  const proposalExpiryLogger = createLogger({
    service: 'proposal-expiry-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.proposalExpiry, async () => {
        await runProposalExpirySweep({
          proposalRepo,
          auditRepo,
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          logger: proposalExpiryLogger,
        });
      }).catch((err) => {
        proposalExpiryLogger.error('Proposal-expiry sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60 * 60_000));
  }

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
  // (Loader instances are constructed next to serviceCreditRepo above and
  // shared with the voice respond_to_review on-ramp — U3.)
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
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      if (
        !googleReviewsReviewRepo ||
        !googleReviewsPollStateRepo ||
        !googleReviewsCredResolver
      ) {
        return;
      }
      void runAsLeader(SWEEP_LOCK.googleReviews, async () => {
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
      }).catch((err) => {
        googleReviewsLogger.error('Google reviews sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 15 * 60_000));
  }

  // Post-job thank-you SMS sweep (PRD §7.2). Same P0-009 sweep idiom as
  // google-reviews / overdue-invoice / appointment-reminder. The pool
  // guard inside the worker no-ops cleanly when running in-memory.
  const thankYouSmsLogger = createLogger({
    service: 'thank-you-sms-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.thankYouSms, async () => {
        await runThankYouSmsSweep({
          pool: pool ?? null,
          jobRepo,
          customerRepo,
          settingsRepo,
          dncRepo,
          dispatcher: feedbackDispatcher,
          auditRepo,
          logger: thankYouSmsLogger,
        });
      }).catch((err) => {
        thankYouSmsLogger.error('Thank-you SMS sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 10 * 60_000));
  }

  // Post-job review request (PRD US-345) — fires 24h after completion via the
  // same P0-009 leader-locked sweep idiom; reuses the feedback_send worker for
  // gated delivery (the immediate on-completion enqueue was removed).
  const reviewRequestLogger = createLogger({
    service: 'review-request-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.reviewRequest, async () => {
        await runReviewRequestSweep({
          pool: pool ?? null,
          jobRepo,
          queue,
          logger: reviewRequestLogger,
        });
      }).catch((err) => {
        reviewRequestLogger.error('Review-request sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 10 * 60_000));
  }

  // Onboarding lifecycle email sweeps (setup reminder + trial-ending). Same
  // P0-009 sweep idiom; the pool guard inside each no-ops when running
  // in-memory, and each send claims the lifecycle_emails ledger so a re-tick
  // never double-sends.
  const lifecycleSweepLogger = createLogger({
    service: 'lifecycle-email-sweep',
    environment: process.env.NODE_ENV || 'development',
  });
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.setupReminder, async () => {
        await runSetupReminderSweep({
          pool: pool ?? null,
          settingsRepo,
          delivery: messageDelivery,
          auditRepo,
          appBaseUrl: lifecycleEmailAppBaseUrl,
          supportEmail: lifecycleEmailSupportEmail,
          logger: lifecycleSweepLogger,
        });
      }).catch((err) => {
        lifecycleSweepLogger.error('Setup-reminder sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60 * 60_000));
  }
  if (shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.trialReminder, async () => {
        await runTrialReminderSweep({
          pool: pool ?? null,
          settingsRepo,
          delivery: messageDelivery,
          auditRepo,
          appBaseUrl: lifecycleEmailAppBaseUrl,
          supportEmail: lifecycleEmailSupportEmail,
          logger: lifecycleSweepLogger,
        });
      }).catch((err) => {
        lifecycleSweepLogger.error('Trial-reminder sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60 * 60_000));
  }

  // U5 — the redundant P5-020 hourly digest worker was removed; the daily
  // digest (RV-063 runDailyDigestSweep, scheduled above on the dailyDigest
  // lock) is the single digest path. Removing it also resolved the advisory-
  // lock collision where the old digest sweep and hfcrWeeklySend both held
  // 590014.

  // P8-009: in-app voice session adapter. Reuses the LLM gateway, the
  // unified TTS provider, and the existing proposal/audit/oncall repos.
  // The voiceSessionStore is shared with the Twilio adapter (created above).
  const ttsProvider = createTtsProvider({
    TTS_PROVIDER: process.env.TTS_PROVIDER,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
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
    // RV-115 — durable dropped-call recovery with the FSM context snapshot.
    // (In-app sessions rarely have a caller phone; the scheduler's own
    // detection rejects rows without a usable E.164.)
    droppedCallScheduler,
    // Voice-parity (Feature 6) — gate Spanish auto-detection on the tenant's
    // opt-in stack (supported_languages). Without this the in-app path would
    // treat any Spanish utterance as allowed and ignore the Settings toggle.
    supportedLanguagesResolver: async (tenantId: string) => {
      const s = await settingsRepo.findByTenant(tenantId);
      return s?.supportedLanguages;
    },
    extendedIntentsEnabled: voiceExtendedIntentsFlagShim,
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

  // D2-1c — audit-log platform-admin feature-flag upsert / delete.
  // (featureFlagRepo / featureFlagStore are constructed earlier, alongside
  // the per-tenant flag repo — see the RV-122 wiring block.)
  app.use(
    '/api/admin/feature-flags',
    createFeatureFlagsRouter(featureFlagRepo, featureFlagStore, {}, auditRepo),
  );

  // Platform-admin tenant lifecycle (hard-delete / deprovision). Requires a
  // DB pool; the queue is always present (Pg- or in-memory).
  if (pool) {
    app.use('/api/admin/tenants', createAdminTenantsRouter({ pool, queue }));
  }

  // ── Rivet P2 F-1: Supervisor Agent v1 ─────────────────────────────────────
  //
  // Two halves: (a) the deterministic policy hook installed into
  // createProposal via module-level configure (see supervisor/hook.ts for
  // the injection rationale — createProposal is a sync pure builder with
  // 50+ call sites, so a repo dep can't be threaded through them), and
  // (b) the advisory annotator sweep that adds LLM risk notes to
  // ready_for_review proposals.
  //
  // U3 — the supervisor is now DEFAULT-ON (D-011): the per-tenant
  // 'supervisor_agent' flag resolves tenant_feature_flags override → platform
  // flag → DEFAULT TRUE. So the trust mechanism is on for everyone, and the
  // per-tenant override (enabled=false) is an explicit opt-OUT kill switch for
  // incidents. The policy engine is monotone-downgrade only (capInitialStatus),
  // so default-on can never UPGRADE a proposal to auto-approval (D-004) — the
  // worst case is "more proposals held for review". Routes/settings exposure
  // for policy versions is deferred to a follow-up track.
  //
  // Merge note: this reuses the single shared PgTenantFeatureFlagRepository
  // constructed in the RV-122 wiring block above (`tenantFeatureFlags`) —
  // one instance serves both the per-tenant triage/voice flag resolution
  // and the supervisor gate (its 30s cache is per-instance only). With no pool
  // (tests/dev) the gate is undefined → the service defaults enabled=true, so
  // default-on holds in every environment.
  const supervisorFlagGate = tenantFeatureFlags
    ? (tenantId: string) =>
        tenantFeatureFlags.isEnabledForTenantWithDefault(tenantId, 'supervisor_agent', true)
    : undefined;
  // U3 — conservative platform-default budget caps for tenants without a
  // provisioned supervisor_policies row. Env-overridable for ops tuning; the
  // caps only ADD review friction (force_review / block), never remove safety.
  const platformDefaultSupervisorRules: SupervisorRules = {
    perProposalCapCents:
      Number(process.env.SUPERVISOR_DEFAULT_PER_PROPOSAL_CAP_CENTS) || 250_000,
    dailySpendCapCents:
      Number(process.env.SUPERVISOR_DEFAULT_DAILY_SPEND_CAP_CENTS) || 1_000_000,
    maxAutoApprovalsPerHour:
      Number(process.env.SUPERVISOR_DEFAULT_MAX_AUTO_APPROVALS_PER_HOUR) || 30,
  };
  const supervisorLogger = createLogger({
    service: 'supervisor-agent',
    environment: process.env.NODE_ENV || 'development',
  });
  const supervisorService = new SupervisorPolicyService({
    policies: pool
      ? new PgSupervisorPolicyRepository(pool)
      : new InMemorySupervisorPolicyRepository(),
    counters: pool
      ? new PgTenantBudgetCounterRepository(pool)
      : new InMemoryTenantBudgetCounterRepository(),
    auditRepo,
    ...(supervisorFlagGate ? { isEnabledForTenant: supervisorFlagGate } : {}),
    defaultRules: platformDefaultSupervisorRules,
    logger: supervisorLogger,
  });
  // Process-global hook: second createApp() in one process re-binds (last-wins).
  // Never uninstalled on shutdown — benign: fail-open + fire-and-forget.
  // Tests must reset via configureSupervisorCreationHook(null).
  configureSupervisorCreationHook(supervisorService);

  // N-004 (P2-037) — install the four-check pre-dispatch review gate.
  // Default mode is shadow (compute + log + mark, never hold) — the safe
  // default given alert-fatigue is the named risk; SUPERVISOR_REVIEW_MODE can
  // promote a deploy to 'enforce' (holds active on customer-harm criticals) or
  // 'off'. Boot-time invariant: the reviewer model must differ from the primary
  // drafting model (a same-model reviewer is degraded, not broken — warn + run).
  const supervisorReviewModel = resolveModelForTaskType(
    DEFAULT_AI_ROUTING_CONFIG,
    'supervisor_review',
  );
  const modelCollision = assertSupervisorReviewModelDistinct(DEFAULT_AI_ROUTING_CONFIG);
  if (modelCollision) {
    supervisorLogger.warn(
      'supervisor-review: reviewer model equals a primary drafting model (degraded)',
      modelCollision,
    );
  }
  const envReviewMode = (process.env.SUPERVISOR_REVIEW_MODE ?? '').trim();
  const supervisorReviewMode: SupervisorReviewMode =
    envReviewMode === 'off' || envReviewMode === 'shadow' || envReviewMode === 'enforce'
      ? envReviewMode
      : DEFAULT_SUPERVISOR_REVIEW_MODE;
  const supervisorPricingBaseline = pool ? new PgPricingBaselineResolver(pool) : null;
  configureSupervisorReviewGate(
    createSupervisorReviewGate({
      gateway: llmGateway,
      aiRunRepo,
      // WS6 — reuse the hoisted instance (the digest worker deps share it).
      reviewsRepo: supervisorReviewsRepo,
      proposalRepo,
      supervisorModel: supervisorReviewModel,
      resolveMode: async () => supervisorReviewMode,
      ...(supervisorPricingBaseline
        ? { resolveBaseline: (p) => supervisorPricingBaseline.resolve(p.tenantId) }
        : {}),
      resolveAccountType: async (p) => {
        const payload = (p.payload ?? {}) as Record<string, unknown>;
        const src = (p.sourceContext ?? {}) as Record<string, unknown>;
        const customerId =
          (typeof payload.customerId === 'string' && payload.customerId) ||
          (typeof src.customerId === 'string' && src.customerId) ||
          null;
        if (!customerId) return null;
        try {
          const customer = await customerRepo.findById(p.tenantId, customerId);
          return customer?.accountType ?? null;
        } catch {
          return null;
        }
      },
      resolveBannedPhrases: async (tenantId) => {
        try {
          const settings = await settingsRepo.findByTenant(tenantId);
          return settings?.brandVoice?.banned_phrases ?? [];
        } catch {
          return [];
        }
      },
      logger: supervisorLogger,
    }),
  );

  // Close the executed-spend loop declared next to the ProposalExecutor.
  supervisorSpendRecorder = (tenantId, proposalId) =>
    recordExecutedProposalSpend({
      service: supervisorService,
      proposalRepo,
      tenantId,
      proposalId,
      logger: supervisorLogger,
    });
  // Advisory annotator sweep — scheduled whenever a REAL LLM provider is
  // configured (the mock gateway's canned JSON must never be written into
  // proposal payloads as a "risk note"). It runs for every NON-opted-out
  // tenant by default: the same inverted opt-out gate as the creation hook
  // is passed through, so a tenant with no flag set is swept and only an
  // explicitly opted-out tenant is skipped. Stays advisory — never a status
  // change.
  if (config.AI_PROVIDER_API_KEY && shouldRunWorkers) {
    registerInterval(setInterval(() => {
      void runAsLeader(SWEEP_LOCK.supervisorAnnotate, async () => {
        await runSupervisorAnnotationSweep({
          listTenantIds: async () => {
            if (!pool) return [];
            const r = await pool.query('SELECT id FROM tenants');
            return r.rows.map((row: { id: string }) => row.id);
          },
          proposalRepo,
          gateway: llmGateway,
          ...(supervisorFlagGate ? { isEnabledForTenant: supervisorFlagGate } : {}),
          logger: supervisorLogger,
        });
      }).catch((err) => {
        supervisorLogger.error('Supervisor annotation sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, SUPERVISOR_ANNOTATE_SWEEP_INTERVAL_MS));
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
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { statusCode, body } = toErrorResponse(err);
    // OBS — surface server 5xx in PostHog (api_error), attributable to the
    // already-redacted route + tenant, so "where are customers hitting bugs"
    // covers the backend too. Off-by-default; wrapped so analytics can never
    // turn an error response into a thrown handler. No body/headers/message.
    if (statusCode >= 500) {
      try {
        const anyReq = req as unknown as {
          safeRequestLog?: { route?: string };
          auth?: { tenantId?: string; userId?: string };
        };
        recordApiError({
          route: anyReq.safeRequestLog?.route ?? req.path,
          status: statusCode,
          tenantId: anyReq.auth?.tenantId ?? null,
          userId: anyReq.auth?.userId ?? null,
        });
      } catch {
        // analytics must never break the error response
      }
    }
    res.status(statusCode).json(body);
  });

  // Marketing/legal pages moved to the standalone marketing site — forward
  // the retired in-app paths (/pricing, /privacy, …) there before the SPA
  // catch-all can serve index.html for them.
  registerMarketingRedirects(app);

  // Catch-all route for client-side routing — serves index.html for all non-API routes
  // This allows the React SPA to handle routing on the client side.
  // This route sits AFTER the global error handler, so sendFile's next(err)
  // would fall through to Express's default handler (stack trace in dev) —
  // handle the error in the callback instead.
  app.get('*', (req, res) => {
    const frontendPath = resolveWebDistDir(__dirname);
    const indexPath = require('path').join(frontendPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Frontend assets unavailable' });
      }
    });
  });

  // P0-023: Graceful shutdown — close the Postgres pool on SIGTERM/SIGINT so
  // Railway's stop signal doesn't strand active connections. We use
  // `process.once` so repeated `createApp()` calls inside the test runner
  // don't stack handlers, and we exit only when the pool finishes draining
  // (or after a 5s safety timeout). Server lifecycle is owned by index.ts —
  // this handler only takes responsibility for the DB pool.
  //
  // ARCH-02: wrapped in a memoized promise so it is idempotent — index.ts's
  // fatal-error handler and this module's own SIGTERM/SIGINT listeners can
  // all reach this function, and only the FIRST caller actually runs
  // teardown; every subsequent caller (concurrent SIGTERM during a fatal
  // drain, or vice versa) awaits the same in-flight drain instead of
  // re-entering it (which would double-close the pool/Redis clients).
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(reason);
    return shutdownPromise;
  };
  const runShutdown = async (signal: string) => {
    try {
      // eslint-disable-next-line no-console
      console.log(`[app] ${signal} received — stopping background loops, closing voice sessions and pg pool`);
      // P4/U-P4a — flip the drain flag so /ready 503s and new WS upgrades
      // (dashboards + Twilio media streams) are rejected.
      setDraining(true);
      // Blocker 5 — stop all background setInterval loops (sweeps, queue poll,
      // execution worker) and set `shuttingDown` IMMEDIATELY, BEFORE the voice
      // drain wait below. The drain wait can run for the full DRAIN_TIMEOUT_MS
      // (~25s); if the queue poller and leader-gated sweeps kept ticking through
      // it they would claim fresh DB/Redis work right up to the deadline, then
      // get torn down with jobs in flight. `shuttingDown` also prevents an
      // already-scheduled leader sweep tick from starting new work. Voice
      // sessions are in-memory FSMs and don't depend on these loops, so halting
      // them first does not impede the drain. (Codex review on PR #628.)
      shuttingDown = true;
      for (const handle of backgroundIntervals) clearInterval(handle);
      // Now DRAIN: wait (bounded) for in-flight voice sessions to finish before
      // tearing down the pool/Redis/sessions. The window must be shorter than
      // index.ts's force-exit and Railway's stop grace period; calls still live
      // at the deadline are closed by the teardown below (Twilio ends the call).
      const drainDeadline = Date.now() + (Number(process.env.DRAIN_TIMEOUT_MS) || 25_000);
      while (voiceSessionStore.liveCount() > 0 && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      console.log(`[app] drain complete — ${voiceSessionStore.liveCount()} live session(s) still active at teardown`);
      // WS15 — drain-abandonment alarm: the window expired with live calls
      // remaining, so teardown below hangs up on real callers (Twilio ends
      // them). emitDrainAbandonment is synchronous fire-and-forget (Sentry
      // captureMessage enqueues into the client's transport buffer — no await
      // that could eat into the force-exit backstop) and never throws. The
      // Prometheus counter it increments dies with this process; the Sentry
      // error event is the durable alarm.
      if (voiceSessionStore.liveCount() > 0) {
        emitDrainAbandonment(
          voiceSessionStore.liveCount(),
          voiceSessionStore.liveCallSids(),
          { sentry: sentryClient, logger: requestLogger },
        );
      }
      // Stop the voice-session-store reaper interval so the process can
      // exit cleanly even when no DB pool is wired (dev / in-memory mode).
      voiceSessionStore.dispose();
      // Flush any queued PostHog server-side funnel events before the
      // process exits so Railway shutdown doesn't drop in-flight
      // signup/trial/conversion captures.
      {
        const { shutdownAnalytics } = await import('./analytics/posthog');
        await shutdownAnalytics();
      }
      // Disconnect Redis cache store(s) before draining the DB pool so Railway
      // shutdown is not slowed by lingering Redis connections.
      await shutdownCacheStores();
      // scale-to-1000 U3a — close shared Redis clients (WS connection cap, voice
      // fan-out, quota, and the refactored cache) after the cache flush and
      // BEFORE the pg pool drains, in the same shutdown slot as the cache.
      await shutdownRedisClients();
      if (pool) {
        await Promise.race([
          pool.end(),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
      // Close the direct pool too when it's a SEPARATE pool (DATABASE_DIRECT_URL
      // set). When it falls back to the main pool it was already drained above.
      if (directPool && directPool !== pool) {
        await Promise.race([
          directPool.end(),
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

  // ARCH-02: share the exact same (idempotent, bounded) drain sequence with
  // index.ts's fatal-error handler — see AppWithLifecycle above.
  const appWithLifecycle = app as AppWithLifecycle;
  appWithLifecycle.gracefulDrain = shutdown;
  // WS2 — snapshot the registered interval count for the process-role split.
  // All registrations happen above, so this is final at return time.
  Object.defineProperty(appWithLifecycle, 'backgroundIntervalCount', {
    value: backgroundIntervals.length - observabilityIntervalCount,
    writable: false,
    enumerable: false,
  });

  return appWithLifecycle;
}
