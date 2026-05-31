// Composition-root: pure repository constructions extracted from app.ts's
// createApp(). Each repo is Pg-backed when a Pool is provided (production /
// staging) and falls back to an in-memory implementation for local dev / tests
// without DATABASE_URL. None of these constructions reference any local other
// than `pool`, so they can be built up-front and destructured back into
// createApp(). Each name is declared exactly once here, so destructuring
// yields the same single instances callers (e.g. the webhook router, which
// deliberately shares webhookAuditRepo / webhookEventRepo / jobRepo) rely on.

import type { Pool } from 'pg';

import { InMemoryAgreementRepository } from '../agreements/agreement';
import { InMemoryAgreementRunRepository } from '../agreements/agreement-run';
import { PgAgreementRepository } from '../agreements/pg-agreement';
import { PgAgreementRunRepository } from '../agreements/pg-agreement-run';
import { InMemoryAiRunRepository } from '../ai/ai-run';
import { InMemoryDiffAnalysisRepository } from '../ai/diff-analysis';
import { InMemoryDocumentRevisionRepository } from '../ai/document-revision';
import { PgAiRunRepository } from '../ai/pg-ai-run';
import { PgDiffAnalysisRepository } from '../ai/pg-diff-analysis';
import { PgDocumentRevisionRepository } from '../ai/pg-document-revision';
import {
  InMemoryKnowledgeChunkRepository,
  PgKnowledgeChunkRepository,
} from '../ai/training/knowledge-chunks';
import { PgRetrievalEvalRunRepository } from '../ai/training/pg-retrieval-eval-run';
import { InMemoryRetrievalEvalRunRepository } from '../ai/training/retrieval-eval-run';
import { InMemoryAppointmentRepository } from '../appointments/appointment';
import { InMemoryAssignmentRepository } from '../appointments/assignment';
import { PgAppointmentRepository } from '../appointments/pg-appointment';
import { PgAssignmentRepository } from '../appointments/pg-assignment';
import { InMemoryAuditRepository } from '../audit/audit';
import { PgAuditRepository } from '../audit/pg-audit';
import { DevInMemoryTenantRepository } from '../auth/dev-auth-bypass';
import { PgTenantRepository } from '../auth/pg-tenant';
import { PgWorkingHoursRepository } from '../availability/pg-working-hours';
import { InMemoryWorkingHoursRepository } from '../availability/working-hours';
import { InMemoryCatalogItemRepository } from '../catalog/catalog-item';
import { PgCatalogItemRepository } from '../catalog/pg-catalog-item';
import { InMemoryDncRepository, PgDncRepository } from '../compliance/dnc';
import { InMemoryConversationRepository } from '../conversations/conversation-service';
import { PgConversationRepository } from '../conversations/pg-conversation';
import { InMemoryCustomerRepository } from '../customers/customer';
import { PgCustomerRepository } from '../customers/pg-customer';
import { InMemoryDispatchAnalyticsRepository } from '../dispatch/analytics';
import { PgDispatchAnalyticsRepository } from '../dispatch/pg-analytics';
import { InMemoryApprovalRepository } from '../estimates/approval';
import { InMemoryEditDeltaRepository } from '../estimates/edit-delta';
import { InMemoryEstimateRepository } from '../estimates/estimate';
import { PgApprovalRepository } from '../estimates/pg-approval';
import { PgEditDeltaRepository } from '../estimates/pg-edit-delta';
import { PgEstimateRepository } from '../estimates/pg-estimate';
import { InMemoryExpenseRepository } from '../expenses/expense';
import { PgExpenseRepository } from '../expenses/pg-expense';
import { InMemoryFeedbackRequestRepository } from '../feedback/feedback-request';
import { InMemoryFeedbackResponseRepository } from '../feedback/feedback-response';
import { PgFeedbackRequestRepository } from '../feedback/pg-feedback-request';
import { PgFeedbackResponseRepository } from '../feedback/pg-feedback-response';
import { InMemoryFileRepository } from '../files/file-service';
import { InMemoryJobFileRepository } from '../files/job-file-repository';
import { PgFileRepository } from '../files/pg-file';
import { PgJobFileRepository } from '../files/pg-job-file';
import { FeatureFlagRepository, InMemoryFeatureFlagRepository } from '../flags/feature-flags';
import { PgFeatureFlagRepository } from '../flags/pg-feature-flags';
import {
  InMemoryCalendarIntegrationRepository,
  InMemoryOAuthStateRepository,
  PgCalendarIntegrationRepository,
  PgOAuthStateRepository,
} from '../integrations/calendar-integration';
import {
  InMemoryAppointmentCalendarEventRepository,
  PgAppointmentCalendarEventRepository,
} from '../integrations/calendar-sync';
import { PgPhoneNumberRepository } from '../integrations/twilio/phone-number-repository';
import { InMemoryBatchInvoiceRunRepository } from '../invoices/batch-invoice-run';
import { InMemoryInvoiceRepository } from '../invoices/invoice';
import { InMemoryInvoiceScheduleRepository } from '../invoices/invoice-schedule';
import { InMemoryPaymentRepository } from '../invoices/payment';
import { PgBatchInvoiceRunRepository } from '../invoices/pg-batch-invoice-run';
import { PgInvoiceRepository } from '../invoices/pg-invoice';
import { PgInvoiceScheduleRepository } from '../invoices/pg-invoice-schedule';
import { PgPaymentRepository } from '../invoices/pg-payment';
import { InMemoryJobRepository } from '../jobs/job';
import { InMemoryJobTimelineRepository } from '../jobs/job-lifecycle';
import { InMemoryJobPhotoRepository } from '../jobs/job-photo';
import { PgJobRepository } from '../jobs/pg-job';
import { PgJobTimelineRepository } from '../jobs/pg-job-lifecycle';
import { PgJobPhotoRepository } from '../jobs/pg-job-photo';
import { InMemoryLeadRepository } from '../leads/lead';
import { PgLeadRepository } from '../leads/pg-lead';
import { InMemoryLocationRepository } from '../locations/location';
import { PgLocationRepository } from '../locations/pg-location';
import { InMemoryLookupEventRepository } from '../lookup-events/lookup-event';
import { PgLookupEventRepository } from '../lookup-events/pg-lookup-event';
import { InMemoryNoteRepository } from '../notes/note';
import { PgNoteRepository } from '../notes/pg-note';
import { InMemoryDelayNoticeStateRepository } from '../notifications/delay-notifications';
import {
  InMemoryDispatchRepository,
  PgDispatchRepository,
} from '../notifications/dispatch-repository';
import { PgDelayNoticeStateRepository } from '../notifications/pg-delay-notice-state';
import { InMemoryOnCallRepository, PgOnCallRepository } from '../oncall/rotation';
import { PgPortalSessionRepository } from '../portal/pg-portal-session';
import { InMemoryPortalSessionRepository, PortalSessionRepository } from '../portal/portal-session';
import {
  NoOpIdempotencyLockProvider,
  PgIdempotencyLockProvider,
} from '../proposals/execution/idempotency-lock';
import { PgProposalExecutionRepository } from '../proposals/pg-proposal-execution';
import { InMemoryProposalExecutionRepository } from '../proposals/proposal-execution';
import { InMemoryQualityMetricsRepository } from '../quality/metrics';
import { PgQualityMetricsRepository } from '../quality/pg-metrics';
import { PgQueue } from '../queues/pg-queue';
import { InMemoryQueue } from '../queues/queue';
import {
  InMemoryRevenueBySourceRepository,
  PgRevenueBySourceRepository,
} from '../reports/revenue-by-source';
import { PgCustomerLoader } from '../reputation/match-customer';
import { PgReviewRepository } from '../reputation/pg-review';
import { PgServiceCreditRepository } from '../reputation/pg-service-credit';
import { PgReviewPollStateRepository } from '../reputation/poll-state';
import { InMemoryPackActivationRepository } from '../settings/pack-activation';
import { PgPackActivationRepository } from '../settings/pg-pack-activation';
import { PgSettingsRepository } from '../settings/pg-settings';
import { InMemorySettingsRepository } from '../settings/settings';
import { PgVerticalPackRegistry } from '../shared/pg-vertical-pack-registry';
import {
  InMemoryVerticalPackRegistry as InMemoryCanonicalVerticalPackRegistry,
} from '../shared/vertical-pack-registry';
import { PgTechnicianLocationPingRepository } from '../telemetry/pg-technician-location-ping';
import {
  InMemoryTechnicianLocationAuthorizer,
  PgTechnicianLocationAuthorizer,
} from '../telemetry/technician-location-authz';
import { InMemoryTechnicianLocationPingRepository } from '../telemetry/technician-location-ping';
import { InMemoryEstimateTemplateRepository } from '../templates/estimate-template';
import { PgEstimateTemplateRepository } from '../templates/pg-estimate-template';
import { PgTimeEntryRepository } from '../time-tracking/pg-time-entry';
import { InMemoryTimeEntryRepository } from '../time-tracking/time-entry';
import { InMemoryPendingInvitationRepository } from '../users/pending-invitation';
import { PgPendingInvitationRepository } from '../users/pg-pending-invitation';
import { PgUserRepository } from '../users/pg-user';
import { InMemoryUserRepository } from '../users/user';
import { InMemoryServiceBundleRepository } from '../verticals/bundles';
import {
  InMemoryPrivacyAuditRepository,
  InMemoryTrainingAssetRepository,
} from '../verticals/in-memory-training-assets';
import { PgServiceBundleRepository } from '../verticals/pg-bundles';
import {
  PgPrivacyAuditRepository,
  PgTrainingAssetRepository,
} from '../verticals/pg-training-assets';
import { InMemoryCallTranscriptTurnRepository } from '../voice/call-transcript-turn';
import { PgCallTranscriptTurnRepository } from '../voice/pg-call-transcript-turn';
import { PgVoiceRepository } from '../voice/pg-voice';
import { PgVoiceSessionRepository } from '../voice/pg-voice-session';
import { InMemoryVoiceRepository } from '../voice/voice-service';
import { InMemoryVoiceSessionRepository } from '../voice/voice-session';
import { InMemoryWebhookEventRepository } from '../webhooks/in-memory-webhook-event';
import { PgWebhookRepository } from '../webhooks/pg-webhook';
import { PgWebhookEventRepository } from '../webhooks/pg-webhook-event';

export function buildRepositories(pool: Pool | undefined) {
  const tenantRepo = pool
    ? new PgTenantRepository(pool)
    : new DevInMemoryTenantRepository();
  const webhookSettingsRepo = pool
    ? new PgSettingsRepository(pool)
    : new InMemorySettingsRepository();
  const webhookInvoiceRepo = pool ? new PgInvoiceRepository(pool) : new InMemoryInvoiceRepository();
  const webhookEstimateRepo = pool ? new PgEstimateRepository(pool) : new InMemoryEstimateRepository();
  const webhookPaymentRepo = pool ? new PgPaymentRepository(pool) : new InMemoryPaymentRepository();
  const jobRepo            = pool ? new PgJobRepository(pool)            : new InMemoryJobRepository();
  const pendingInvitationRepo = pool
    ? new PgPendingInvitationRepository(pool)
    : new InMemoryPendingInvitationRepository();
  const queue = pool ? new PgQueue(pool) : new InMemoryQueue();
  const webhookAuditRepo = pool ? new PgAuditRepository(pool) : new InMemoryAuditRepository();
  const webhookEventRepo = pool ? new PgWebhookEventRepository(pool) : new InMemoryWebhookEventRepository();
  const webhookRepo = pool ? new PgWebhookRepository(pool) : undefined;
  const dncRepo = pool ? new PgDncRepository(pool) : new InMemoryDncRepository();
  const customerRepo       = pool ? new PgCustomerRepository(pool)       : new InMemoryCustomerRepository();
  const leadRepo           = pool ? new PgLeadRepository(pool)           : new InMemoryLeadRepository();
  const locationRepo       = pool ? new PgLocationRepository(pool)       : new InMemoryLocationRepository();
  const timelineRepo       = pool ? new PgJobTimelineRepository(pool)    : new InMemoryJobTimelineRepository();
  const appointmentRepo    = pool ? new PgAppointmentRepository(pool)    : new InMemoryAppointmentRepository();
  const assignmentRepo     = pool ? new PgAssignmentRepository(pool)     : new InMemoryAssignmentRepository();
  const workingHoursRepo       = pool ? new PgWorkingHoursRepository(pool)     : new InMemoryWorkingHoursRepository();
  const estimateRepo       = pool ? new PgEstimateRepository(pool)       : new InMemoryEstimateRepository();
  const invoiceRepo        = pool ? new PgInvoiceRepository(pool)        : new InMemoryInvoiceRepository();
  const invoiceScheduleRepo = pool ? new PgInvoiceScheduleRepository(pool) : new InMemoryInvoiceScheduleRepository();
  const batchInvoiceRunRepo = pool ? new PgBatchInvoiceRunRepository(pool) : new InMemoryBatchInvoiceRunRepository();
  const paymentRepo        = pool ? new PgPaymentRepository(pool)        : new InMemoryPaymentRepository();
  const expenseRepo        = pool ? new PgExpenseRepository(pool)        : new InMemoryExpenseRepository();
  const noteRepo           = pool ? new PgNoteRepository(pool)           : new InMemoryNoteRepository();
  const conversationRepo   = pool ? new PgConversationRepository(pool)   : new InMemoryConversationRepository();
  const settingsRepo       = pool ? new PgSettingsRepository(pool)       : new InMemorySettingsRepository();
  const lookupEventRepo    = pool ? new PgLookupEventRepository(pool)    : new InMemoryLookupEventRepository();
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
  const fileRepo           = pool ? new PgFileRepository(pool)           : new InMemoryFileRepository();
  const jobFileRepo        = pool ? new PgJobFileRepository(pool)        : new InMemoryJobFileRepository();
  const jobPhotoRepo       = pool ? new PgJobPhotoRepository(pool)       : new InMemoryJobPhotoRepository();
  const catalogRepo        = pool ? new PgCatalogItemRepository(pool)    : new InMemoryCatalogItemRepository();
  const feedbackRequestRepo = pool ? new PgFeedbackRequestRepository(pool) : new InMemoryFeedbackRequestRepository();
  const feedbackResponseRepo = pool ? new PgFeedbackResponseRepository(pool) : new InMemoryFeedbackResponseRepository();
  const portalSessionRepo: PortalSessionRepository = pool
    ? new PgPortalSessionRepository(pool)
    : new InMemoryPortalSessionRepository();
  const agreementRunRepo = pool
    ? new PgAgreementRunRepository(pool)
    : new InMemoryAgreementRunRepository();
  const timeEntryRepo      = pool ? new PgTimeEntryRepository(pool)       : new InMemoryTimeEntryRepository();
  const canonicalPackRegistry = pool
    ? new PgVerticalPackRegistry(pool)
    : new InMemoryCanonicalVerticalPackRegistry();
  const aiRunRepo = pool ? new PgAiRunRepository(pool) : new InMemoryAiRunRepository();
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
  const dispatchRepo = pool ? new PgDispatchRepository(pool) : new InMemoryDispatchRepository();
  const documentRevisionRepo = pool
    ? new PgDocumentRevisionRepository(pool)
    : new InMemoryDocumentRevisionRepository();
  const diffAnalysisRepo = pool
    ? new PgDiffAnalysisRepository(pool)
    : new InMemoryDiffAnalysisRepository();
  const dispatchAnalyticsRepo = pool
    ? new PgDispatchAnalyticsRepository(pool)
    : new InMemoryDispatchAnalyticsRepository();
  const googleReviewsReviewRepo = pool ? new PgReviewRepository(pool) : null;
  const googleReviewsPollStateRepo = pool
    ? new PgReviewPollStateRepository(pool)
    : null;
  const serviceCreditRepo = pool ? new PgServiceCreditRepository(pool) : undefined;
  const proposalIdempotencyLock = pool
    ? new PgIdempotencyLockProvider(pool)
    : new NoOpIdempotencyLockProvider();
  const delayNoticeStateRepo = pool
    ? new PgDelayNoticeStateRepository(pool)
    : new InMemoryDelayNoticeStateRepository();
  const calendarIntegrationRepo = pool
    ? new PgCalendarIntegrationRepository(pool)
    : new InMemoryCalendarIntegrationRepository();
  const oauthStateRepo = pool
    ? new PgOAuthStateRepository(pool)
    : new InMemoryOAuthStateRepository();
  const appointmentCalendarEventRepo = pool
    ? new PgAppointmentCalendarEventRepository(pool)
    : new InMemoryAppointmentCalendarEventRepository();
  const sharedOnCallRepo = pool ? new PgOnCallRepository(pool) : new InMemoryOnCallRepository();
  const phoneNumberRepo = pool ? new PgPhoneNumberRepository(pool) : undefined;
  const userRepo = pool ? new PgUserRepository(pool) : new InMemoryUserRepository();
  const revenueBySourceRepo = pool
    ? new PgRevenueBySourceRepository(pool)
    : new InMemoryRevenueBySourceRepository();
  const googleReviewsCustomerLoader = pool ? new PgCustomerLoader(pool) : null;
  const featureFlagRepo: FeatureFlagRepository = pool
    ? new PgFeatureFlagRepository(pool)
    : new InMemoryFeatureFlagRepository();

  return {
    tenantRepo,
    webhookSettingsRepo,
    webhookInvoiceRepo,
    webhookEstimateRepo,
    webhookPaymentRepo,
    jobRepo,
    pendingInvitationRepo,
    queue,
    webhookAuditRepo,
    webhookEventRepo,
    webhookRepo,
    dncRepo,
    customerRepo,
    leadRepo,
    locationRepo,
    timelineRepo,
    appointmentRepo,
    assignmentRepo,
    workingHoursRepo,
    estimateRepo,
    invoiceRepo,
    invoiceScheduleRepo,
    batchInvoiceRunRepo,
    paymentRepo,
    expenseRepo,
    noteRepo,
    conversationRepo,
    settingsRepo,
    lookupEventRepo,
    agreementRepo,
    templateRepo,
    bundleRepo,
    qualityMetricsRepo,
    voiceRepo,
    voiceSessionRepo,
    technicianLocationPingRepo,
    technicianLocationAuthorizer,
    approvalRepo,
    deltaRepo,
    packActivationRepo,
    trainingAssetRepo,
    privacyAuditRepo,
    fileRepo,
    jobFileRepo,
    jobPhotoRepo,
    catalogRepo,
    feedbackRequestRepo,
    feedbackResponseRepo,
    portalSessionRepo,
    agreementRunRepo,
    timeEntryRepo,
    canonicalPackRegistry,
    aiRunRepo,
    knowledgeChunkRepo,
    proposalExecutionRepo,
    retrievalEvalRunRepo,
    callTranscriptTurnRepo,
    dispatchRepo,
    documentRevisionRepo,
    diffAnalysisRepo,
    dispatchAnalyticsRepo,
    googleReviewsReviewRepo,
    googleReviewsPollStateRepo,
    serviceCreditRepo,
    proposalIdempotencyLock,
    delayNoticeStateRepo,
    calendarIntegrationRepo,
    oauthStateRepo,
    appointmentCalendarEventRepo,
    sharedOnCallRepo,
    phoneNumberRepo,
    userRepo,
    revenueBySourceRepo,
    googleReviewsCustomerLoader,
    featureFlagRepo,
  };
}
