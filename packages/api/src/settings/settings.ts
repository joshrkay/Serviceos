import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

import { isValidTimezone } from '../shared/timezone';

/** Supported tenant/customer languages. Structurally identical to the
 *  voice-stack `Language` in ai/i18n/i18n.ts; defined here to avoid a
 *  settings→ai module dependency. */
export type Language = 'en' | 'es';

/**
 * F8 — per-tenant escalation channel + trigger flags.
 *
 * Stored as a JSON column on tenant_settings (migration deferred to the
 * full F8 data-plane PR). Until then, the field is purely in-memory and
 * resolved at runtime via `resolveEscalationSettings`.
 */
export interface EscalationSettings {
  channel_sms: boolean;
  channel_in_app: boolean;
  channel_whisper: boolean;
  trigger_low_confidence: boolean;
  trigger_explicit_request: boolean;
  trigger_keyword_frustration: boolean;
  /** Opt-in: async LLM sentiment classifier. Default false (cost-aware). */
  trigger_llm_sentiment: boolean;
  /** Frustration score (0..1) above which `frustration_detected` is dispatched. */
  llm_sentiment_threshold: number;
  /** B6 — inbound behavior when outside business hours. */
  after_hours_voice_mode?: 'voicemail' | 'ai_answering';
}

export const DEFAULT_ESCALATION_SETTINGS: EscalationSettings = {
  channel_sms: true,
  channel_in_app: true,
  channel_whisper: true,
  trigger_low_confidence: true,
  trigger_explicit_request: true,
  trigger_keyword_frustration: true,
  trigger_llm_sentiment: false,
  llm_sentiment_threshold: 0.7,
  after_hours_voice_mode: 'voicemail',
};

/**
 * Resolve escalation settings for a tenant, falling back to defaults for
 * any missing field. Safe to call with `null` (tenant has no settings row).
 */
export function resolveEscalationSettings(
  settings: TenantSettings | null,
): EscalationSettings {
  return { ...DEFAULT_ESCALATION_SETTINGS, ...(settings?.escalationSettings ?? {}) };
}

/**
 * Phase 12 — supervisor-mode-related settings on tenant_settings.
 *
 * Schema lives in migration 063 (P12-001). The repository round-trips
 * these alongside the rest of TenantSettings; the routes layer
 * exposes them via the existing PUT /api/settings handler with
 * enum validation on `unsupervisedProposalRouting`.
 */
export type UnsupervisedProposalRouting =
  | 'queue_and_sms'
  | 'queue_only'
  | 'escalate_to_oncall';

export const UNSUPERVISED_PROPOSAL_ROUTING_VALUES: ReadonlyArray<UnsupervisedProposalRouting> = [
  'queue_and_sms',
  'queue_only',
  'escalate_to_oncall',
];

/**
 * P4-015 — per-tenant brand voice. Stored in the `tenant_settings.brand_voice`
 * JSONB column (migration 110) and consumed by `composeBrandVoiceMessage` to
 * keep customer-facing copy on-brand across SMS, voice, and review channels.
 * All fields optional; a missing value falls back to a neutral default tone.
 */
export interface BrandVoiceSettings {
  formality?: 'casual' | 'professional';
  pronoun?: 'we' | 'i';
  vibe_words?: string[];
  business_name?: string;
}

export interface TenantSettings {
  id: string;
  tenantId: string;
  businessName: string;
  // Codex P2 (PR #316): allow null on optional string fields so the
  // update path can carry "clear this column" through the type system.
  // Reads from PgSettings always normalize NULL → undefined via mapRow,
  // so callers consuming TenantSettings rows in normal flows will see
  // undefined; null only appears transiently in update inputs.
  businessPhone?: string | null;
  businessEmail?: string | null;
  timezone: string;
  estimatePrefix: string;
  invoicePrefix: string;
  nextEstimateNumber: number;
  nextInvoiceNumber: number;
  defaultPaymentTermDays: number;
  terminologyPreferences?: Record<string, string>;
  activeVerticalPacks?: string[];
  /**
   * Phase 12 — userId of the backup supervisor invoked when the
   * primary supervisor switches to tech mode. Null = no backup
   * (unsupervised routing applies). Validated by the route as a
   * non-empty string; FK enforcement happens at the DB.
   */
  backupSupervisorUserId?: string | null;
  /**
   * Phase 12 — what to do with low-confidence proposals while the
   * tenant is unsupervised. See `auto-approve.ts` and the routing
   * worker (follow-up). Default `'queue_and_sms'`.
   */
  unsupervisedProposalRouting?: UnsupervisedProposalRouting;
  /**
   * Tier 4 (Settings stubs) — when true, low-risk internal updates
   * the AI proposes are applied automatically. When false, every
   * change requires a human tap. Default false (stricter).
   */
  autoApplyInternalUpdates?: boolean;
  /**
   * Tier 4 (Settings stubs) — when true, the system text-messages
   * customers ~2h before scheduled appointments. Default true.
   */
  autoSendAppointmentReminders?: boolean;
  /**
   * P20-001 — when true, completing a job auto-drafts an invoice (as a
   * proposal the owner approves to send). Default false (opt-in).
   */
  autoInvoiceOnCompletion?: boolean;
  /**
   * P21-003 — when true, a daily sweep proposes a batch invoice for all
   * completed-but-uninvoiced jobs. Default false (opt-in).
   */
  batchInvoiceEnabled?: boolean;
  /**
   * P21 — when true, completing a job mints its invoice-schedule's
   * `on_completion` milestones (e.g. the balance) directly as invoices.
   * Default false (opt-in). Acts as the fleet-wide kill switch for
   * milestone billing — the per-job plan is already owner-approved via the
   * create_invoice_schedule proposal, but this lets an owner halt all
   * milestone minting at once.
   */
  milestoneBillingEnabled?: boolean;
  /**
   * Tier 4 (AI approval rules) — per-mode override of the proposal
   * auto-approve threshold. Consumed by
   * `proposals/auto-approve.ts:resolveAutoApproveThreshold` via the
   * `tenantOverride` field. A missing key (or `undefined` value)
   * falls through to `DEFAULT_AUTO_APPROVE_THRESHOLDS`. Each value is
   * a confidence threshold in `[0, 1]`.
   *
   * Wiring this map into the actual proposal-creation hot path is
   * tracked separately (PR B) — this PR persists the value
   * end-to-end (Settings UI ↔ DB) without yet feeding it to
   * `createProposal`. Behavior unchanged until the wire-up lands.
   */
  autoApproveThreshold?: Partial<Record<'supervisor' | 'tech' | 'both', number>>;
  /**
   * Tier 4 (Deposit rules — PR 1: data plane only). Strategy + amount
   * for requiring a deposit before work begins. Consumed by the
   * estimate-flow integration that lands in PR 2; this PR persists
   * the settings end-to-end without changing behavior.
   *
   * Field correlation rules (mirrored by the migration's CHECK):
   *   - When `depositStrategy` is null/undefined, no deposit applies.
   *   - When `depositStrategy === 'percentage'`, `depositPercentageBps`
   *     must be set (0–10000 = 0%–100%).
   *   - When `depositStrategy === 'fixed'`, `depositFixedCents` must
   *     be set (non-negative integer).
   *   - `depositRequiredAboveCents` is an optional threshold: when
   *     null, the rule applies to every estimate; otherwise only
   *     estimates whose total `>=` this amount require a deposit.
   */
  depositStrategy?: 'percentage' | 'fixed' | null;
  depositPercentageBps?: number | null;
  depositFixedCents?: number | null;
  depositRequiredAboveCents?: number | null;
  /**
   * Tier 4 (Deposit rules — PR 3a-extended). Controls when the
   * customer is prompted to pay the deposit relative to estimate
   * approval. See migration 079 for accepted values. Default
   * 'after_approval' (preserves existing flow).
   */
  depositTimingPolicy?: 'before_approval' | 'after_approval';
  /**
   * §9 — the owner's effective hourly rate, integer cents. Used by the
   * Time-Given-Back surface to convert saved hours into a dollar
   * figure. Null/undefined = not yet set (captured during §10
   * onboarding); until then the headline shows hours only.
   */
  hourlyRateCents?: number | null;
  /**
   * B1 — Per-tenant voice persona. When set, the calling agent uses
   * this name in its greeting ("Hi, I'm {voiceAgentName}. How can I
   * help?"). Null = use the default generic opener.
   */
  voiceAgentName?: string | null;
  /**
   * B1 — Per-tenant voice persona. When set, this text replaces the
   * entire static portion of the greeting (the "Thank you for calling
   * …" or "Hi, this is your assistant" segment). For the telephony
   * channel the recording-disclosure sentence is still appended after
   * the custom greeting text. Null = use default.
   */
  voiceGreeting?: string | null;
  /**
   * F8 — per-tenant escalation channel + trigger flags. When absent,
   * `resolveEscalationSettings` returns `DEFAULT_ESCALATION_SETTINGS`.
   */
  escalationSettings?: EscalationSettings;
  /**
   * P4-015 — per-tenant brand voice tone. Migration 110. When absent, the
   * brand-voice composer uses a neutral default. Explicit `null` clears it.
   */
  brandVoice?: BrandVoiceSettings | null;
  /**
   * Public review links shown to satisfied customers (4★+) on the
   * post-job feedback page. Migration 120. null/undefined = not
   * configured (no button rendered).
   */
  googleReviewUrl?: string | null;
  yelpReviewUrl?: string | null;
  /**
   * P11-002 — tenant language stack (columns on tenant_settings:
   * default_language, auto_detect_language, tts_voice_en/es,
   * spanish_dispatcher_user_ids). Resolves EN/ES for the voice agent
   * and customer-facing comms. Seeded on create and defaulted by the
   * repo on read ('en' / true), so consumers can rely on `?? 'en'` for
   * legacy rows. Optional on the type to avoid forcing every
   * TenantSettings literal to set them.
   */
  defaultLanguage?: Language;
  autoDetectLanguage?: boolean;
  ttsVoiceEn?: string | null;
  ttsVoiceEs?: string | null;
  spanishDispatcherUserIds?: string[];
  /**
   * Per-tenant AI model override. Seeded on tenant creation from
   * `AI_DEFAULT_MODEL` so the onboarding "AI check" step finds an
   * `aiConfigPresent` row immediately and the verify_ai worker has a
   * model to call. The gateway already resolves overrides via its own
   * env+config path; this column just unblocks onboarding and acts as a
   * future per-tenant pinning surface. Column added in migration 120
   * (`120_tenant_settings_ai_config`).
   */
  aiModel?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSettingsInput {
  tenantId: string;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  timezone?: string;
  estimatePrefix?: string;
  invoicePrefix?: string;
  defaultPaymentTermDays?: number;
  terminologyPreferences?: Record<string, string>;
  activeVerticalPacks?: string[];
  /** Per-tenant AI model override. See `TenantSettings.aiModel`. */
  aiModel?: string | null;
}

/**
 * Built-in safety fallback if `AI_DEFAULT_MODEL` is unset at tenant-bootstrap
 * time. Matches the lowest-tier OpenAI model the gateway documents in
 * `factory.ts` so a tenant created without env config still reports
 * `aiConfigPresent` true to the onboarding wizard and the verify_ai worker
 * has a model to attempt. The gateway's own resolution is unaffected.
 */
const AI_MODEL_BOOTSTRAP_FALLBACK = 'gpt-4o-mini';

/**
 * Resolve the AI model to seed onto a freshly-created tenant_settings row.
 * Mirrors the env precedence the gateway uses (`AI_DEFAULT_MODEL`) so the
 * onboarding "AI check" step is unblocked without coupling the settings
 * module to the gateway's tier-resolution code.
 */
export function resolveBootstrapAiModel(): string {
  const env = process.env.AI_DEFAULT_MODEL;
  if (env && env.trim().length > 0) return env;
  return AI_MODEL_BOOTSTRAP_FALLBACK;
}

export interface UpdateSettingsInput {
  businessName?: string;
  // Codex P2 (PR #316): explicit null = clear field. Sending `undefined`
  // means "don't touch" because JSON.stringify drops it; sending null
  // routes through PgSettings.update's `value ?? null` to a SQL NULL.
  businessPhone?: string | null;
  businessEmail?: string | null;
  timezone?: string | null;
  estimatePrefix?: string;
  invoicePrefix?: string;
  defaultPaymentTermDays?: number;
  terminologyPreferences?: Record<string, string>;
  activeVerticalPacks?: string[];
  /** Phase 12 — null clears the backup. */
  backupSupervisorUserId?: string | null;
  /** Phase 12 — see `UnsupervisedProposalRouting` for accepted values. */
  unsupervisedProposalRouting?: UnsupervisedProposalRouting;
  /** Tier 4 — auto-apply low-risk internal AI updates without asking. */
  autoApplyInternalUpdates?: boolean;
  /** Tier 4 — auto-text customers ~2h before scheduled appointments. */
  autoSendAppointmentReminders?: boolean;
  /** P20-001 — auto-draft an invoice (as a proposal) on job completion. */
  autoInvoiceOnCompletion?: boolean;
  /** P21-003 — opt into the daily batch-invoice proposal sweep. */
  batchInvoiceEnabled?: boolean;
  /** P21 — opt into / kill-switch on-completion milestone minting. */
  milestoneBillingEnabled?: boolean;
  /** Tier 4 — per-mode override of the proposal auto-approve threshold. */
  autoApproveThreshold?: Partial<Record<'supervisor' | 'tech' | 'both', number>>;
  /** Tier 4 (Deposit rules) — see TenantSettings doc for correlation rules. */
  depositStrategy?: 'percentage' | 'fixed' | null;
  depositPercentageBps?: number | null;
  depositFixedCents?: number | null;
  depositRequiredAboveCents?: number | null;
  /** Tier 4 — when the deposit is collected relative to approval. */
  depositTimingPolicy?: 'before_approval' | 'after_approval';
  /** §9 — owner's effective hourly rate (integer cents); null clears. */
  hourlyRateCents?: number | null;
  /** B1 — voice persona name; null clears the field. */
  voiceAgentName?: string | null;
  /** B1 — custom greeting text; null clears the field. */
  voiceGreeting?: string | null;
  /** F8 — per-tenant escalation settings; partial — missing keys fall back to DEFAULT_ESCALATION_SETTINGS. */
  escalationSettings?: Partial<EscalationSettings>;
  /** P4-015 — per-tenant brand voice tone; null clears the field. */
  brandVoice?: BrandVoiceSettings | null;
  /** Public review links (4★+ feedback page); null clears the field. */
  googleReviewUrl?: string | null;
  yelpReviewUrl?: string | null;
  /** P11-002 — tenant language stack. */
  defaultLanguage?: Language;
  autoDetectLanguage?: boolean;
  ttsVoiceEn?: string | null;
  ttsVoiceEs?: string | null;
  spanishDispatcherUserIds?: string[];
  /** Per-tenant AI model override; null clears the field. */
  aiModel?: string | null;
}

export interface SettingsRepository {
  create(settings: TenantSettings): Promise<TenantSettings>;
  findByTenant(tenantId: string): Promise<TenantSettings | null>;
  update(tenantId: string, updates: Partial<TenantSettings>): Promise<TenantSettings | null>;
  incrementEstimateNumber(tenantId: string): Promise<number>;
  incrementInvoiceNumber(tenantId: string): Promise<number>;
}

export interface ActiveVerticalPackValidationOptions {
  normalizePackId?: (packId: string) => string;
  isKnownPackId?: (packId: string) => boolean;
  knownPackIds?: string[];
}

export const VALID_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'America/Detroit',
  'America/Indiana/Indianapolis', 'America/Boise', 'UTC',
];

export function validateSettingsInput(
  input: CreateSettingsInput,
  options?: ActiveVerticalPackValidationOptions
): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.businessName) errors.push('businessName is required');
  errors.push(...validateCommonSettingsFields(input));
  errors.push(...validateActiveVerticalPacks(input.activeVerticalPacks, options));
  return errors;
}

export function validateUpdateSettingsInput(
  input: UpdateSettingsInput,
  options?: ActiveVerticalPackValidationOptions
): string[] {
  const errors: string[] = [];
  errors.push(...validateCommonSettingsFields(input));
  errors.push(...validateActiveVerticalPacks(input.activeVerticalPacks, options));
  return errors;
}

function validateCommonSettingsFields(
  input: {
    timezone?: string | null;
    estimatePrefix?: string;
    invoicePrefix?: string;
    defaultPaymentTermDays?: number;
  }
): string[] {
  const errors: string[] = [];
  if (input.timezone && !VALID_TIMEZONES.includes(input.timezone)) {
    errors.push('Invalid timezone');
  }
  if (input.estimatePrefix !== undefined && input.estimatePrefix.length === 0) {
    errors.push('estimatePrefix cannot be empty');
  }
  if (input.invoicePrefix !== undefined && input.invoicePrefix.length === 0) {
    errors.push('invoicePrefix cannot be empty');
  }
  if (input.defaultPaymentTermDays !== undefined && input.defaultPaymentTermDays < 0) {
    errors.push('defaultPaymentTermDays must be non-negative');
  }
  return errors;
}

export function normalizePackId(packId: string): string {
  return packId.trim().toLowerCase();
}

export function normalizeActiveVerticalPacks(
  activeVerticalPacks?: string[],
  normalizeFn: (packId: string) => string = normalizePackId
): string[] | undefined {
  if (!Array.isArray(activeVerticalPacks)) {
    return undefined;
  }

  return activeVerticalPacks.map((packId) => normalizeFn(packId));
}

function validateActiveVerticalPacks(
  activeVerticalPacks?: string[],
  options?: ActiveVerticalPackValidationOptions
): string[] {
  const errors: string[] = [];
  if (activeVerticalPacks === undefined) {
    return errors;
  }

  if (!Array.isArray(activeVerticalPacks)) {
    errors.push('activeVerticalPacks must be an array');
    return errors;
  }

  const normalizeFn = options?.normalizePackId ?? normalizePackId;
  const normalizedKnownPackIds = options?.knownPackIds
    ? new Set(options.knownPackIds.map((id) => normalizeFn(id)))
    : undefined;
  const seen = new Set<string>();

  for (let i = 0; i < activeVerticalPacks.length; i += 1) {
    const value = activeVerticalPacks[i];
    if (typeof value !== 'string') {
      errors.push(`activeVerticalPacks[${i}] must be a string`);
      continue;
    }

    const normalized = normalizeFn(value);
    if (normalized.length === 0) {
      errors.push(`activeVerticalPacks[${i}] must be a non-empty string`);
      continue;
    }

    if (seen.has(normalized)) {
      errors.push(`activeVerticalPacks contains duplicate pack ID: ${normalized}`);
      continue;
    }
    seen.add(normalized);

    if (normalizedKnownPackIds && !normalizedKnownPackIds.has(normalized)) {
      errors.push(`activeVerticalPacks contains unknown pack ID: ${normalized}`);
      continue;
    }

    if (options?.isKnownPackId && !options.isKnownPackId(normalized)) {
      errors.push(`activeVerticalPacks contains unknown pack ID: ${normalized}`);
    }
  }

  return errors;
}

export async function createSettings(
  input: CreateSettingsInput,
  repository: SettingsRepository,
  options?: ActiveVerticalPackValidationOptions
): Promise<TenantSettings> {
  const errors = validateSettingsInput({
    ...input,
    activeVerticalPacks: normalizeActiveVerticalPacks(
      input.activeVerticalPacks,
      options?.normalizePackId ?? normalizePackId
    ),
  }, options);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join('; ')}`);
  }

  const existing = await repository.findByTenant(input.tenantId);
  if (existing) {
    throw new ValidationError('Settings already exist for this tenant');
  }

  const settings: TenantSettings = {
    id: uuidv4(),
    tenantId: input.tenantId,
    businessName: input.businessName,
    businessPhone: input.businessPhone,
    businessEmail: input.businessEmail,
    timezone: input.timezone || 'America/New_York',
    estimatePrefix: input.estimatePrefix || 'EST-',
    invoicePrefix: input.invoicePrefix || 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: input.defaultPaymentTermDays ?? 30,
    terminologyPreferences: input.terminologyPreferences,
    activeVerticalPacks: normalizeActiveVerticalPacks(
      input.activeVerticalPacks,
      options?.normalizePackId ?? normalizePackId
    ),
    defaultLanguage: 'en',
    autoDetectLanguage: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return repository.create(settings);
}

export async function getSettings(
  tenantId: string,
  repository: SettingsRepository
): Promise<TenantSettings | null> {
  return repository.findByTenant(tenantId);
}

export async function updateSettings(
  tenantId: string,
  input: UpdateSettingsInput,
  repository: SettingsRepository,
  options?: ActiveVerticalPackValidationOptions
): Promise<TenantSettings | null> {
  const normalizedInput: UpdateSettingsInput = {
    ...input,
    activeVerticalPacks: normalizeActiveVerticalPacks(
      input.activeVerticalPacks,
      options?.normalizePackId ?? normalizePackId
    ),
  };
  const errors = validateUpdateSettingsInput(normalizedInput, options);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join('; ')}`);
  }

  // Codex P2 (PR #316): UpdateSettingsInput allows null on optional
  // string fields so callers can clear them. Repos accept null at
  // runtime (Pg's `value ?? null` becomes a SQL NULL; InMemory just
  // stores the null). The type cast bridges the gap without widening
  // every TenantSettings consumer to handle null reads — those still
  // see undefined because mapRow normalizes NULL → undefined.
  return repository.update(
    tenantId,
    { ...normalizedInput, updatedAt: new Date() } as Partial<TenantSettings>,
  );
}

/**
 * Idempotent settings seeder.
 *
 * Returns the existing settings row for the tenant if present. If not,
 * creates a default row with conservative defaults and returns that.
 *
 * The "should" path is for `bootstrapTenant` (auth/clerk.ts) to call
 * this when the Clerk webhook fires. This function is also called from
 * `getNextEstimateNumber` / `getNextInvoiceNumber` as a safety net so a
 * tenant whose webhook bootstrap was missed (test fixtures, manual
 * tenant creation, future legacy ingestion) does not see a hard 500
 * the first time it tries to create an estimate or invoice.
 *
 * Idempotency matters: race conditions are tolerated. If two requests
 * call this concurrently for a missing tenant, one will create and the
 * other will see the existing row (or get a duplicate-key conflict
 * from the underlying repo and we fall back to refetching).
 */
export async function ensureTenantSettings(
  tenantId: string,
  repository: SettingsRepository,
  options?: { businessName?: string }
): Promise<TenantSettings> {
  const existing = await repository.findByTenant(tenantId);
  if (existing) return existing;

  const settings: TenantSettings = {
    id: uuidv4(),
    tenantId,
    businessName: options?.businessName ?? 'My Business',
    timezone: 'America/New_York',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    defaultLanguage: 'en',
    autoDetectLanguage: true,
    // Onboarding-blocker fix: seed the platform default AI model so the
    // onboarding "AI check" (Step 6) does not fail with `ai_config_missing`
    // for every new tenant. The webhooks/routes.ts billing handler also
    // backfills via COALESCE for tenants whose bootstrap predates this code,
    // so writing here never clobbers an existing tenant's override.
    aiModel: resolveBootstrapAiModel(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    return await repository.create(settings);
  } catch {
    // Race: another request created the settings row between the
    // findByTenant() above and the create() here. Refetch and return.
    const after = await repository.findByTenant(tenantId);
    if (after) return after;
    throw new ValidationError(
      `ensureTenantSettings: could not create or refetch settings for tenant ${tenantId}`
    );
  }
}

export async function getNextEstimateNumber(
  tenantId: string,
  repository: SettingsRepository
): Promise<string> {
  // Lazy-seed: do not throw on missing settings. The webhook bootstrap
  // is the SHOULD path; this is the safety net for any code path that
  // didn't go through it.
  const settings = await ensureTenantSettings(tenantId, repository);
  const num = await repository.incrementEstimateNumber(tenantId);
  // padStart(4, '0') pads numbers under 10000; larger numbers naturally produce wider strings
  return `${settings.estimatePrefix}${String(num).padStart(4, '0')}`;
}

export async function getNextInvoiceNumber(
  tenantId: string,
  repository: SettingsRepository
): Promise<string> {
  const settings = await ensureTenantSettings(tenantId, repository);
  const num = await repository.incrementInvoiceNumber(tenantId);
  // padStart(4, '0') pads numbers under 10000; larger numbers naturally produce wider strings
  return `${settings.invoicePrefix}${String(num).padStart(4, '0')}`;
}

/**
 * Tier 4 — entity-label keys the Terminology sheet edits.
 * These describe how the tenant wants ServiceOS to refer to common
 * CRM entities (e.g. "Quote" instead of "Estimate", "Project" instead
 * of "Job"). Distinct from per-vertical equipment terminology keys
 * which come from the active pack at runtime.
 *
 * Used by `validateTerminologyPreferences` so a PUT /api/settings can
 * persist these regardless of which vertical packs are active. The
 * onboarding route already writes these keys directly through the
 * repo; this allowlist makes them editable through the API too.
 */
export const ENTITY_LABEL_TERMINOLOGY_KEYS = [
  'jobTerm',
  'estimateTerm',
  'invoiceTerm',
  'customerTerm',
  'appointmentTerm',
  'workerTerm',
  // Onboarding seeds these too — included here so a re-save of the
  // existing payload doesn't accidentally fail validation.
  'teamSize',
  'ownerName',
] as const;

export function validateTerminologyPreferences(
  preferences: Record<string, string>,
  validKeys?: string[]
): string[] {
  const errors: string[] = [];
  if (!preferences || typeof preferences !== 'object') {
    errors.push('terminologyPreferences must be an object');
    return errors;
  }
  const allowed = validKeys
    ? new Set([...validKeys, ...ENTITY_LABEL_TERMINOLOGY_KEYS])
    : null;
  for (const [key, value] of Object.entries(preferences)) {
    if (!key || key.trim().length === 0) {
      errors.push('terminologyPreferences key must not be empty');
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`terminologyPreferences value for "${key}" must be a non-empty string`);
    }
    if (allowed && !allowed.has(key)) {
      errors.push(`terminologyPreferences key "${key}" is not a recognized term for the active vertical`);
    }
  }
  return errors;
}

export async function updateTerminologyPreferences(
  tenantId: string,
  preferences: Record<string, string>,
  repository: SettingsRepository
): Promise<TenantSettings | null> {
  return repository.update(tenantId, {
    terminologyPreferences: preferences,
    updatedAt: new Date(),
  });
}

export class InMemorySettingsRepository implements SettingsRepository {
  private settings: Map<string, TenantSettings> = new Map();

  async create(settings: TenantSettings): Promise<TenantSettings> {
    this.settings.set(settings.tenantId, { ...settings });
    return { ...settings };
  }

  async findByTenant(tenantId: string): Promise<TenantSettings | null> {
    const s = this.settings.get(tenantId);
    return s ? { ...s } : null;
  }

  async update(tenantId: string, updates: Partial<TenantSettings>): Promise<TenantSettings | null> {
    const s = this.settings.get(tenantId);
    if (!s) return null;
    const { id: _id, tenantId: _tid, createdAt: _ca, ...safeUpdates } = updates;
    const updated = { ...s, ...safeUpdates };
    this.settings.set(tenantId, updated);
    return { ...updated };
  }

  async incrementEstimateNumber(tenantId: string): Promise<number> {
    const s = this.settings.get(tenantId);
    if (!s) throw new ValidationError('Settings not found');
    const num = s.nextEstimateNumber;
    s.nextEstimateNumber += 1;
    this.settings.set(tenantId, s);
    return num;
  }

  async incrementInvoiceNumber(tenantId: string): Promise<number> {
    const s = this.settings.get(tenantId);
    if (!s) throw new ValidationError('Settings not found');
    const num = s.nextInvoiceNumber;
    s.nextInvoiceNumber += 1;
    this.settings.set(tenantId, s);
    return num;
  }
}
