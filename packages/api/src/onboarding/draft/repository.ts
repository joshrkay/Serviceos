/**
 * Onboarding draft repository — the pre-approval state of "pick, don't build"
 * setup. One draft per tenant: the assembled typical shop plus staged choices.
 *
 * RLS: migration 311 enables + forces RLS; PgBaseRepository.withTenant sets
 * `app.current_tenant_id`. Every query also carries an explicit tenant_id
 * predicate because RLS enforcement is a runtime flag (db/rls-runtime-role.ts).
 *
 * Concurrency (U11): every writer of onboarding_drafts is a thin caller of
 * `updateLocked`, which does the same four things in one tenant transaction, in
 * this order: (1) `SELECT ... FOR UPDATE` the tenant's draft row; (2) refuse
 * unless the row is in the status the writer requires (`draft` for a field
 * write, `approved` for the retry bump and later undo/reset/reopen), and check
 * the writer's own precondition on the locked row; (3) compare `version` with
 * the caller's `expectedVersion` when it sent one; (4) compute the change from
 * the locked row, never from an earlier read, write it and bump `version`. It is
 * the only code here that issues the table's UPDATE statement (a guard test reads
 * this file), so a PUT /choices and an approve, or two approves, serialise on
 * the draft row and a writer cannot land between proposal construction and
 * `markApproved`. Approval reads the row under the same lock
 * (`getForTenantForUpdate`) and `markApproved` re-checks the version it read as
 * the second guard; `markRetried` is the same for a later attempt (a retry), so
 * `version` names the attempt a tab rendered, not just the staged choices.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { currentTenantContext } from '../../middleware/tenant-context';
import type { AssembledShop } from '../choices/assemble';
import { ChoiceKeySchema, assertOverrideAllowedFor, type AnyChoiceKey } from '../choices/schema';
import { OwnerPhoneE164Schema } from './owner-phone';
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
export class DraftNotApprovedError extends Error {
  constructor() {
    super('onboarding draft is not approved');
    this.name = 'DraftNotApprovedError';
  }
}
/**
 * The metro cannot change once any choice is staged: a staged 'a' or 'b' names
 * an option as the owner saw it priced, and the cents behind it live in
 * `assembled`, so re-pricing under it would change the number they agreed to.
 */
export class DraftMetroLockedError extends Error {
  constructor() {
    super('onboarding draft metro is locked: a choice is already staged');
    this.name = 'DraftMetroLockedError';
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
  /** The owner's cell, E.164; null until given. Written to tenant_settings.owner_phone on approval. */
  ownerPhone: string | null;
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
  /** Canonical E.164 owner cell; omitted means none given yet. */
  ownerPhone?: string | null;
  assembled: AssembledShop;
}

/**
 * The columns a writer may change through `updateLocked`. `version` and
 * `updatedAt` are never in a patch: the helper always bumps them.
 */
export type DraftPatch = Partial<
  Pick<OnboardingDraft, 'choices' | 'clientTimezone' | 'ownerPhone' | 'metroCode' | 'metroName' | 'assembled' | 'status' | 'proposalIds' | 'approvedAt'>
>;

export interface UpdateLockedOptions {
  /** `draft` for every field write; `approved` for the retry bump, undo, reset and reopen. */
  requireStatus: DraftStatus;
  /** When sent, the locked row's `version` must equal it (DraftVersionConflictError otherwise). */
  expectedVersion?: number;
  /**
   * A writer-specific check on the locked row, run after the status check and
   * BEFORE the version compare, so a stale version is never reported as the
   * reason a write that could never apply was refused (`setMetro`: no choice
   * staged). Throws its own typed error.
   */
  precondition?: (row: OnboardingDraft) => void;
}

/** Builds the assembled shop for a new metro from the locked draft row (U1's assembleTypicalShop). */
export type AssembleForMetro = (row: OnboardingDraft) => Promise<AssembledShop>;

/** The precondition of `setMetro`: nothing staged, under any key. */
function assertMetroUnlocked(row: OnboardingDraft): void {
  if (Object.keys(row.choices).length > 0) throw new DraftMetroLockedError();
}

/** The patch `setMetro` writes: the new shop whole, with the code and name it was built for. */
async function metroPatch(row: OnboardingDraft, metroCode: string, assemble: AssembleForMetro): Promise<DraftPatch> {
  const assembled = await assemble(row);
  if (assembled.metroCode !== metroCode) {
    throw new Error(`setMetro: assembled shop is for ${String(assembled.metroCode)}, not ${metroCode}`);
  }
  return { metroCode: assembled.metroCode, metroName: assembled.metroName, assembled };
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
   * The one write path (see the file comment): lock, status + precondition,
   * version, then `compute(lockedRow)` and ONE update that applies the patch and
   * bumps `version`. `compute` may be async and may throw a typed refusal
   * before anything is written; an empty patch still bumps the version. Throws
   * DraftNotFoundError / DraftAlreadyApprovedError (requireStatus `draft` on an
   * approved row) / DraftNotApprovedError (requireStatus `approved` on a draft)
   * / the precondition's error / DraftVersionConflictError, in that order.
   */
  updateLocked(tenantId: string, opts: UpdateLockedOptions, compute: (row: OnboardingDraft) => Promise<DraftPatch> | DraftPatch): Promise<OnboardingDraft>;
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
   * Sets the owner's cell (canonical E.164; anything else is refused). Same
   * contract as stageChoice: compare-and-swap on `version`, always bumps it
   * (even for an identical value), refused once approved. Checked in that
   * order, so an approved draft always answers DraftAlreadyApprovedError.
   */
  setOwnerPhone(tenantId: string, ownerPhone: string, expectedVersion: number): Promise<OnboardingDraft>;
  /**
   * Re-prices the draft for another metro. Refused once approved
   * (DraftAlreadyApprovedError), then once ANY choice is staged
   * (DraftMetroLockedError, checked before the version because a fresh version
   * cannot make it succeed), then on a stale version (DraftVersionConflictError).
   * `assemble` builds the shop for the new metro from the LOCKED row; its result
   * is stored whole, with its metro code and name, in the one version bump, so
   * the city and the prices an approval copies always belong to one metro.
   */
  setMetro(tenantId: string, metroCode: string, expectedVersion: number, assemble: AssembleForMetro): Promise<OnboardingDraft>;
  /**
   * Marks approved and records the proposal ids, only if the draft is still
   * `draft` at `expectedVersion` (the version read under the lock). Throws
   * DraftNotFoundError / DraftAlreadyApprovedError / DraftVersionConflictError
   * and never returns a row it did not update.
   */
  markApproved(tenantId: string, proposalIds: string[], expectedVersion: number): Promise<OnboardingDraft>;
  /**
   * A successful retry opens a new approval attempt (fresh undo window), so the
   * draft's `version` moves on: bumps `version` and `updated_at` of an APPROVED
   * draft, only if it is still at `expectedVersion` (the version read under the
   * lock). Nothing else about the row changes. A tab that rendered an earlier
   * attempt then holds a stale version. Throws DraftNotFoundError /
   * DraftNotApprovedError / DraftVersionConflictError and never returns a row it
   * did not update.
   */
  markRetried(tenantId: string, expectedVersion: number): Promise<OnboardingDraft>;
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
  owner_phone: string | null;
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
    ownerPhone: row.owner_phone,
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

/** Patch field -> column, in a fixed order so the UPDATE's parameter list is deterministic. */
const PATCH_COLUMNS: Record<keyof DraftPatch, { name: string; json: boolean }> = {
  choices: { name: 'choices', json: true },
  clientTimezone: { name: 'client_timezone', json: false },
  ownerPhone: { name: 'owner_phone', json: false },
  metroCode: { name: 'metro_code', json: false },
  metroName: { name: 'metro_name', json: false },
  assembled: { name: 'assembled', json: true },
  status: { name: 'status', json: false },
  proposalIds: { name: 'proposal_ids', json: true },
  approvedAt: { name: 'approved_at', json: false },
};
const PATCH_KEYS = Object.keys(PATCH_COLUMNS) as (keyof DraftPatch)[];

/**
 * Steps 2 and 3 of `updateLocked`, shared by both repositories so the order of
 * refusals is identical: status, then the writer's precondition, then version.
 */
function assertWritable(row: OnboardingDraft, opts: UpdateLockedOptions): void {
  if (opts.requireStatus === 'draft' && row.status === 'approved') throw new DraftAlreadyApprovedError();
  if (opts.requireStatus === 'approved' && row.status !== 'approved') throw new DraftNotApprovedError();
  opts.precondition?.(row);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== row.version) {
    throw new DraftVersionConflictError(opts.expectedVersion, row.version);
  }
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
    if (currentTenantContext()?.tenantId !== tenantId) {
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
           (tenant_id, pack_id, trade, metro_code, metro_name, business_name, owner_first_name, client_timezone, assembled, owner_phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
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
          input.ownerPhone === undefined || input.ownerPhone === null ? null : OwnerPhoneE164Schema.parse(input.ownerPhone),
        ],
      );
      if (inserted.rows.length > 0) return mapRow(inserted.rows[0]);
      const existing = await client.query<DraftRow>('SELECT * FROM onboarding_drafts WHERE tenant_id = $1', [tenantId]);
      return mapRow(existing.rows[0]);
    });
  }

  async updateLocked(
    tenantId: string,
    opts: UpdateLockedOptions,
    compute: (row: OnboardingDraft) => Promise<DraftPatch> | DraftPatch,
  ): Promise<OnboardingDraft> {
    return this.withTenant(tenantId, async (client) => {
      const locked = await client.query<DraftRow>('SELECT * FROM onboarding_drafts WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
      if (locked.rows.length === 0) throw new DraftNotFoundError(tenantId);
      const row = mapRow(locked.rows[0]);
      assertWritable(row, opts);
      const patch = await compute(row);

      const sets: string[] = [];
      const params: unknown[] = [row.id, row.version, tenantId];
      for (const key of PATCH_KEYS) {
        const value = patch[key];
        if (value === undefined) continue;
        const column = PATCH_COLUMNS[key];
        params.push(column.json ? JSON.stringify(value) : value);
        sets.push(`${column.name} = $${params.length}${column.json ? '::jsonb' : ''}`);
      }
      const updated = await client.query<DraftRow>(
        `UPDATE onboarding_drafts
            SET ${[...sets, 'version = version + 1', 'updated_at = NOW()'].join(', ')}
          WHERE id = $1 AND version = $2 AND tenant_id = $3
          RETURNING *`,
        params,
      );
      if (updated.rows.length === 0) {
        // Cannot happen inside one transaction after FOR UPDATE; fail closed rather than return stale state.
        throw new DraftVersionConflictError(row.version, row.version + 1);
      }
      return mapRow(updated.rows[0]);
    });
  }

  async stageChoice(tenantId: string, settingKey: AnyChoiceKey, choice: StagedChoice, expectedVersion: number): Promise<OnboardingDraft> {
    const key = ChoiceKeySchema.parse(settingKey);
    const staged = StagedChoiceSchema.parse(choice);
    if ('override' in staged) assertOverrideAllowedFor(key, staged.override);
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion }, (row) => ({ choices: { ...row.choices, [key]: staged } }));
  }

  async setClientTimezone(tenantId: string, clientTimezone: string): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'draft' }, () => ({ clientTimezone }));
  }

  async setOwnerPhone(tenantId: string, ownerPhone: string, expectedVersion: number): Promise<OnboardingDraft> {
    const phone = OwnerPhoneE164Schema.parse(ownerPhone);
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion }, () => ({ ownerPhone: phone }));
  }

  async setMetro(tenantId: string, metroCode: string, expectedVersion: number, assemble: AssembleForMetro): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion, precondition: assertMetroUnlocked }, (row) =>
      metroPatch(row, metroCode, assemble),
    );
  }

  async markApproved(tenantId: string, proposalIds: string[], expectedVersion: number): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion }, () => ({
      status: 'approved',
      proposalIds: [...proposalIds],
      approvedAt: new Date(),
    }));
  }

  async markRetried(tenantId: string, expectedVersion: number): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'approved', expectedVersion }, () => ({}));
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
      ownerPhone: input.ownerPhone ?? null,
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

  /** Same four steps, same order of refusals; single-threaded, so the "lock" is the current entry. */
  async updateLocked(
    tenantId: string,
    opts: UpdateLockedOptions,
    compute: (row: OnboardingDraft) => Promise<DraftPatch> | DraftPatch,
  ): Promise<OnboardingDraft> {
    const row = this.byTenant.get(tenantId);
    if (!row) throw new DraftNotFoundError(tenantId);
    assertWritable(row, opts);
    const patch = await compute(row);
    // An undefined field is "not in the patch", exactly as the Pg UPDATE skips it.
    const next: OnboardingDraft = { ...row, version: row.version + 1, updatedAt: new Date() };
    for (const key of PATCH_KEYS) {
      if (patch[key] !== undefined) Object.assign(next, { [key]: patch[key] });
    }
    this.byTenant.set(tenantId, next);
    return next;
  }

  async stageChoice(tenantId: string, settingKey: AnyChoiceKey, choice: StagedChoice, expectedVersion: number): Promise<OnboardingDraft> {
    const key = ChoiceKeySchema.parse(settingKey);
    const staged = StagedChoiceSchema.parse(choice);
    if ('override' in staged) assertOverrideAllowedFor(key, staged.override);
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion }, (row) => ({ choices: { ...row.choices, [key]: staged } }));
  }

  async setClientTimezone(tenantId: string, clientTimezone: string): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'draft' }, () => ({ clientTimezone }));
  }

  async setOwnerPhone(tenantId: string, ownerPhone: string, expectedVersion: number): Promise<OnboardingDraft> {
    const phone = OwnerPhoneE164Schema.parse(ownerPhone);
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion }, () => ({ ownerPhone: phone }));
  }

  async setMetro(tenantId: string, metroCode: string, expectedVersion: number, assemble: AssembleForMetro): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion, precondition: assertMetroUnlocked }, (row) =>
      metroPatch(row, metroCode, assemble),
    );
  }

  async markApproved(tenantId: string, proposalIds: string[], expectedVersion: number): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'draft', expectedVersion }, () => ({
      status: 'approved',
      proposalIds: [...proposalIds],
      approvedAt: new Date(),
    }));
  }

  async markRetried(tenantId: string, expectedVersion: number): Promise<OnboardingDraft> {
    return this.updateLocked(tenantId, { requireStatus: 'approved', expectedVersion }, () => ({}));
  }
}
