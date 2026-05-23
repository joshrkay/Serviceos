import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DEFAULT_ESCALATION_SETTINGS,
  EscalationSettings,
  SettingsRepository,
  TenantSettings,
} from './settings';

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
    // Tier 4 — migration 079. Default 'after_approval' applies at the
    // column level so any row written before this migration reads as
    // the safe pre-existing flow.
    depositTimingPolicy:
      (row.deposit_timing_policy as 'before_approval' | 'after_approval' | null) ?? undefined,
    // §9 — migration 098. Owner's hourly rate (integer cents).
    hourlyRateCents: (row.hourly_rate_cents as number | null) ?? undefined,
    // B1 — migration 088. NULL from DB → undefined in TS (same
    // convention as all other nullable optional columns here).
    voiceAgentName: (row.voice_agent_name as string | null) ?? undefined,
    voiceGreeting: (row.voice_greeting as string | null) ?? undefined,
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
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
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
          timezone, estimate_prefix, invoice_prefix, next_estimate_number,
          next_invoice_number, default_payment_term_days, terminology_preferences,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`,
        [
          settings.id,
          settings.tenantId,
          settings.businessName,
          settings.businessPhone ?? null,
          settings.businessEmail ?? null,
          settings.timezone,
          settings.estimatePrefix,
          settings.invoicePrefix,
          settings.nextEstimateNumber,
          settings.nextInvoiceNumber,
          settings.defaultPaymentTermDays,
          terminologyJson ? JSON.stringify(terminologyJson) : null,
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
      // If terminology or packs are being updated, we need to merge with existing
      const needsTerminologyMerge =
        'terminologyPreferences' in updates || 'activeVerticalPacks' in updates;

      let terminologyJson: Record<string, unknown> | null | undefined;

      if (needsTerminologyMerge) {
        const existing = await client.query(
          'SELECT terminology_preferences FROM tenant_settings WHERE tenant_id = $1',
          [tenantId]
        );
        if (existing.rows.length === 0) return null;

        const currentRaw = existing.rows[0].terminology_preferences as Record<string, unknown> | null;
        const { _activeVerticalPacks: currentPacks, ...currentTerms } = currentRaw ?? {};

        const newTerms = 'terminologyPreferences' in updates
          ? updates.terminologyPreferences
          : (Object.keys(currentTerms).length > 0 ? currentTerms as Record<string, string> : undefined);

        const newPacks = 'activeVerticalPacks' in updates
          ? updates.activeVerticalPacks
          : (Array.isArray(currentPacks) ? currentPacks as string[] : undefined);

        terminologyJson = buildTerminologyJson(newTerms, newPacks);
      }

      const fieldMap: Record<string, string> = {
        businessName: 'business_name',
        businessPhone: 'business_phone',
        businessEmail: 'business_email',
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
        // Tier 4 — migration 077. Deposit rules. Each accepts an
        // explicit `null` to clear the value (vs `undefined` which
        // means "don't touch this field on update").
        depositStrategy: 'deposit_strategy',
        depositPercentageBps: 'deposit_percentage_bps',
        depositFixedCents: 'deposit_fixed_cents',
        depositRequiredAboveCents: 'deposit_required_above_cents',
        // Tier 4 — migration 079.
        depositTimingPolicy: 'deposit_timing_policy',
        // §9 — migration 098.
        hourlyRateCents: 'hourly_rate_cents',
        // B1 — migration 088.
        voiceAgentName: 'voice_agent_name',
        voiceGreeting: 'voice_greeting',
        escalationSettings: 'escalation_settings',
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
