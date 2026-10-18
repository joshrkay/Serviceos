/**
 * Onboarding draft repository — the pre-approval state of "pick, don't build"
 * setup. One draft per tenant: the assembled typical shop plus staged choices.
 *
 * RLS: migration 311 enables + forces RLS; PgBaseRepository.withTenant sets
 * `app.current_tenant_id`. Every query also carries an explicit tenant_id
 * predicate because RLS enforcement is a runtime flag (db/rls-runtime-role.ts).
 *
 * Concurrency: `stageChoice` is a compare-and-swap on `version`, so two tabs
 * cannot silently overwrite each other; the loser gets DraftVersionConflictError
 * and re-reads.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { AssembledShop } from '../choices/assemble';
import { ChoiceKeySchema, type AnyChoiceKey } from '../choices/schema';
import { ChoicesRecordSchema, DraftStatusSchema, StagedChoiceSchema, type ChoicesRecord, type DraftStatus, type StagedChoice } from './contracts';

export class DraftNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`no onboarding draft for tenant ${tenantId}`);
    this.name = 'DraftNotFoundError';
  }
}
export class DraftVersionConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`onboarding draft version conflict: expected ${expected}, found ${actual}`);
    this.name = 'DraftVersionConflictError';
  }
}
export class DraftAlreadyApprovedError extends Error {
  constructor() {
    super('onboarding draft is already approved');
    this.name = 'DraftAlreadyApprovedError';
  }
}

export interface OnboardingDraft {
  id: string;
  tenantId: string;
  packId: string;
  trade: string;
  metroCode: string | null;
  metroName: string | null;
  businessName: string;
  ownerFirstName: string | null;
  clientTimezone: string | null;
  assembled: AssembledShop;
  choices: ChoicesRecord;
  status: DraftStatus;
  version: number;
  proposalIds: string[];
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
}

export interface CreateDraftRecord {
  packId: string;
  trade: string;
  metroCode: string | null;
  metroName: string | null;
  businessName: string;
  ownerFirstName: string | null;
  clientTimezone: string | null;
  assembled: AssembledShop;
}

export interface OnboardingDraftRepository {
  getForTenant(tenantId: string): Promise<OnboardingDraft | null>;
  /** Creates the tenant's draft, or returns the existing one unchanged. */
  create(tenantId: string, input: CreateDraftRecord): Promise<OnboardingDraft>;
  stageChoice(tenantId: string, settingKey: AnyChoiceKey, choice: StagedChoice, expectedVersion: number): Promise<OnboardingDraft>;
  /** Marks approved and records the proposal ids; a no-op returning the row when already approved. */
  markApproved(tenantId: string, proposalIds: string[]): Promise<OnboardingDraft>;
}

interface DraftRow {
  id: string;
  tenant_id: string;
  pack_id: string;
  trade: string;
  metro_code: string | null;
  metro_name: string | null;
  business_name: string;
  owner_first_name: string | null;
  client_timezone: string | null;
  assembled: unknown;
  choices: unknown;
  status: string;
  version: number;
  proposal_ids: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  approved_at: string | Date | null;
}

function mapRow(row: DraftRow): OnboardingDraft {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    packId: row.pack_id,
    trade: row.trade,
    metroCode: row.metro_code,
    metroName: row.metro_name,
    businessName: row.business_name,
    ownerFirstName: row.owner_first_name,
    clientTimezone: row.client_timezone,
    assembled: row.assembled as AssembledShop,
    choices: ChoicesRecordSchema.parse(row.choices ?? {}),
    status: DraftStatusSchema.parse(row.status),
    version: row.version,
    proposalIds: Array.isArray(row.proposal_ids) ? (row.proposal_ids as string[]) : [],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    approvedAt: row.approved_at ? new Date(row.approved_at) : null,
  };
}

export class PgOnboardingDraftRepository extends PgBaseRepository implements OnboardingDraftRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async getForTenant(tenantId: string): Promise<OnboardingDraft | null> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query<DraftRow>('SELECT * FROM onboarding_drafts WHERE tenant_id = $1', [tenantId]);
      return r.rows.length > 0 ? mapRow(r.rows[0]) : null;
    });
  }

  async create(tenantId: string, input: CreateDraftRecord): Promise<OnboardingDraft> {
    return this.withTenant(tenantId, async (client) => {
      const inserted = await client.query<DraftRow>(
        `INSERT INTO onboarding_drafts
           (tenant_id, pack_id, trade, metro_code, metro_name, business_name, owner_first_name, client_timezone, assembled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (tenant_id) DO NOTHING
         RETURNING *`,
        [
          tenantId,
          input.packId,
          input.trade,
          input.metroCode,
          input.metroName,
          input.businessName,
          input.ownerFirstName,
          input.clientTimezone,
          JSON.stringify(input.assembled),
        ],
      );
      if (inserted.rows.length > 0) return mapRow(inserted.rows[0]);
      const existing = await client.query<DraftRow>('SELECT * FROM onboarding_drafts WHERE tenant_id = $1', [tenantId]);
      return mapRow(existing.rows[0]);
    });
  }

  async stageChoice(tenantId: string, settingKey: AnyChoiceKey, choice: StagedChoice, expectedVersion: number): Promise<OnboardingDraft> {
    const key = ChoiceKeySchema.parse(settingKey);
    const staged = StagedChoiceSchema.parse(choice);
    return this.withTenant(tenantId, async (client) => {
      const current = await client.query<Pick<DraftRow, 'status' | 'version'>>(
        'SELECT status, version FROM onboarding_drafts WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      if (current.rows.length === 0) throw new DraftNotFoundError(tenantId);
      if (current.rows[0].status === 'approved') throw new DraftAlreadyApprovedError();
      if (current.rows[0].version !== expectedVersion) {
        throw new DraftVersionConflictError(expectedVersion, current.rows[0].version);
      }
      const updated = await client.query<DraftRow>(
        `UPDATE onboarding_drafts
            SET choices = choices || jsonb_build_object($2::text, $3::jsonb),
                version = version + 1,
                updated_at = NOW()
          WHERE tenant_id = $1 AND version = $4
          RETURNING *`,
        [tenantId, key, JSON.stringify(staged), expectedVersion],
      );
      if (updated.rows.length === 0) {
        // Lost the race between the SELECT ... FOR UPDATE and the UPDATE (cannot
        // happen within one transaction, but fail closed rather than return stale state).
        throw new DraftVersionConflictError(expectedVersion, current.rows[0].version + 1);
      }
      return mapRow(updated.rows[0]);
    });
  }

  async markApproved(tenantId: string, proposalIds: string[]): Promise<OnboardingDraft> {
    return this.withTenant(tenantId, async (client) => {
      const updated = await client.query<DraftRow>(
        `UPDATE onboarding_drafts
            SET status = 'approved',
                proposal_ids = $2::jsonb,
                version = version + 1,
                approved_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1 AND status = 'draft'
          RETURNING *`,
        [tenantId, JSON.stringify(proposalIds)],
      );
      if (updated.rows.length > 0) return mapRow(updated.rows[0]);
      const existing = await client.query<DraftRow>('SELECT * FROM onboarding_drafts WHERE tenant_id = $1', [tenantId]);
      if (existing.rows.length === 0) throw new DraftNotFoundError(tenantId);
      return mapRow(existing.rows[0]);
    });
  }
}

// ─── In-memory implementation (route tests, hermetic boot) ───────────────────

export class InMemoryOnboardingDraftRepository implements OnboardingDraftRepository {
  private readonly byTenant = new Map<string, OnboardingDraft>();

  async getForTenant(tenantId: string): Promise<OnboardingDraft | null> {
    return this.byTenant.get(tenantId) ?? null;
  }

  async create(tenantId: string, input: CreateDraftRecord): Promise<OnboardingDraft> {
    const existing = this.byTenant.get(tenantId);
    if (existing) return existing;
    const now = new Date();
    const draft: OnboardingDraft = {
      id: crypto.randomUUID(),
      tenantId,
      ...input,
      choices: {},
      status: 'draft',
      version: 1,
      proposalIds: [],
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
    };
    this.byTenant.set(tenantId, draft);
    return draft;
  }

  async stageChoice(tenantId: string, settingKey: AnyChoiceKey, choice: StagedChoice, expectedVersion: number): Promise<OnboardingDraft> {
    const key = ChoiceKeySchema.parse(settingKey);
    const staged = StagedChoiceSchema.parse(choice);
    const d = this.byTenant.get(tenantId);
    if (!d) throw new DraftNotFoundError(tenantId);
    if (d.status === 'approved') throw new DraftAlreadyApprovedError();
    if (d.version !== expectedVersion) throw new DraftVersionConflictError(expectedVersion, d.version);
    const next: OnboardingDraft = { ...d, choices: { ...d.choices, [key]: staged }, version: d.version + 1, updatedAt: new Date() };
    this.byTenant.set(tenantId, next);
    return next;
  }

  async markApproved(tenantId: string, proposalIds: string[]): Promise<OnboardingDraft> {
    const d = this.byTenant.get(tenantId);
    if (!d) throw new DraftNotFoundError(tenantId);
    if (d.status === 'approved') return d;
    const next: OnboardingDraft = { ...d, status: 'approved', proposalIds: [...proposalIds], version: d.version + 1, approvedAt: new Date(), updatedAt: new Date() };
    this.byTenant.set(tenantId, next);
    return next;
  }
}
