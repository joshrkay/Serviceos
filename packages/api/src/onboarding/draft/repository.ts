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
 * and re-reads. Approval takes the row lock first (`getForTenantForUpdate`), so
 * a PUT /choices and an approve, or two approves, serialise on the draft row;
 * `markApproved` is the second guard: a compare-and-swap on the version read
 * under that lock, which never returns a row it did not update.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { tenantContextStore } from '../../middleware/tenant-context';
import type { AssembledShop } from '../choices/assemble';
import { ChoiceKeySchema, assertOverrideAllowedFor, type AnyChoiceKey } from '../choices/schema';
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
  /**
   * `SELECT ... FOR UPDATE`: reads the draft and locks its row until the
   * surrounding transaction ends, so it is only meaningful inside the /api
   * request transaction (the Pg implementation refuses to run outside one).
   * Routes that bypass that transaction (SSE, LLM long-call) and workers must
   * not call it. Used by approve, and by later undo/retry paths.
   */
  getForTenantForUpdate(tenantId: string): Promise<OnboardingDraft | null>;
  /** Creates the tenant's draft, or returns the existing one unchanged. */
  create(tenantId: string, input: CreateDraftRecord): Promise<OnboardingDraft>;
  /**
   * Overrides must carry only writes the choice owns (and prices only on the
   * price choice); a violation throws WritesNotAllowedError before any write.
   */
  stageChoice(tenantId: string, settingKey: AnyChoiceKey, choice: StagedChoice, expectedVersion: number): Promise<OnboardingDraft>;
  /**
   * Records the browser timezone on an existing draft (the create call may
   * have run before the client knew its zone). Bumps `version`; refused once approved.
   */
  setClientTimezone(tenantId: string, clientTimezone: string): Promise<OnboardingDraft>;
  /**
   * Marks approved and records the proposal ids, only if the draft is still
   * `draft` at `expectedVersion` (the version read under the lock). Throws
   * DraftNotFoundError / DraftAlreadyApprovedError / DraftVersionConflictError
   * and never returns a row it did not update.
   */
  markApproved(tenantId: string, proposalIds: string[], expectedVersion: number): Promise<OnboardingDraft>;
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

  async getForTenantForUpdate(tenantId: string): Promise<OnboardingDraft | null> {
    if (tenantContextStore.getStore()?.tenantId !== tenantId) {
      throw new Error('getForTenantForUpdate requires the request transaction: a row lock taken outside it is released immediately');
    }
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query<DraftRow>('SELECT * FROM onboarding_drafts WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
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
    if ('override' in staged) assertOverrideAllowedFor(key, staged.override);
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

  async setClientTimezone(tenantId: string, clientTimezone: string): Promise<OnboardingDraft> {
    return this.withTenant(tenantId, async (client) => {
      const current = await client.query<Pick<DraftRow, 'status'>>(
        'SELECT status FROM onboarding_drafts WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      if (current.rows.length === 0) throw new DraftNotFoundError(tenantId);
      if (current.rows[0].status === 'approved') throw new DraftAlreadyApprovedError();
      const updated = await client.query<DraftRow>(
        `UPDATE onboarding_drafts
            SET client_timezone = $2,
                version = version + 1,
                updated_at = NOW()
          WHERE tenant_id = $1
          RETURNING *`,
        [tenantId, clientTimezone],
      );
      return mapRow(updated.rows[0]);
    });
  }

  async markApproved(tenantId: string, proposalIds: string[], expectedVersion: number): Promise<OnboardingDraft> {
    return this.withTenant(tenantId, async (client) => {
      const updated = await client.query<DraftRow>(
        `UPDATE onboarding_drafts
            SET status = 'approved',
                proposal_ids = $2::jsonb,
                version = version + 1,
                approved_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1 AND status = 'draft' AND version = $3
          RETURNING *`,
        [tenantId, JSON.stringify(proposalIds), expectedVersion],
      );
      if (updated.rows.length > 0) return mapRow(updated.rows[0]);
      // Zero rows: say why, but never hand back a row this call did not update.
      const existing = await client.query<Pick<DraftRow, 'status' | 'version'>>(
        'SELECT status, version FROM onboarding_drafts WHERE tenant_id = $1',
        [tenantId],
      );
      if (existing.rows.length === 0) throw new DraftNotFoundError(tenantId);
      if (existing.rows[0].status === 'approved') throw new DraftAlreadyApprovedError();
      throw new DraftVersionConflictError(expectedVersion, existing.rows[0].version);
    });
  }
}

// ─── In-memory implementation (route tests, hermetic boot) ───────────────────

export class InMemoryOnboardingDraftRepository implements OnboardingDraftRepository {
  private readonly byTenant = new Map<string, OnboardingDraft>();

  async getForTenant(tenantId: string): Promise<OnboardingDraft | null> {
    return this.byTenant.get(tenantId) ?? null;
  }

  /** Plain read: in-memory callers are single-threaded, so there is nothing to lock. */
  async getForTenantForUpdate(tenantId: string): Promise<OnboardingDraft | null> {
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
    if ('override' in staged) assertOverrideAllowedFor(key, staged.override);
    const d = this.byTenant.get(tenantId);
    if (!d) throw new DraftNotFoundError(tenantId);
    if (d.status === 'approved') throw new DraftAlreadyApprovedError();
    if (d.version !== expectedVersion) throw new DraftVersionConflictError(expectedVersion, d.version);
    const next: OnboardingDraft = { ...d, choices: { ...d.choices, [key]: staged }, version: d.version + 1, updatedAt: new Date() };
    this.byTenant.set(tenantId, next);
    return next;
  }

  async setClientTimezone(tenantId: string, clientTimezone: string): Promise<OnboardingDraft> {
    const d = this.byTenant.get(tenantId);
    if (!d) throw new DraftNotFoundError(tenantId);
    if (d.status === 'approved') throw new DraftAlreadyApprovedError();
    const next: OnboardingDraft = { ...d, clientTimezone, version: d.version + 1, updatedAt: new Date() };
    this.byTenant.set(tenantId, next);
    return next;
  }

  async markApproved(tenantId: string, proposalIds: string[], expectedVersion: number): Promise<OnboardingDraft> {
    const d = this.byTenant.get(tenantId);
    if (!d) throw new DraftNotFoundError(tenantId);
    if (d.status === 'approved') throw new DraftAlreadyApprovedError();
    if (d.version !== expectedVersion) throw new DraftVersionConflictError(expectedVersion, d.version);
    const next: OnboardingDraft = { ...d, status: 'approved', proposalIds: [...proposalIds], version: d.version + 1, approvedAt: new Date(), updatedAt: new Date() };
    this.byTenant.set(tenantId, next);
    return next;
  }
}
