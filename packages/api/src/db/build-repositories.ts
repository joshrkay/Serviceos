/**
 * Repository construction for createApp().
 *
 * Stage 1 of the app.ts wiring decomposition — see D-024 (which sequences
 * D-022). This module owns the one decision createApp() should not have to
 * make: whether a repository is Postgres-backed or in-memory. Callers get a
 * fully-built set and never see the `pool ? Pg : InMemory` choice.
 *
 * Behaviour is identical to the inline construction it replaces: same
 * classes, same arguments, same relative order, same NUMBER OF INSTANCES.
 * The instance asymmetry is deliberate and preserved verbatim —
 * `settingsRepo`, `jobRepo` and `pendingInvitationRepo` are single shared
 * instances, while `invoiceRepo`/`estimateRepo`/`paymentRepo` are each built
 * a second time for the pre-auth webhook surface. Those counts are pinned by
 * test/app/repository-instance-sharing.test.ts; changing them is a behaviour
 * change that belongs in its own commit.
 *
 * Ordering: `customerMergeRepo` and `appointmentRepo` take a sibling
 * repository in their in-memory constructor, so they are built after
 * `customerRepo` and `assignmentRepo` respectively.
 *
 * OVERRIDES — createApp() applies test overrides by spreading them over this
 * result, which substitutes the named repository for every consumer that
 * receives it from the returned set. The two in-memory constructors above are
 * the exception, because they capture their sibling at CONSTRUCTION time
 * rather than reading it from the set: a spread applied afterwards could not
 * reach inside them. They therefore take the override through `siblings`
 * below, so `createApp({ customerRepo })` is honoured by `customerMergeRepo`
 * and `createApp({ assignmentRepo })` by `appointmentRepo`.
 *
 * `siblings` is typed against the CONCRETE adapter union rather than
 * `Partial<Repositories>`, because `Repositories` is inferred FROM this
 * function and referencing it in its own parameter list would be circular.
 * It deliberately matches the type each binding already had — typing it
 * against the narrower consumed interface instead widens the inferred
 * `customerRepo`/`assignmentRepo` and breaks ~20 consumers in app.ts.
 */
import type { Pool } from 'pg';

import { InMemoryAgreementRepository } from '../agreements/agreement';
import { InMemoryAgreementRunRepository } from '../agreements/agreement-run';
import { PgAgreementRepository } from '../agreements/pg-agreement';
import { PgAgreementRunRepository } from '../agreements/pg-agreement-run';
import {
  InMemoryTriageEventRepository,
  PgTriageEventRepository,
} from '../ai/agents/customer-calling/pg-triage-events';
import { InMemoryAiRunRepository } from '../ai/ai-run';
import { InMemoryDiffAnalysisRepository } from '../ai/diff-analysis';
import { InMemoryDocumentRevisionRepository } from '../ai/document-revision';
import { PgAiRunRepository } from '../ai/pg-ai-run';
import { PgDiffAnalysisRepository } from '../ai/pg-diff-analysis';
import { PgDocumentRevisionRepository } from '../ai/pg-document-revision';
import {
  InMemorySupervisorReviewRepository,
  PgSupervisorReviewRepository,
} from '../ai/supervisor/reviews-repo';
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
import { InMemoryAttachmentRepository } from '../attachments/attachment';
import { PgAttachmentRepository } from '../attachments/pg-attachment';
import { DevInMemoryTenantRepository } from '../auth/dev-auth-bypass';
import { PgTenantRepository } from '../auth/pg-tenant';
import { PgUnavailableBlockRepository } from '../availability/pg-unavailable-block';
import { PgWorkingHoursRepository } from '../availability/pg-working-hours';
import { InMemoryUnavailableBlockRepository } from '../availability/unavailable-block';
import { InMemoryWorkingHoursRepository } from '../availability/working-hours';
import { InMemoryCatalogItemRepository } from '../catalog/catalog-item';
import { PgCatalogItemRepository } from '../catalog/pg-catalog-item';
import {
  InMemoryConsentEventRepository,
  PgConsentEventRepository,
} from '../compliance/consent-events';
import { InMemoryDncRepository, PgDncRepository } from '../compliance/dnc';
import { InMemoryConversationRepository } from '../conversations/conversation-service';
import { PgConversationRepository } from '../conversations/pg-conversation';
import { InMemoryContactRepository } from '../customers/contact';
import { InMemoryCustomFieldRepository } from '../customers/custom-field';
import { InMemoryCustomerRepository } from '../customers/customer';
import { InMemoryCustomerGroupRepository } from '../customers/customer-group';
import { InMemoryCustomerMergeRepository } from '../customers/merge';
import { PgContactRepository } from '../customers/pg-contact';
import { PgCustomFieldRepository } from '../customers/pg-custom-field';
import { PgCustomerRepository } from '../customers/pg-customer';
import { PgCustomerGroupRepository } from '../customers/pg-customer-group';
import { PgCustomerMergeRepository } from '../customers/pg-merge';
import { PgTagRepository } from '../customers/pg-tag';
import { InMemoryTagRepository } from '../customers/tag';
import {
  InMemoryOnboardingSessionRepository,
  PgOnboardingSessionRepository,
} from '../db/onboarding-session-repository';
import { InMemoryTransactionRunner, PgTenantTransactionRunner } from '../db/tenant-transaction';
import { InMemoryDailyDigestRepository } from '../digest/digest-service';
import { PgDailyDigestRepository } from '../digest/pg-daily-digest';
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
import { InMemoryFinancingRepository } from '../financing/financing';
import { PgFinancingRepository } from '../financing/pg-financing';
import { PgStandingInstructionRepository } from '../instructions/pg-standing-instructions';
import { InMemoryStandingInstructionRepository } from '../instructions/standing-instructions';
import {
  InMemoryAccountingIntegrationRepository,
  InMemoryAccountingOAuthStateRepository,
  InMemoryAccountingSyncLogRepository,
  PgAccountingIntegrationRepository,
  PgAccountingOAuthStateRepository,
  PgAccountingSyncLogRepository,
} from '../integrations/accounting/repository';
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
import { InMemoryBatchInvoiceRunRepository } from '../invoices/batch-invoice-run';
import {
  InMemoryDunningConfigRepository,
  InMemoryDunningEventRepository,
} from '../invoices/dunning-config';
import { InMemoryInvoiceRepository } from '../invoices/invoice';
import { InMemoryInvoiceScheduleRepository } from '../invoices/invoice-schedule';
import { InMemoryPaymentRepository } from '../invoices/payment';
import { PgBatchInvoiceRunRepository } from '../invoices/pg-batch-invoice-run';
import { PgDunningConfigRepository, PgDunningEventRepository } from '../invoices/pg-dunning-config';
import { PgInvoiceRepository } from '../invoices/pg-invoice';
import { PgInvoiceScheduleRepository } from '../invoices/pg-invoice-schedule';
import { PgPaymentRepository } from '../invoices/pg-payment';
import { InMemoryJobFormRepository } from '../job-forms/job-form';
import { PgJobFormRepository } from '../job-forms/pg-job-form';
import { InMemoryJobRepository } from '../jobs/job';
import { InMemoryJobCustomFieldRepository } from '../jobs/job-custom-field';
import { InMemoryJobTimelineRepository } from '../jobs/job-lifecycle';
import { InMemoryJobPhotoRepository } from '../jobs/job-photo';
import { PgJobRepository } from '../jobs/pg-job';
import { PgJobCustomFieldRepository } from '../jobs/pg-job-custom-field';
import { PgJobTimelineRepository } from '../jobs/pg-job-lifecycle';
import { PgJobPhotoRepository } from '../jobs/pg-job-photo';
import { InMemoryLeadRepository } from '../leads/lead';
import { PgLeadRepository } from '../leads/pg-lead';
import { InMemoryCorrectionLessonRepository } from '../learning/corrections/correction-lesson';
import { PgCorrectionLessonRepository } from '../learning/corrections/pg-correction-lesson';
import { InMemoryLocationRepository } from '../locations/location';
import { PgLocationRepository } from '../locations/pg-location';
import { InMemoryLookupEventRepository } from '../lookup-events/lookup-event';
import { PgLookupEventRepository } from '../lookup-events/pg-lookup-event';
import { InMemoryCampaignRepository } from '../marketing/campaign';
import { PgCampaignRepository } from '../marketing/pg-campaign';
import { InMemoryMaterialItemRepository } from '../materials/material-item';
import { PgMaterialItemRepository } from '../materials/pg-material-item';
import { InMemoryMessageTemplateRepository } from '../messaging/message-template';
import { PgMessageTemplateRepository } from '../messaging/pg-message-template';
import {
  InMemoryHfcrWeeklySendRepository,
  PgHfcrWeeklySendRepository,
} from '../metrics/hfcr-weekly-send';
import { InMemoryNoteRepository } from '../notes/note';
import { PgNoteRepository } from '../notes/pg-note';
import { InMemoryDelayNoticeStateRepository } from '../notifications/delay-notifications';
import {
  InMemoryDispatchRepository,
  PgDispatchRepository,
} from '../notifications/dispatch-repository';
import {
  InMemoryNotificationPreferenceRepository,
} from '../notifications/notification-preferences-service';
import { PgDelayNoticeStateRepository } from '../notifications/pg-delay-notice-state';
import {
  PgNotificationPreferenceRepository,
} from '../notifications/pg-notification-preferences-repository';
import { InMemoryOnCallRepository, PgOnCallRepository } from '../oncall/rotation';
import { InMemoryCustomerPaymentMethodRepository } from '../payments/customer-payment-method';
import { PgCustomerPaymentMethodRepository } from '../payments/pg-customer-payment-method';
import { InMemoryCorrectionRepository } from '../proposals/corrections/correction';
import { PgCorrectionRepository } from '../proposals/corrections/pg-correction';
import {
  NoOpIdempotencyLockProvider,
  PgIdempotencyLockProvider,
} from '../proposals/execution/idempotency-lock';
import { PgProposalExecutionRepository } from '../proposals/pg-proposal-execution';
import { InMemoryProposalExecutionRepository } from '../proposals/proposal-execution';
import { InMemoryProposalSmsEventRepository, PgProposalSmsEventRepository } from '../proposals/sms';
import { InMemoryDeviceTokenRepository } from '../push/device-token-service';
import { PgDeviceTokenRepository } from '../push/pg-device-token-repository';
import { InMemoryQualityMetricsRepository } from '../quality/metrics';
import { PgQualityMetricsRepository } from '../quality/pg-metrics';
import { PgQueue } from '../queues/pg-queue';
import { InMemoryQueue } from '../queues/queue';
import { PgRecurringJobRepository } from '../recurring-jobs/pg-recurring-job';
import { InMemoryRecurringJobRepository } from '../recurring-jobs/recurring-job';
import {
  InMemoryRevenueBySourceRepository,
  PgRevenueBySourceRepository,
} from '../reports/revenue-by-source';
import {
  InMemoryGoogleBusinessIntegrationRepository,
  PgGoogleBusinessIntegrationRepository,
} from '../reputation/google-business-integration';
import { InMemoryPackActivationRepository } from '../settings/pack-activation';
import { PgPackActivationRepository } from '../settings/pg-pack-activation';
import { PgSettingsRepository } from '../settings/pg-settings';
import { InMemorySettingsRepository } from '../settings/settings';
import { PgVerticalPackRegistry } from '../shared/pg-vertical-pack-registry';
import {
  InMemoryVerticalPackRegistry as InMemoryCanonicalVerticalPackRegistry,
} from '../shared/vertical-pack-registry';
import {
  InMemoryDroppedCallRecoveryRepository,
  PgDroppedCallRecoveryRepository,
} from '../sms/recovery/scheduler';
import { InMemoryTechStatusTodayRepository, PgTechStatusTodayRepository } from '../sms/tech-status';
import { PgTechnicianLocationPingRepository } from '../telemetry/pg-technician-location-ping';
import {
  InMemoryTechnicianLocationAuthorizer,
  PgTechnicianLocationAuthorizer,
} from '../telemetry/technician-location-authz';
import { InMemoryTechnicianLocationPingRepository } from '../telemetry/technician-location-ping';
import { InMemoryEstimateTemplateRepository } from '../templates/estimate-template';
import { PgEstimateTemplateRepository } from '../templates/pg-estimate-template';
import { InMemoryBrandVoiceRepository } from '../tenants/brand/in-memory-brand-voice-repository';
import { PgBrandVoiceRepository } from '../tenants/brand/pg-brand-voice-repository';
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
import { InMemoryCallMeBackRepository } from '../voice/call-me-back/call-me-back';
import { PgCallMeBackRepository } from '../voice/call-me-back/pg-call-me-back';
import { InMemoryCallTranscriptTurnRepository } from '../voice/call-transcript-turn';
import { PgCallTranscriptTurnRepository } from '../voice/pg-call-transcript-turn';
import { PgVoiceRepository } from '../voice/pg-voice';
import { PgVoiceSessionRepository } from '../voice/pg-voice-session';
import { InMemoryVoiceRepository } from '../voice/voice-service';
import { InMemoryVoiceSessionRepository } from '../voice/voice-session';
import { InMemoryWebhookEventRepository } from '../webhooks/in-memory-webhook-event';
import { PgWebhookEventRepository } from '../webhooks/pg-webhook-event';

/**
 * Builds every repository createApp() needs.
 *
 * @param pool       main pool; `undefined` selects the in-memory adapters
 * @param directPool session-mode pool (advisory locks); falls back to `pool`
 * @param siblings   overrides for the two repositories that are consumed by
 *                   another repository's constructor (see OVERRIDES above)
 */
export function buildRepositories(
  pool: Pool | undefined,
  directPool: Pool | undefined,
  siblings: {
    customerRepo?: PgCustomerRepository | InMemoryCustomerRepository;
    assignmentRepo?: PgAssignmentRepository | InMemoryAssignmentRepository;
  } = {},
) {

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
  const tenantRepo = pool ? new PgTenantRepository(pool) : new DevInMemoryTenantRepository();
  const settingsRepo = pool ? new PgSettingsRepository(pool) : new InMemorySettingsRepository();

  // Constructed early so the Stripe webhook handler can record payments.
  const webhookInvoiceRepo = pool ? new PgInvoiceRepository(pool) : new InMemoryInvoiceRepository();
  const webhookEstimateRepo = pool
    ? new PgEstimateRepository(pool)
    : new InMemoryEstimateRepository();
  const webhookPaymentRepo = pool ? new PgPaymentRepository(pool) : new InMemoryPaymentRepository();

  // Tier 4 (Deposit rules — PR 3b). Hoisted up so the Stripe webhook
  // and the rest of the app share a single instance — InMemory repos
  // are stateful, so two separate `new InMemoryJobRepository()` calls
  // would diverge in tests.
  const jobRepo = pool ? new PgJobRepository(pool) : new InMemoryJobRepository();

  // Tier 4 (Team members — PR 3). Same hoist for pending invitations
  // — the Clerk webhook reads them on user.created and the /api/users
  // routes write them. Single shared InMemory in tests.
  const pendingInvitationRepo = pool
    ? new PgPendingInvitationRepository(pool)
    : new InMemoryPendingInvitationRepository();

  // Queue constructed here (before webhook router) so new-tenant webhooks can
  // enqueue provisioning jobs synchronously during the request.
  const queue = pool ? new PgQueue(pool) : new InMemoryQueue();
  const webhookEventRepo = pool
    ? new PgWebhookEventRepository(pool)
    : new InMemoryWebhookEventRepository();
  const dncRepo = pool ? new PgDncRepository(pool) : new InMemoryDncRepository();
  const customerRepo =
    siblings.customerRepo ??
    (pool ? new PgCustomerRepository(pool) : new InMemoryCustomerRepository());

  // U1 (CRM Jobber parity) — multiple contacts per customer.
  const customerContactRepo = pool
    ? new PgContactRepository(pool)
    : new InMemoryContactRepository();

  // U2 (CRM Jobber parity) — customer tags + tenant-defined custom fields.
  const customerTagRepo = pool ? new PgTagRepository(pool) : new InMemoryTagRepository();
  const customerCustomFieldRepo = pool
    ? new PgCustomFieldRepository(pool)
    : new InMemoryCustomFieldRepository();
  const jobFormRepo = pool ? new PgJobFormRepository(pool) : new InMemoryJobFormRepository();
  const recurringJobRepo = pool
    ? new PgRecurringJobRepository(pool)
    : new InMemoryRecurringJobRepository();
  const jobCustomFieldRepo = pool
    ? new PgJobCustomFieldRepository(pool)
    : new InMemoryJobCustomFieldRepository();
  const financingRepo = pool ? new PgFinancingRepository(pool) : new InMemoryFinancingRepository();
  const campaignRepo = pool ? new PgCampaignRepository(pool) : new InMemoryCampaignRepository();
  const customerGroupRepo = pool
    ? new PgCustomerGroupRepository(pool)
    : new InMemoryCustomerGroupRepository();

  // UB-A1 — standing instructions the AI agents apply when drafting.
  const standingInstructionRepo = pool
    ? new PgStandingInstructionRepository(pool)
    : new InMemoryStandingInstructionRepository();

  // Story 4.6 — customer merge. Pg re-parents child rows + archives the loser
  // in one transaction; the no-DB dev path only archives (no child tables).
  const customerMergeRepo = pool
    ? new PgCustomerMergeRepository(pool)
    : new InMemoryCustomerMergeRepository(customerRepo);
  const leadRepo = pool ? new PgLeadRepository(pool) : new InMemoryLeadRepository();
  const locationRepo = pool ? new PgLocationRepository(pool) : new InMemoryLocationRepository();
  const timelineRepo = pool
    ? new PgJobTimelineRepository(pool)
    : new InMemoryJobTimelineRepository();

  // assignmentRepo is constructed BEFORE appointmentRepo (rather than the
  // historical order) so the in-memory appointment repo can be threaded the
  // same assignment lookup it needs for technicianId filtering in
  // listWithMeta — see in-memory-appointment.ts's TechnicianAssignmentLookup.
  // Pg's equivalent filter is a self-contained EXISTS subquery, so
  // PgAppointmentRepository needs no such wiring.
  const assignmentRepo =
    siblings.assignmentRepo ??
    (pool ? new PgAssignmentRepository(pool) : new InMemoryAssignmentRepository());
  const appointmentRepo = pool
    ? new PgAppointmentRepository(pool)
    : new InMemoryAppointmentRepository(assignmentRepo);

  // Declared here (ahead of its first router use) so the jobs router's
  // from-estimate scheduling deps can reference it.
  const userRepo = pool ? new PgUserRepository(pool) : new InMemoryUserRepository();

  // Working hours are now Pg-backed in production (migration 137 added
  // technician_working_hours), so the dispatch feasibility composer and the
  // inbound-AI availability search enforce real working-hours rows instead of
  // treating missing rows as no-conflict. The unavailable-block repo is now
  // Pg-backed too (migration 116 `tech_unavailable_blocks`) so the P6-028
  // tech "I'm out" handler persists real same-day blocks the feasibility
  // composer reads. InMemory variants stay for tests / no-pool.
  const workingHoursRepo = pool
    ? new PgWorkingHoursRepository(pool)
    : new InMemoryWorkingHoursRepository();
  const unavailableBlockRepo = pool
    ? new PgUnavailableBlockRepository(pool)
    : new InMemoryUnavailableBlockRepository();
  const estimateRepo = pool ? new PgEstimateRepository(pool) : new InMemoryEstimateRepository();
  const invoiceRepo = pool ? new PgInvoiceRepository(pool) : new InMemoryInvoiceRepository();
  const dunningConfigRepo = pool
    ? new PgDunningConfigRepository(pool)
    : new InMemoryDunningConfigRepository();
  const dunningEventRepo = pool
    ? new PgDunningEventRepository(pool)
    : new InMemoryDunningEventRepository();
  const hfcrWeeklySendRepo = pool
    ? new PgHfcrWeeklySendRepository(pool)
    : new InMemoryHfcrWeeklySendRepository();
  const invoiceScheduleRepo = pool
    ? new PgInvoiceScheduleRepository(pool)
    : new InMemoryInvoiceScheduleRepository();
  const batchInvoiceRunRepo = pool
    ? new PgBatchInvoiceRunRepository(pool)
    : new InMemoryBatchInvoiceRunRepository();
  const batchInvoiceTxRunner = pool
    ? new PgTenantTransactionRunner(pool)
    : new InMemoryTransactionRunner();
  const paymentRepo = pool ? new PgPaymentRepository(pool) : new InMemoryPaymentRepository();
  const expenseRepo = pool ? new PgExpenseRepository(pool) : new InMemoryExpenseRepository();

  // Task 9 (2026-08-07 tradesperson plan) — material_items (Task 8's
  // substrate) backs the add_material / lookup_materials voice intents.
  const materialItemRepo = pool
    ? new PgMaterialItemRepository(pool)
    : new InMemoryMaterialItemRepository();
  const noteRepo = pool ? new PgNoteRepository(pool) : new InMemoryNoteRepository();
  const conversationRepo = pool
    ? new PgConversationRepository(pool)
    : new InMemoryConversationRepository();

  // Voice-parity (Feature 7) — call_me_back tasks (failed-transfer callbacks).
  const callMeBackRepo = pool
    ? new PgCallMeBackRepository(pool)
    : new InMemoryCallMeBackRepository();

  // Mobile push-token store (POST/DELETE /api/devices, the proposal/owner
  // push notifiers bound further down, and account deletion's token purge) +
  // the Expo push transport. Constructed HERE — not at the router mount — so
  // the voice adapters can take both as deps for the ANS-001 E1 alert
  // fan-out. Pg-backed when a DB is configured (PgBaseRepository.withTenant,
  // so every statement joins the per-request tenant transaction and RLS
  // scopes every row); in-memory otherwise.
  const deviceTokenRepo = pool
    ? new PgDeviceTokenRepository(pool)
    : new InMemoryDeviceTokenRepository();

  // P11-001: voice lookup-skill audit log. The skills write one row
  // per invocation through `LookupEventService` and the Twilio adapter
  // pulls it from the deps bundle. InMemory in dev/test, Pg in prod.
  const lookupEventRepo = pool
    ? new PgLookupEventRepository(pool)
    : new InMemoryLookupEventRepository();

  // P11-001: hoisted so the Twilio lookup-skill family can read agreements.
  // The richer agreement-service wiring (agreementRunRepo, generators,
  // etc.) still happens further below — this declaration is purely so
  // the read-only lookup branch has access.
  const agreementRepo = pool ? new PgAgreementRepository(pool) : new InMemoryAgreementRepository();

  // #6 phase 4 — saved cards for off-session dues billing.
  const customerPaymentMethodRepo = pool
    ? new PgCustomerPaymentMethodRepository(pool)
    : new InMemoryCustomerPaymentMethodRepository();
  const templateRepo = pool
    ? new PgEstimateTemplateRepository(pool)
    : new InMemoryEstimateTemplateRepository();
  const messageTemplateRepo = pool
    ? new PgMessageTemplateRepository(pool)
    : new InMemoryMessageTemplateRepository();
  const bundleRepo = pool
    ? new PgServiceBundleRepository(pool)
    : new InMemoryServiceBundleRepository();
  const qualityMetricsRepo = pool
    ? new PgQualityMetricsRepository(pool)
    : new InMemoryQualityMetricsRepository();
  const voiceRepo = pool ? new PgVoiceRepository(pool) : new InMemoryVoiceRepository();
  const voiceSessionRepo = pool
    ? new PgVoiceSessionRepository(pool)
    : new InMemoryVoiceSessionRepository();
  const technicianLocationPingRepo = pool
    ? new PgTechnicianLocationPingRepository(pool)
    : new InMemoryTechnicianLocationPingRepository();
  const technicianLocationAuthorizer = pool
    ? new PgTechnicianLocationAuthorizer(pool)
    : new InMemoryTechnicianLocationAuthorizer();
  const approvalRepo = pool ? new PgApprovalRepository(pool) : new InMemoryApprovalRepository();
  const deltaRepo = pool ? new PgEditDeltaRepository(pool) : new InMemoryEditDeltaRepository();
  const packActivationRepo = pool
    ? new PgPackActivationRepository(pool)
    : new InMemoryPackActivationRepository();
  const trainingAssetRepo = pool
    ? new PgTrainingAssetRepository(pool)
    : new InMemoryTrainingAssetRepository();
  const privacyAuditRepo = pool
    ? new PgPrivacyAuditRepository(pool)
    : new InMemoryPrivacyAuditRepository();
  const fileRepo = pool ? new PgFileRepository(pool) : new InMemoryFileRepository();
  const jobFileRepo = pool ? new PgJobFileRepository(pool) : new InMemoryJobFileRepository();
  const jobPhotoRepo = pool ? new PgJobPhotoRepository(pool) : new InMemoryJobPhotoRepository();

  // RV-005: generalized attachments (photos & documents on any entity).
  const attachmentRepo = pool
    ? new PgAttachmentRepository(pool)
    : new InMemoryAttachmentRepository();
  const catalogRepo = pool
    ? new PgCatalogItemRepository(pool)
    : new InMemoryCatalogItemRepository();
  const feedbackRequestRepo = pool
    ? new PgFeedbackRequestRepository(pool)
    : new InMemoryFeedbackRequestRepository();
  const feedbackResponseRepo = pool
    ? new PgFeedbackResponseRepository(pool)
    : new InMemoryFeedbackResponseRepository();

  // Agreement-runs are also surfaced on the public portal (read-only).
  // Hoisted here so the public portal router (mounted before Clerk auth)
  // can reference it. `agreementRepo` is already declared above (hoisted
  // for the P11-001 voice lookup-skill family).
  const agreementRunRepo = pool
    ? new PgAgreementRunRepository(pool)
    : new InMemoryAgreementRunRepository();
  const timeEntryRepo = pool ? new PgTimeEntryRepository(pool) : new InMemoryTimeEntryRepository();
  const canonicalPackRegistry = pool
    ? new PgVerticalPackRegistry(pool)
    : new InMemoryCanonicalVerticalPackRegistry();

  // AI-run repository — tracks every LLM call lifecycle (pending → running → completed/failed).
  // Pg-backed in production; InMemory when DATABASE_URL is unset (dev/test).
  const aiRunRepo = pool ? new PgAiRunRepository(pool) : new InMemoryAiRunRepository();

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
  const retrievalEvalRunRepo = pool
    ? new PgRetrievalEvalRunRepository(pool)
    : new InMemoryRetrievalEvalRunRepository();
  const callTranscriptTurnRepo = pool
    ? new PgCallTranscriptTurnRepository(pool)
    : new InMemoryCallTranscriptTurnRepository();
  const dispatchRepo = pool ? new PgDispatchRepository(pool) : new InMemoryDispatchRepository();

  // RV-130 — consent ledger (append-only consent_events). Constructed here —
  // before the SMS gate — because WS12 makes it the cross-channel source of
  // truth both outbound gates consult; the STOP/START keyword handlers and
  // the voice adapter (registered further down) append to the same instance.
  const consentEventRepo = pool
    ? new PgConsentEventRepository(pool)
    : new InMemoryConsentEventRepository();

  // store and the analysis store onto Postgres when DATABASE_URL is set —
  // dev still uses the in-memory variants so tests boot without a DB.
  const documentRevisionRepo = pool
    ? new PgDocumentRevisionRepository(pool)
    : new InMemoryDocumentRevisionRepository();
  const diffAnalysisRepo = pool
    ? new PgDiffAnalysisRepository(pool)
    : new InMemoryDiffAnalysisRepository();
  const techStatusTodayRepo = pool
    ? new PgTechStatusTodayRepository(pool)
    : new InMemoryTechStatusTodayRepository();
  const proposalSmsEventRepo = pool
    ? new PgProposalSmsEventRepository(pool)
    : new InMemoryProposalSmsEventRepository();
  const dispatchAnalyticsRepo = pool
    ? new PgDispatchAnalyticsRepository(pool)
    : new InMemoryDispatchAnalyticsRepository();

  // Review-monitoring self-serve — Google Business connect + refresh.
  // The repo writes/rotates the `tenant_integrations` credential row the
  // poll worker + reply resolver read; the OAuth config reuses the same
  const googleBusinessIntegrationRepo = pool
    ? new PgGoogleBusinessIntegrationRepository(pool)
    : new InMemoryGoogleBusinessIntegrationRepository();

  // B1.18 — hoisted ahead of the execution registry (was declared next to the
  // brand-voice router further down) so update_brand_voice's execution
  // handler can be wired with the SAME repo instance the sheet's router uses.
  const brandVoiceRepo = pool
    ? new PgBrandVoiceRepository(pool)
    : new InMemoryBrandVoiceRepository();

  // §11 H1: IdempotencyGuard + advisory lock per (tenant, key). Keys
  // default to `proposal-run:{tenant}:{id}` when callers omit one.
  const proposalIdempotencyLock = pool
    ? new PgIdempotencyLockProvider(directPool ?? pool)
    : new NoOpIdempotencyLockProvider();
  const delayNoticeStateRepo = pool
    ? new PgDelayNoticeStateRepository(pool)
    : new InMemoryDelayNoticeStateRepository();

  // RV-062 — shared by the digest worker (writes) and the /api/digests
  // web-view router (reads). Created once here so both wire to the same
  // instance (Pg-backed in prod, in-memory in dev where the sweep no-ops).
  const dailyDigestRepo = pool
    ? new PgDailyDigestRepository(pool)
    : new InMemoryDailyDigestRepository();
  const calendarIntegrationRepo = pool
    ? new PgCalendarIntegrationRepository(pool)
    : new InMemoryCalendarIntegrationRepository();
  const oauthStateRepo = pool
    ? new PgOAuthStateRepository(pool)
    : new InMemoryOAuthStateRepository();
  const appointmentCalendarEventRepo = pool
    ? new PgAppointmentCalendarEventRepository(pool)
    : new InMemoryAppointmentCalendarEventRepository();
  const accountingIntegrationRepo = pool
    ? new PgAccountingIntegrationRepository(pool)
    : new InMemoryAccountingIntegrationRepository();
  const accountingSyncLogRepo = pool
    ? new PgAccountingSyncLogRepository(pool)
    : new InMemoryAccountingSyncLogRepository();
  const accountingOAuthStateRepo = pool
    ? new PgAccountingOAuthStateRepository(pool)
    : new InMemoryAccountingOAuthStateRepository();

  // OnCall repo is created here so both the telephony adapter (notify_oncall
  // side effect) and the in-app adapter (escalation) share a single
  // implementation. The in-app block below reuses this same instance.
  const sharedOnCallRepo = pool ? new PgOnCallRepository(pool) : new InMemoryOnCallRepository();

  // RV-115/RV-116 — durable dropped-call recovery: the scheduler persists
  // the FSM context snapshot at termination; the resume handler picks the
  // thread back up when the caller replies to the recovery SMS.
  const droppedCallRecoveryRepo = pool
    ? new PgDroppedCallRecoveryRepository(pool)
    : new InMemoryDroppedCallRecoveryRepository();
  const triageEventsRepo = pool
    ? new PgTriageEventRepository(pool)
    : new InMemoryTriageEventRepository();

  // Tenant-scoped reporting (revenue by lead source / UTM, money dashboard, tax export).
  const revenueBySourceRepo = pool
    ? new PgRevenueBySourceRepository(pool)
    : new InMemoryRevenueBySourceRepository();

  // U10 — per-user notification preferences (opt-out by category).
  const notificationPreferenceRepo = pool
    ? new PgNotificationPreferenceRepository(pool)
    : new InMemoryNotificationPreferenceRepository();
  const onboardingSessionRepo = pool
    ? new PgOnboardingSessionRepository(pool)
    : new InMemoryOnboardingSessionRepository();

  return {
    tenantRepo,
    settingsRepo,
    webhookInvoiceRepo,
    webhookEstimateRepo,
    webhookPaymentRepo,
    jobRepo,
    pendingInvitationRepo,
    queue,
    webhookEventRepo,
    dncRepo,
    customerRepo,
    customerContactRepo,
    customerTagRepo,
    customerCustomFieldRepo,
    jobFormRepo,
    recurringJobRepo,
    jobCustomFieldRepo,
    financingRepo,
    campaignRepo,
    customerGroupRepo,
    standingInstructionRepo,
    customerMergeRepo,
    leadRepo,
    locationRepo,
    timelineRepo,
    assignmentRepo,
    appointmentRepo,
    userRepo,
    workingHoursRepo,
    unavailableBlockRepo,
    estimateRepo,
    invoiceRepo,
    dunningConfigRepo,
    dunningEventRepo,
    hfcrWeeklySendRepo,
    invoiceScheduleRepo,
    batchInvoiceRunRepo,
    batchInvoiceTxRunner,
    paymentRepo,
    expenseRepo,
    materialItemRepo,
    noteRepo,
    conversationRepo,
    callMeBackRepo,
    deviceTokenRepo,
    lookupEventRepo,
    agreementRepo,
    customerPaymentMethodRepo,
    templateRepo,
    messageTemplateRepo,
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
    attachmentRepo,
    catalogRepo,
    feedbackRequestRepo,
    feedbackResponseRepo,
    agreementRunRepo,
    timeEntryRepo,
    canonicalPackRegistry,
    aiRunRepo,
    knowledgeChunkRepo,
    proposalExecutionRepo,
    correctionLessonRepo,
    supervisorReviewsRepo,
    correctionRepo,
    retrievalEvalRunRepo,
    callTranscriptTurnRepo,
    dispatchRepo,
    consentEventRepo,
    documentRevisionRepo,
    diffAnalysisRepo,
    techStatusTodayRepo,
    proposalSmsEventRepo,
    dispatchAnalyticsRepo,
    googleBusinessIntegrationRepo,
    brandVoiceRepo,
    proposalIdempotencyLock,
    delayNoticeStateRepo,
    dailyDigestRepo,
    calendarIntegrationRepo,
    oauthStateRepo,
    appointmentCalendarEventRepo,
    accountingIntegrationRepo,
    accountingSyncLogRepo,
    accountingOAuthStateRepo,
    sharedOnCallRepo,
    droppedCallRecoveryRepo,
    triageEventsRepo,
    revenueBySourceRepo,
    notificationPreferenceRepo,
    onboardingSessionRepo,
  };
}

/** The fully-built repository set handed to createApp(). */
export type Repositories = ReturnType<typeof buildRepositories>;
