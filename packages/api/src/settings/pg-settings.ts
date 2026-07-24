import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DEFAULT_ESCALATION_SETTINGS,
  EscalationSettings,
  SettingsRepository,
  TenantSettings,
  normalizeReminderOffsets,
} from './settings';

/**
 * node-pg returns JSONB already parsed, but tolerate a string form too so a
 * stringified column (e.g. via some drivers/migrations) still yields an array.
 */
function parseJsonbArray(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function mapRow(row: Record<string, unknown>): TenantSettings {
  const terminologyRaw = row.terminology_preferences as Record<string, unknown> | null;
  let terminologyPreferences: Record<string, string> | undefined;
  let activeVerticalPacks: string[] | undefined;

  if (terminologyRaw) {
    const { _activeVerticalPacks, ...rest } = terminologyRaw;
    if (Object.keys(rest).length > 0) {
      terminologyPreferences = rest as Record<string, string>;
    }
    if (Array.isArray(_activeVerticalPacks)) {
      activeVerticalPacks = _activeVerticalPacks as string[];
    }
  }

  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    businessName: row.business_name as string,
    businessPhone: (row.business_phone as string) ?? undefined,
    businessEmail: (row.business_email as string) ?? undefined,
    ownerPhone: (row.owner_phone as string) ?? undefined,
    timezone: row.timezone as string,
    estimatePrefix: row.estimate_prefix as string,
    invoicePrefix: row.invoice_prefix as string,
    nextEstimateNumber: row.next_estimate_number as number,
    nextInvoiceNumber: row.next_invoice_number as number,
    defaultPaymentTermDays: row.default_payment_term_days as number,
    terminologyPreferences,
    activeVerticalPacks,
    // Phase 12 — columns added in migration 063 (P12-001).
    backupSupervisorUserId: (row.backup_supervisor_user_id as string) ?? null,
    unsupervisedProposalRouting:
      (row.unsupervised_proposal_routing as
        | 'queue_and_sms'
        | 'queue_only'
        | 'escalate_to_oncall'
        | null) ?? undefined,
    // Tier 4 — migration 075. Booleans default at the column level so
    // a row created before this migration reads as the migration's
    // DEFAULT value.
    autoApplyInternalUpdates: row.auto_apply_internal_updates as boolean | undefined,
    autoSendAppointmentReminders: row.auto_send_appointment_reminders as boolean | undefined,
    appointmentReminderOffsetsHours: normalizeReminderOffsets(
      parseJsonbArray(row.appointment_reminder_offsets_hours),
    ),
    autoInvoiceOnCompletion: row.auto_invoice_on_completion as boolean | undefined,
    // Migration 194 — DEFAULT TRUE at the column level so legacy rows
    // surface as `true` (matches the "built-in, included" framing).
    sendThankYouSms: row.send_thank_you_sms as boolean | undefined,
    sendReviewRequest: row.send_review_request as boolean | undefined,
    billLaborFromTimeEntries: row.bill_labor_from_time_entries as boolean | undefined,
    batchInvoiceEnabled: row.batch_invoice_enabled as boolean | undefined,
    milestoneBillingEnabled: row.milestone_billing_enabled as boolean | undefined,
    // Tier 4 — migration 076. JSONB column; pg returns the parsed
    // object directly. Empty object means "no overrides" — surface as
    // undefined so consumers can rely on the same shape across both
    // repositories.
    autoApproveThreshold: (() => {
      const raw = row.auto_approve_threshold as
        | Partial<Record<'supervisor' | 'tech' | 'both', number>>
        | null
        | undefined;
      if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return undefined;
      return raw;
    })(),
    // Tier 4 — migration 077. Deposit rule columns. NULL columns
    // surface as undefined to match the InMemory repo shape; consumers
    // distinguish "rule not configured" from "rule cleared" via the
    // explicit `null` sent on update payloads.
    depositStrategy: (row.deposit_strategy as 'percentage' | 'fixed' | null) ?? undefined,
    depositPercentageBps: (row.deposit_percentage_bps as number | null) ?? undefined,
    depositFixedCents: (row.deposit_fixed_cents as number | null) ?? undefined,
    depositRequiredAboveCents:
      (row.deposit_required_above_cents as number | null) ?? undefined,
    // P2-036 V2 (Discount policy — U1) — migration 178. All three columns
    // are nullable with no DEFAULT; NULL surfaces as undefined to match the
    // InMemory repo shape. resolveDiscountPolicy fail-closes any absent
    // value to the V1-identical posture.
    discountMaxBps: (row.discount_max_bps as number | null) ?? undefined,
    discountFloorCents: (row.discount_floor_cents as number | null) ?? undefined,
    discountNeverBelowCatalog:
      (row.discount_never_below_catalog as boolean | null) ?? undefined,
    // Tier 4 — migration 079. Default 'after_approval' applies at the
    // column level so any row written before this migration reads as
    // the safe pre-existing flow.
    depositTimingPolicy:
      (row.deposit_timing_policy as 'before_approval' | 'after_approval' | null) ?? undefined,
    // §9 — migration 098. Owner's hourly rate (integer cents).
    hourlyRateCents: (row.hourly_rate_cents as number | null) ?? undefined,
    // §10 — identity fields persisted by PUT /api/onboarding/identity.
    // Projected here so GET /api/settings returns them for the
    // IdentityStep re-edit pre-load. NULL → undefined per the rest of
    // this mapper's convention.
    serviceAreaText: (row.service_area_text as string | null) ?? undefined,
    serviceAreaRadius: (row.service_area_radius as number | null) ?? undefined,
    businessHours: (() => {
      const raw = row.business_hours as
        | Record<string, { open: string; close: string } | null>
        | null
        | undefined;
      if (!raw || typeof raw !== 'object') return undefined;
      return raw;
    })(),
    jobBufferMinutes: (row.job_buffer_minutes as number | null) ?? undefined,
    // P22-005 (U7) — migration 181. Billable labor rate (integer cents/hr).
    laborRateCentsPerHour:
      (row.labor_rate_cents_per_hour as number | null) ?? undefined,
    // B1 — migration 088. NULL from DB → undefined in TS (same
    // convention as all other nullable optional columns here).
    voiceAgentName: (row.voice_agent_name as string | null) ?? undefined,
    voiceGreeting: (row.voice_greeting as string | null) ?? undefined,
    // Feature 4 — migration 147. Vapi binding columns. findByTenant uses
    // SELECT *, so the row carries these; NULL → undefined per this mapper's
    // convention. Read-only projection (set by the provisioning worker /
    // voice-config raw SQL, not the update fieldMap below).
    voiceId: (row.voice_id as string | null) ?? undefined,
    vapiAssistantId: (row.vapi_assistant_id as string | null) ?? undefined,
    // Story 15.2 — migration 205. speed_to_lead_enabled is NOT NULL DEFAULT
    // false so legacy rows read false; template NULL → undefined.
    speedToLeadEnabled: (row.speed_to_lead_enabled as boolean | null) ?? false,
    speedToLeadTemplate: (row.speed_to_lead_template as string | null) ?? undefined,
    escalationSettings: (() => {
      const raw = row.escalation_settings as Partial<EscalationSettings> | null | undefined;
      if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
        return undefined;
      }
      return { ...DEFAULT_ESCALATION_SETTINGS, ...raw };
    })(),
    // P4-015 — migration 110. JSONB column; pg returns the parsed object
    // directly. Empty object means "not configured" — surface as undefined
    // so the brand-voice composer falls back to its neutral default tone.
    brandVoice: (() => {
      const raw = row.brand_voice as Record<string, unknown> | null | undefined;
      if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return undefined;
      return raw as TenantSettings['brandVoice'];
    })(),
    // N-011 — migration 238 bookkeeping columns. NOT NULL DEFAULT 0/false so a
    // pre-migration row reads version 0 / unlocked; updated_at NULL → null.
    brandVoiceVersion: (row.brand_voice_version as number | null) ?? 0,
    brandVoiceLocked: (row.brand_voice_locked as boolean | null) ?? false,
    brandVoiceUpdatedAt: (() => {
      const v = row.brand_voice_updated_at as Date | string | null | undefined;
      if (v == null) return null;
      return v instanceof Date ? v.toISOString() : String(v);
    })(),
    // Migration 120. NULL → undefined to match the InMemory repo shape.
    googleReviewUrl: (row.google_review_url as string | null) ?? undefined,
    yelpReviewUrl: (row.yelp_review_url as string | null) ?? undefined,
    // P11-002 — language stack. default_language / auto_detect_language
    // are NOT NULL with column defaults, so a pre-migration row still
    // reads 'en' / true.
    defaultLanguage: (row.default_language as 'en' | 'es' | null) ?? 'en',
    autoDetectLanguage: (row.auto_detect_language as boolean | null) ?? true,
    ttsVoiceEn: (row.tts_voice_en as string | null) ?? undefined,
    ttsVoiceEs: (row.tts_voice_es as string | null) ?? undefined,
    spanishDispatcherUserIds:
      (row.spanish_dispatcher_user_ids as string[] | null) ?? undefined,
    // Voice-parity (migration 152). supported_languages is NOT NULL with a
    // DEFAULT ARRAY['en'], so a pre-migration row still reads ['en'].
    // transfer_number is nullable → undefined when unset.
    supportedLanguages:
      (row.supported_languages as ('en' | 'es')[] | null) ?? ['en'],
    transferNumber: (row.transfer_number as string | null) ?? undefined,
    // Migration 120 (`120_tenant_settings_ai_config`). NULL → undefined to
    // match the InMemory repo shape; consumers (onboarding's
    // `aiConfigPresent`, verify_ai worker) treat undefined as "not seeded".
    aiModel: (row.ai_model as string | null) ?? undefined,
    // RV-063 — migration 163. NOT NULL with column defaults, so a
    // pre-migration row reads as the defaults (false / 18:00 / sms).
    // Postgres TIME comes back as 'HH:MM:SS'; normalize to 'HH:MM' so
    // consumers (worker bucket matching, settings UI) see one shape.
    digestEnabled: (row.digest_enabled as boolean | null) ?? false,
    digestTime: normalizeDigestTime(row.digest_time),
    digestChannel: (row.digest_channel as 'sms' | 'none' | null) ?? 'sms',
    // Epic 12.6 — migration 204. Opt-out: column defaults true, so a
    // pre-migration row reads as enabled.
    weeklyFeedbackEnabled: (row.weekly_feedback_enabled as boolean | null) ?? true,
    // UB-D / D-015 — migration 231. enabled is NOT NULL DEFAULT FALSE so
    // legacy rows read false. threshold is NUMERIC(3,2), which node-pg
    // returns as a STRING (the only fractional NUMERIC column on this
    // table) — convert explicitly instead of the bare int-column casts
    // used elsewhere in this mapper.
    autonomousBookingEnabled: (row.autonomous_booking_enabled as boolean | null) ?? false,
    autonomousBookingThreshold:
      row.autonomous_booking_threshold != null
        ? Number(row.autonomous_booking_threshold)
        : undefined,
    // D-018 (WS18) — migration 247. enabled is NOT NULL DEFAULT FALSE so
    // legacy rows read false; max_cents is a nullable BIGINT (node-pg
    // returns bigint as a string — convert explicitly).
    autonomousCloseEnabled: (row.autonomous_close_enabled as boolean | null) ?? false,
    autonomousCloseMaxCents:
      row.autonomous_close_max_cents != null
        ? Number(row.autonomous_close_max_cents)
        : undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function normalizeDigestTime(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 5) return '18:00';
  return raw.slice(0, 5);
}

function buildTerminologyJson(
  terminologyPreferences?: Record<string, string>,
  activeVerticalPacks?: string[]
): Record<string, unknown> | null {
  const hasTerminology = terminologyPreferences && Object.keys(terminologyPreferences).length > 0;
  const hasPacks = activeVerticalPacks && activeVerticalPacks.length > 0;

  if (!hasTerminology && !hasPacks) return null;

  const result: Record<string, unknown> = {};
  if (hasTerminology) {
    Object.assign(result, terminologyPreferences);
  }
  if (hasPacks) {
    result._activeVerticalPacks = activeVerticalPacks;
  }
  return result;
}

export class PgSettingsRepository extends PgBaseRepository implements SettingsRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(settings: TenantSettings): Promise<TenantSettings> {
    return this.withTenant(settings.tenantId, async (client) => {
      const terminologyJson = buildTerminologyJson(
        settings.terminologyPreferences,
        settings.activeVerticalPacks
      );

      const result = await client.query(
        `INSERT INTO tenant_settings (
          id, tenant_id, business_name, business_phone, business_email,
          owner_phone, timezone, estimate_prefix, invoice_prefix, next_estimate_number,
          next_invoice_number, default_payment_term_days, terminology_preferences,
          ai_model, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *`,
        [
          settings.id,
          settings.tenantId,
          settings.businessName,
          settings.businessPhone ?? null,
          settings.businessEmail ?? null,
          settings.ownerPhone ?? null,
          settings.timezone,
          settings.estimatePrefix,
          settings.invoicePrefix,
          settings.nextEstimateNumber,
          settings.nextInvoiceNumber,
          settings.defaultPaymentTermDays,
          terminologyJson ? JSON.stringify(terminologyJson) : null,
          // Onboarding-blocker fix: persist the seeded ai_model so the
          // verify_ai worker finds a model on the very first tenant_settings
          // row. The COALESCE backfill in webhooks/routes.ts is kept as a
          // safety net for tenants whose bootstrap predates this code.
          settings.aiModel ?? null,
          settings.createdAt,
          settings.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByTenant(tenantId: string): Promise<TenantSettings | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM tenant_settings WHERE tenant_id = $1',
        [tenantId]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async update(tenantId: string, updates: Partial<TenantSettings>): Promise<TenantSettings | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // If terminology or packs are being updated, we need to merge with existing.
      // Sweep-2 S1: an `undefined` VALUE means "untouched", never "clear" —
      // the contract types these keys as `string[]` / `Record<string,string>`
      // (no null), so an explicit clear is `[]` / `{}`. Keying off `'x' in
      // updates` let a stray `activeVerticalPacks: undefined` wipe the
      // tenant's packs on every unrelated save.
      const touchesTerms = updates.terminologyPreferences !== undefined;
      const touchesPacks = updates.activeVerticalPacks !== undefined;
      const needsTerminologyMerge = touchesTerms || touchesPacks;

      let terminologyJson: Record<string, unknown> | null | undefined;

      if (needsTerminologyMerge) {
        const existing = await client.query(
          'SELECT terminology_preferences FROM tenant_settings WHERE tenant_id = $1',
          [tenantId]
        );
        if (existing.rows.length === 0) return null;

        const currentRaw = existing.rows[0].terminology_preferences as Record<string, unknown> | null;
        const { _activeVerticalPacks: currentPacks, ...currentTerms } = currentRaw ?? {};

        const newTerms = touchesTerms
          ? updates.terminologyPreferences
          : (Object.keys(currentTerms).length > 0 ? currentTerms as Record<string, string> : undefined);

        const newPacks = touchesPacks
          ? updates.activeVerticalPacks
          : (Array.isArray(currentPacks) ? currentPacks as string[] : undefined);

        terminologyJson = buildTerminologyJson(newTerms, newPacks);
      }

      const fieldMap: Record<string, string> = {
        businessName: 'business_name',
        businessPhone: 'business_phone',
        businessEmail: 'business_email',
        ownerPhone: 'owner_phone',
        timezone: 'timezone',
        estimatePrefix: 'estimate_prefix',
        invoicePrefix: 'invoice_prefix',
        nextEstimateNumber: 'next_estimate_number',
        nextInvoiceNumber: 'next_invoice_number',
        defaultPaymentTermDays: 'default_payment_term_days',
        // Phase 12 — migration 063.
        backupSupervisorUserId: 'backup_supervisor_user_id',
        unsupervisedProposalRouting: 'unsupervised_proposal_routing',
        // Tier 4 — migration 075.
        autoApplyInternalUpdates: 'auto_apply_internal_updates',
        autoSendAppointmentReminders: 'auto_send_appointment_reminders',
        autoInvoiceOnCompletion: 'auto_invoice_on_completion',
        // Migration 194.
        sendThankYouSms: 'send_thank_you_sms',
        // Migration 214 — post-job 24h review request opt-out.
        sendReviewRequest: 'send_review_request',
        billLaborFromTimeEntries: 'bill_labor_from_time_entries',
        batchInvoiceEnabled: 'batch_invoice_enabled',
        milestoneBillingEnabled: 'milestone_billing_enabled',
        // Tier 4 — migration 077. Deposit rules. Each accepts an
        // explicit `null` to clear the value (vs `undefined` which
        // means "don't touch this field on update").
        depositStrategy: 'deposit_strategy',
        depositPercentageBps: 'deposit_percentage_bps',
        depositFixedCents: 'deposit_fixed_cents',
        depositRequiredAboveCents: 'deposit_required_above_cents',
        // P2-036 V2 (Discount policy — U1) — migration 178. Each accepts an
        // explicit `null` to clear the value (vs `undefined` = "don't touch").
        discountMaxBps: 'discount_max_bps',
        discountFloorCents: 'discount_floor_cents',
        discountNeverBelowCatalog: 'discount_never_below_catalog',
        // Tier 4 — migration 079.
        depositTimingPolicy: 'deposit_timing_policy',
        // Foundation gate (I12/V17) — migration 148 stored it, onboarding
        // wrote it, but the generic update path dropped it, so the travel
        // buffer could never be changed from the settings surface.
        jobBufferMinutes: 'job_buffer_minutes',
        // §9 — migration 098.
        hourlyRateCents: 'hourly_rate_cents',
        // P22-005 (U7) — migration 181.
        laborRateCentsPerHour: 'labor_rate_cents_per_hour',
        // B1 — migration 088.
        voiceAgentName: 'voice_agent_name',
        voiceGreeting: 'voice_greeting',
        escalationSettings: 'escalation_settings',
        // Migration 120 — public review links.
        googleReviewUrl: 'google_review_url',
        yelpReviewUrl: 'yelp_review_url',
        // P11-002 — language stack.
        defaultLanguage: 'default_language',
        autoDetectLanguage: 'auto_detect_language',
        ttsVoiceEn: 'tts_voice_en',
        ttsVoiceEs: 'tts_voice_es',
        spanishDispatcherUserIds: 'spanish_dispatcher_user_ids',
        // Voice-parity — migration 152. transfer_number is plain TEXT and
        // flows through the generic handler; supported_languages is text[]
        // and is special-cased below (like spanish_dispatcher_user_ids).
        transferNumber: 'transfer_number',
        // Migration 120 — per-tenant AI model override.
        aiModel: 'ai_model',
        // Story 15.2 — migration 205.
        speedToLeadEnabled: 'speed_to_lead_enabled',
        speedToLeadTemplate: 'speed_to_lead_template',
        // RV-063 — migration 163. digest_time accepts 'HH:MM' (Postgres
        // casts to TIME); digest_channel is CHECK-constrained in the DB
        // and validated at the route boundary.
        digestEnabled: 'digest_enabled',
        digestTime: 'digest_time',
        digestChannel: 'digest_channel',
        // Epic 12.6 — migration 204.
        weeklyFeedbackEnabled: 'weekly_feedback_enabled',
        // UB-D / D-015 — migration 231. Both NOT NULL with column defaults;
        // route validation (Zod + validateCommonSettingsFields) never passes
        // null through, so the generic `value ?? null` handler is safe.
        autonomousBookingEnabled: 'autonomous_booking_enabled',
        autonomousBookingThreshold: 'autonomous_booking_threshold',
        // D-018 (WS18) — migration 247.
        autonomousCloseEnabled: 'autonomous_close_enabled',
        autonomousCloseMaxCents: 'autonomous_close_max_cents',
        updatedAt: 'updated_at',
      };

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updates)) {
        if (key === 'terminologyPreferences' || key === 'activeVerticalPacks') continue;
        // Tier 4 — auto_approve_threshold is JSONB; pg expects a string
        // for parameterized JSONB writes. Pass `'{}'` for cleared
        // (undefined / empty object) so the column matches its DEFAULT
        // and downstream reads surface as undefined per mapRow.
        if (key === 'autoApproveThreshold') {
          setClauses.push(`auto_approve_threshold = $${paramIndex}::jsonb`);
          const v = value as Record<string, number> | undefined | null;
          params.push(v && Object.keys(v).length > 0 ? JSON.stringify(v) : '{}');
          paramIndex++;
          continue;
        }
        // Story 10.2 — appointment_reminder_offsets_hours is JSONB. Normalize
        // (dedupe/clamp/sort/cap) before persist so the column never holds an
        // out-of-range or duplicate cadence; a cleared write resets to [24].
        if (key === 'appointmentReminderOffsetsHours') {
          setClauses.push(`appointment_reminder_offsets_hours = $${paramIndex}::jsonb`);
          params.push(JSON.stringify(normalizeReminderOffsets(value)));
          paramIndex++;
          continue;
        }
        // Foundation gate (I12/V17) — business_hours is JSONB and was
        // previously writable only through the onboarding identity route's
        // raw SQL; the generic update silently DROPPED the key, so a
        // settings-surface hours change never reached the scheduler. A
        // cleared write ('{}' for undefined/empty/null) reads back as
        // "not configured" and the scheduler falls back to defaults.
        if (key === 'businessHours') {
          setClauses.push(`business_hours = $${paramIndex}::jsonb`);
          const v = value as Record<string, unknown> | undefined | null;
          params.push(
            v && typeof v === 'object' && Object.keys(v).length > 0
              ? JSON.stringify(v)
              : '{}',
          );
          paramIndex++;
          continue;
        }
        if (key === 'escalationSettings') {
          setClauses.push(`escalation_settings = $${paramIndex}::jsonb`);
          const v = value as Partial<EscalationSettings> | undefined | null;
          params.push(
            v && typeof v === 'object' && Object.keys(v).length > 0
              ? JSON.stringify(v)
              : '{}',
          );
          paramIndex++;
          continue;
        }
        // P4-015 — brand_voice is JSONB; mirror the threshold/escalation
        // pattern. Cleared (undefined / empty / null) writes '{}' so the
        // column matches its DEFAULT and reads back as undefined.
        if (key === 'brandVoice') {
          setClauses.push(`brand_voice = $${paramIndex}::jsonb`);
          const v = value as Record<string, unknown> | undefined | null;
          params.push(
            v && typeof v === 'object' && Object.keys(v).length > 0
              ? JSON.stringify(v)
              : '{}',
          );
          paramIndex++;
          continue;
        }
        // P11-002 — spanish_dispatcher_user_ids is a native Postgres uuid[]
        // column. Cast the param explicitly so node-pg's array serialization
        // is interpreted as uuid[] regardless of placeholder context, and
        // pass null (not '{}') to clear since the column is nullable.
        if (key === 'spanishDispatcherUserIds') {
          setClauses.push(`spanish_dispatcher_user_ids = $${paramIndex}::uuid[]`);
          const v = value as string[] | undefined | null;
          params.push(Array.isArray(v) ? v : null);
          paramIndex++;
          continue;
        }
        // Voice-parity (migration 152) — supported_languages is a native
        // Postgres text[] column (NOT NULL DEFAULT ARRAY['en']). Cast the param
        // explicitly and default a cleared/empty write back to ['en'] so the
        // column never goes empty and reads stay English-safe.
        if (key === 'supportedLanguages') {
          setClauses.push(`supported_languages = $${paramIndex}::text[]`);
          const v = value as string[] | undefined | null;
          params.push(Array.isArray(v) && v.length > 0 ? v : ['en']);
          paramIndex++;
          continue;
        }
        const column = fieldMap[key];
        if (column) {
          setClauses.push(`${column} = $${paramIndex}`);
          params.push(value ?? null);
          paramIndex++;
        }
      }

      if (needsTerminologyMerge) {
        setClauses.push(`terminology_preferences = $${paramIndex}`);
        params.push(terminologyJson ? JSON.stringify(terminologyJson) : null);
        paramIndex++;
      }

      if (setClauses.length === 0) return this.findByTenant(tenantId);

      params.push(tenantId);
      const result = await client.query(
        `UPDATE tenant_settings SET ${setClauses.join(', ')}
         WHERE tenant_id = $${paramIndex}
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async incrementEstimateNumber(tenantId: string): Promise<number> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_settings
         SET next_estimate_number = next_estimate_number + 1, updated_at = NOW()
         WHERE tenant_id = $1
         RETURNING next_estimate_number - 1 AS current_number`,
        [tenantId]
      );
      if (result.rows.length === 0) throw new Error('Settings not found');
      return result.rows[0].current_number as number;
    });
  }

  async incrementInvoiceNumber(tenantId: string): Promise<number> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_settings
         SET next_invoice_number = next_invoice_number + 1, updated_at = NOW()
         WHERE tenant_id = $1
         RETURNING next_invoice_number - 1 AS current_number`,
        [tenantId]
      );
      if (result.rows.length === 0) throw new Error('Settings not found');
      return result.rows[0].current_number as number;
    });
  }
}
