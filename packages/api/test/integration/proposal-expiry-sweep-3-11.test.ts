/**
 * Docker-gated integration test — PRD v5 §8.3 row 3.11, "stale schedule
 * proposals expire", at real Postgres.
 *
 * ROW CRITERION: "Given an unactioned schedule proposal, when the TTL passes,
 * then it expires and can be re-proposed."
 *
 * THE ROW'S OPEN QUESTION ("two TTL regimes coexist"). There are two TTL
 * implementations in the tree and they disagree (48 h vs 24 h/4 h). This file
 * settles which one is live by proving BOTH halves:
 *
 *  1. BEHAVIOURAL — the worker's 48 h regime really expires a stale schedule
 *     proposal at real Postgres, through the PRODUCTION tenant selector
 *     (`listAllTenantIds`, src/tenants/list-tenant-ids.ts:19 — the exact
 *     function app.ts:6490 passes to the sweep), writing the status change and
 *     its `proposal.expired` audit event.
 *  2. STRUCTURAL — `src/ai/guardrails/expiration.ts`, which holds the 24 h
 *     default / 4 h `create_appointment` regime
 *     (DEFAULT_EXPIRATION_CONFIG, lines 11-17), has ZERO importers anywhere
 *     under `src/`. Its only importer in the repo is its own unit test
 *     (`test/ai/guardrails-expiration.test.ts:8`). The scanner that proves
 *     this carries a NEGATIVE CONTROL: the same scan run against
 *     `workers/proposal-expiry-worker` — a module that IS imported by app.ts —
 *     must find importers, so a scan that can only ever return "none" cannot
 *     pass for a proof.
 *
 * Conclusion the tests support: the live TTL is the worker's 48 h
 * (`SCHEDULE_PROPOSAL_EXPIRY_MS`, src/proposals/proposal.ts:109, applied at
 * creation by `defaultProposalExpiry`, line 120). The guardrail module is dead
 * code, not a second live regime. This lane RECOMMENDS, it does not delete —
 * see the lane report.
 *
 * Run: cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *   --config vitest.integration.config.ts --reporter=verbose \
 *   test/integration/proposal-expiry-sweep-3-11.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { listAllTenantIds } from '../../src/tenants/list-tenant-ids';
import { runProposalExpirySweep } from '../../src/workers/proposal-expiry-worker';
import {
  createProposal,
  defaultProposalExpiry,
  Proposal,
  ProposalType,
  SCHEDULE_PROPOSAL_EXPIRY_MS,
} from '../../src/proposals/proposal';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const HOUR_MS = 60 * 60 * 1000;

/** Every .ts file under packages/api/src. */
function srcFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      srcFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Files under `src/` whose import/export/require specifier resolves to
 * `moduleSuffix` (e.g. 'ai/guardrails/expiration'). Matches both the absolute
 * tail ('../ai/guardrails/expiration') and the same-directory spelling
 * ('./expiration' from inside ai/guardrails), so a relative importer cannot
 * hide from the scan.
 */
function runtimeImportersOf(moduleSuffix: string): string[] {
  const srcRoot = resolve(__dirname, '../../src');
  const basename = moduleSuffix.split('/').pop() as string;
  const dirOfModule = resolve(srcRoot, moduleSuffix, '..');
  const specifier = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
  const hits: string[] = [];

  for (const file of srcFiles(srcRoot)) {
    if (file === resolve(srcRoot, `${moduleSuffix}.ts`)) continue; // the module itself
    const text = readFileSync(file, 'utf8');
    specifier.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = specifier.exec(text)) !== null) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      if (!spec.endsWith(`/${basename}`) && !spec.endsWith(basename)) continue;
      const resolved = resolve(file, '..', spec);
      if (resolved === resolve(dirOfModule, basename)) {
        hits.push(file.slice(srcRoot.length + 1));
        break;
      }
    }
  }
  return hits;
}

describe('Postgres integration — §8.3 row 3.11 stale schedule proposals expire', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  /** Persist a proposal with an explicit age + expiry, in a pending status. */
  async function seedProposal(
    tenant: TestTenant,
    type: ProposalType,
    opts: { ageHours: number; expiresAt?: Date | null },
  ): Promise<Proposal> {
    const createdAt = new Date(Date.now() - opts.ageHours * HOUR_MS);
    const base = createProposal({
      tenantId: tenant.tenantId,
      proposalType: type,
      payload: { note: 'row 3.11 fixture' },
      summary: `${type} fixture`,
      createdBy: tenant.userId,
    });
    const expiresAt =
      opts.expiresAt === undefined ? defaultProposalExpiry(type, createdAt) : opts.expiresAt;
    return proposalRepo.create({
      ...base,
      status: 'ready_for_review',
      createdAt,
      updatedAt: createdAt,
      ...(expiresAt ? { expiresAt } : { expiresAt: undefined }),
    });
  }

  async function sweep(): Promise<{ tenants: number; expired: number; failed: number }> {
    return runProposalExpirySweep({
      proposalRepo,
      auditRepo,
      // The PRODUCTION selector app.ts:6490 passes — not a hand-picked list.
      listTenantIds: () => listAllTenantIds(pool),
      logger,
    });
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('CURRENT: the live TTL applied at creation is the worker`s 48 h, not the guardrail`s 4 h for create_appointment', () => {
    const now = new Date('2026-09-12T12:00:00Z');
    const expiry = defaultProposalExpiry('create_appointment', now);
    expect(expiry?.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(SCHEDULE_PROPOSAL_EXPIRY_MS).toBe(48 * HOUR_MS);
    // A non-schedule type carries no expiry at all — it is invisible to the sweep.
    expect(defaultProposalExpiry('draft_estimate', now)).toBeUndefined();
  });

  it('CURRENT: an unactioned schedule proposal past 48 h expires at real Postgres, with its proposal.expired audit row; a same-tenant non-schedule proposal of the same age is untouched', async () => {
    const stale = await seedProposal(tenantA, 'create_appointment', { ageHours: 50 });
    const noTtl = await seedProposal(tenantA, 'draft_estimate', { ageHours: 50 });
    expect(stale.expiresAt!.getTime()).toBeLessThan(Date.now());
    expect(noTtl.expiresAt).toBeUndefined();

    const outcome = await sweep();
    expect(outcome.failed).toBe(0);
    expect(outcome.expired).toBeGreaterThanOrEqual(1);

    const afterStale = await proposalRepo.findById(tenantA.tenantId, stale.id);
    expect(afterStale?.status).toBe('expired');

    const afterNoTtl = await proposalRepo.findById(tenantA.tenantId, noTtl.id);
    expect(afterNoTtl?.status).toBe('ready_for_review');

    const events = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', stale.id);
    expect(events.map((e) => e.eventType)).toContain('proposal.expired');
    const expiredEvent = events.find((e) => e.eventType === 'proposal.expired')!;
    expect(expiredEvent.actorId).toBe('proposal-expiry-worker');
    expect(expiredEvent.actorRole).toBe('system');
    expect(expiredEvent.metadata).toMatchObject({ proposalType: 'create_appointment' });
    // No audit row is written for the proposal the sweep left alone.
    const noTtlEvents = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', noTtl.id);
    expect(noTtlEvents.map((e) => e.eventType)).not.toContain('proposal.expired');
  });

  it('CURRENT (T2): a neighbour tenant`s FRESH schedule proposal is untouched by the same sweep pass that expires tenant A`s stale one', async () => {
    const staleA = await seedProposal(tenantA, 'reschedule_appointment', { ageHours: 72 });
    const freshB = await seedProposal(tenantB, 'create_appointment', { ageHours: 1 });
    expect(freshB.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    const outcome = await sweep();
    // The production selector saw both tenants in one pass.
    expect(outcome.tenants).toBeGreaterThanOrEqual(2);
    expect(outcome.failed).toBe(0);

    expect((await proposalRepo.findById(tenantA.tenantId, staleA.id))?.status).toBe('expired');
    expect((await proposalRepo.findById(tenantB.tenantId, freshB.id))?.status).toBe(
      'ready_for_review',
    );
    const bEvents = await auditRepo.findByEntity(tenantB.tenantId, 'proposal', freshB.id);
    expect(bEvents).toHaveLength(0);
    // Tenant A's expiry audit row is not visible to the neighbour tenant.
    const crossTenant = await auditRepo.findByEntity(tenantB.tenantId, 'proposal', staleA.id);
    expect(crossTenant).toHaveLength(0);
  });

  it('CURRENT: after expiry the operator can re-propose — a fresh schedule proposal for the same tenant carries a new 48 h window and survives the next sweep', async () => {
    const stale = await seedProposal(tenantA, 'create_appointment', { ageHours: 60 });
    await sweep();
    expect((await proposalRepo.findById(tenantA.tenantId, stale.id))?.status).toBe('expired');

    const reproposed = await seedProposal(tenantA, 'create_appointment', { ageHours: 0 });
    expect(reproposed.id).not.toBe(stale.id);
    expect(reproposed.expiresAt!.getTime() - reproposed.createdAt.getTime()).toBe(
      SCHEDULE_PROPOSAL_EXPIRY_MS,
    );

    await sweep();
    expect((await proposalRepo.findById(tenantA.tenantId, reproposed.id))?.status).toBe(
      'ready_for_review',
    );
    // The already-expired card stays terminal — the sweep does not re-expire it
    // or write a second audit row.
    const events = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', stale.id);
    expect(events.filter((e) => e.eventType === 'proposal.expired')).toHaveLength(1);
  });

  it('STRUCTURAL: ai/guardrails/expiration.ts has NO runtime importer under src/ — negative control: the same scan finds importers of workers/proposal-expiry-worker', () => {
    // Negative control FIRST: a scanner that can only ever return [] proves
    // nothing, so show it finds the module app.ts really does import.
    const control = runtimeImportersOf('workers/proposal-expiry-worker');
    expect(control).toContain('app.ts');
    expect(control.length).toBeGreaterThan(0);

    // The claim under test.
    expect(runtimeImportersOf('ai/guardrails/expiration')).toEqual([]);
  });

  /**
   * THE ROW'S GAP. The PRD's "two TTL regimes coexist" is true as source but
   * false as behaviour: only the 48 h regime runs. What remains is an unwired
   * module whose numbers contradict the live ones, which is exactly the state
   * §8.0's CODE-ONLY class exists to describe — a reader of
   * `ai/guardrails/expiration.ts` would conclude `create_appointment` cards
   * die after 4 h. The desired end state is ONE regime in the tree.
   *
   * Whether that means deleting the guardrail module or wiring it in place of
   * the worker's is Josh's call — this lane recommends, it does not delete.
   */
  it.fails(
    'DESIRED (row 3.11): exactly ONE proposal-TTL regime exists in the tree — src/ai/guardrails/expiration.ts is either wired or gone, so no reader can mistake its 24 h/4 h numbers for live behaviour',
    () => {
      const importers = runtimeImportersOf('ai/guardrails/expiration');
      const moduleExists = (() => {
        try {
          statSync(resolve(__dirname, '../../src/ai/guardrails/expiration.ts'));
          return true;
        } catch {
          return false;
        }
      })();
      expect(moduleExists && importers.length === 0).toBe(false);
    },
  );
});
