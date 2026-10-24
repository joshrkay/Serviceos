/**
 * Raw `pg` access vs. RLS (STRUCTURAL) — raw-pg audit 2026-10-23, §3.
 *
 * ## Why this guard exists
 *
 * The app connects to Postgres as a privileged principal, so RLS is a runtime
 * no-op except on a client that went through `applyTenantContext` (the
 * PgBaseRepository `withTenant`/`withTenantTransaction` family,
 * `withTenantSession`, `withTenantConnection`/`withTenantClient`, `tenantQuery`,
 * `runInTenantTransaction`, and the request middleware). `RLS_RUNTIME_ROLE=true`
 * is a hard prod requirement, and `db/rls-runtime-role.ts` says that with it "a
 * forgotten tenant_id filter can no longer cross tenants". That holds only on
 * those paths. Every `pool.query`, raw `pool.connect`, `withClient`, `?? pool`
 * fallback and hand-set GUC is an exception where isolation is whatever the
 * SQL remembered to write.
 *
 * The audit classified every such site and found no leak — but nothing stopped
 * the next one. This guard freezes the surface: every raw access must match a
 * reviewed entry in `raw-pool-rls.allowlist.ts`, keyed by (file, function,
 * access) with an EXACT count, and the entry's category is checked against the
 * schema rather than trusted.
 *
 * ## The rules
 *
 * 1. No unlisted site. The sanctioned context helpers are keyed the same way
 *    (file, function, access, count), so a second raw function in their file
 *    is unlisted too.
 * 2. Exact counts — a second statement in a listed function fails.
 * 3. No stale entries — a migrated site's entry must be deleted, so the list
 *    stays equal to the remaining work (the outbound-messaging ratchet).
 * 4. `tenant_filtered_no_rls` is frozen debt: a ceiling equal to today's count,
 *    and every such entry names the audit item that migrates it.
 * 5. Categories are checked: the tables in the function's SQL must be a subset
 *    of the entry's `tables`, and SQL whose tables cannot be read (a
 *    substituted table name, SQL text that is not wholly literal: a
 *    parameter, `sql + ' LIMIT 1'`, a call that builds it) must be declared
 *    `dynamicSql`; `global_table` may name no FORCE-RLS table (and a
 *    tenant_id table only if RLS-exempt); every other category must name at
 *    least one FORCE-RLS table; `guc-only` is allowed only for pre-tenant or
 *    platform-constant entries, or with a `migrateBy`.
 * 6. R-order: a checkout — or a callback run on one (`withClient`,
 *    `checkout-callback`) — claimed as `tenant_context_applied` (or
 *    `cross_tenant_intentional`) must hand the client to a context helper
 *    before its first effect query — SQL a named function runs on the client
 *    before then counts, and a function whose body the scan cannot read
 *    counts (it fails closed). A cross-tenant checkout still on the principal
 *    is tracked debt (`migrateBy`).
 * 7. Handoffs: every function a checkout or a helper callback hands its client
 *    to, every function THAT one hands it to (`runSteps > tryConsumeOn`), every
 *    closure over it that is passed, returned or stored (`<closure>`), and
 *    every other escape is named in the entry's `handsOffTo`, exactly.
 *    A function that hands its principal checkout to a callback its CALLER
 *    supplies is a raw-checkout helper, and every call to it is a site of its
 *    own (`checkout-callback`), listed like a `withClient` call.
 * 8. A Pool that reaches SQL through a type the typed rule cannot classify (an
 *    `as unknown as` cast, a structurally typed `{ query }` / `ClientBase`
 *    parameter or a property path on one, queried as `db.query`,
 *    `db['query']`, `db[K]` or through `.call` / `.apply` / `.bind`) is a
 *    `pool-escape` site, listed like any other; a `pool.on('connect', …)`
 *    listener (`pool['on']`, `pool[K]`, `(pool.on)`, `pool.on!` too) is a
 *    `checkout-callback` site.
 * 9. Meta: reasons ≥ 40 chars, enums, real table names, unique keys.
 *
 * `indirect` (`.bind`, assignment, destructuring, a pg member or raw-checkout
 * helper taken by reference) and `any-receiver` accesses are never
 * allowlistable.
 *
 * Evidence class: STRUCTURAL. The negative controls plant each evasion the
 * audit names into a temp tree with real `@types/pg` and show the guard
 * failing on it — and show the one compliant checkout (context first) passing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { getMigrationSQL } from '../../src/db/schema';
import { RLS_EXEMPT_TABLES_SHARED } from '../fixtures/rls-exempt-tables';
import { listSourceFiles, plantTree, removeTree } from '../support/structural-scan';
import {
  DEFAULT_GUC_NAMES,
  findPgAccess,
  loadBuildProgramInputs,
  plantProgramInputs,
  sqlTables,
  type PgAccessSite,
} from '../support/pg-access-scan';
import {
  RAW_PG_ACCESS_KINDS,
  RAW_PG_CATEGORIES,
  RAW_PG_SITES,
  SANCTIONED_HELPERS,
  TABLES_WITHOUT_MIGRATION,
  TFNR_CEILING,
  type RawPgSite,
  type SanctionedHelper,
} from './raw-pool-rls.allowlist';

const API_DIR = path.resolve(__dirname, '../..');
/** Catalog relations a site may read that no migration creates. */
const CATALOG_TABLES = ['information_schema.columns'];

// ─── Schema census ──────────────────────────────────────────────────────────

interface Census {
  /** Tables with FORCE ROW LEVEL SECURITY in db/schema.ts. */
  readonly forced: ReadonlySet<string>;
  /** Tables whose CREATE TABLE body declares a tenant_id column. */
  readonly tenantScoped: ReadonlySet<string>;
  /** Every table name a site may legitimately name. */
  readonly known: ReadonlySet<string>;
  /** GUC names the RLS policies read (`current_setting('app.<name>'`). */
  readonly policyGucs: ReadonlySet<string>;
}

function buildCensus(): Census {
  const sql = getMigrationSQL();
  const forced = new Set<string>();
  for (const m of sql.matchAll(/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+FORCE ROW LEVEL SECURITY/gi)) forced.add(m[1]);
  const tenantScoped = new Set<string>();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([^;]*?)\);/gi)) {
    if (/\btenant_id\b/.test(m[2])) tenantScoped.add(m[1]);
  }
  // Every CREATE TABLE in src: the migrations, plus the tables a module
  // bootstraps itself (the queue and feature-flag ensureTable DDL).
  const known = new Set<string>([...CATALOG_TABLES, ...TABLES_WITHOUT_MIGRATION.map((t) => t.table)]);
  const createRe = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  for (const m of sql.matchAll(createRe)) known.add(m[1]);
  for (const f of listSourceFiles([path.join(API_DIR, 'src')])) {
    for (const m of f.code.matchAll(createRe)) known.add(m[1]);
  }
  const policyGucs = new Set<string>();
  for (const m of sql.matchAll(/current_setting\('app\.([a-z_]+)'/g)) policyGucs.add(m[1]);
  return { forced, tenantScoped, known, policyGucs };
}

// ─── Evaluation (pure: sites + entries → problems) ──────────────────────────

const keyOf = (s: { file: string; fn: string; access: string }): string => `${s.file} :: ${s.fn} :: ${s.access}`;
const cite = (s: PgAccessSite): string => `${s.file}:${s.line} [${s.access}] ${s.fn} — ${s.snippet}`;

interface Report {
  readonly forbidden: string[];
  readonly unlisted: string[];
  readonly counts: string[];
  readonly stale: string[];
  readonly tables: string[];
  readonly categories: string[];
  readonly order: string[];
  readonly handoffs: string[];
}

/** Access kinds whose sites carry R-order (a checkout, or a callback run on one). */
const ORDERED_ACCESS = new Set<string>(['pool.connect', 'withClient', 'checkout-callback']);

function evaluate(
  sites: readonly PgAccessSite[],
  entries: readonly RawPgSite[],
  census: Census,
  helpers: readonly SanctionedHelper[] = SANCTIONED_HELPERS,
): Report {
  const report: Report = {
    forbidden: [], unlisted: [], counts: [], stale: [], tables: [], categories: [], order: [], handoffs: [],
  };

  const groups = new Map<string, PgAccessSite[]>();
  for (const s of sites) {
    if (s.access === 'indirect' || s.access === 'any-receiver') {
      report.forbidden.push(cite(s));
      continue;
    }
    const k = keyOf(s);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const byKey = new Map(entries.map((e) => [keyOf(e), e]));
  const sanctionedByKey = new Map(helpers.map((h) => [keyOf(h), h]));

  for (const [k, group] of groups) {
    if (!byKey.has(k) && !sanctionedByKey.has(k)) report.unlisted.push(...group.map(cite));
  }

  const checkCount = (k: string, group: readonly PgAccessSite[], count: number): void => {
    if (group.length !== count) {
      report.counts.push(`${k}: entry says ${count}, found ${group.length} at lines ${group.map((s) => s.line).join(', ')}`);
    }
  };
  const checkHandoffs = (k: string, group: readonly PgAccessSite[], listed: readonly string[] = []): void => {
    const found = new Set(group.flatMap((s) => s.handoffs ?? []));
    for (const h of [...found].sort()) {
      if (!listed.includes(h)) report.handoffs.push(`${k}: hands the client to ${h}, which handsOffTo does not name`);
    }
    for (const h of listed) {
      if (!found.has(h)) report.handoffs.push(`${k}: handsOffTo names ${h}, which no longer receives the client`);
    }
  };

  // Sanctioned context helpers: keyed and counted like entries; exempt only
  // from the tables/category checks.
  for (const h of helpers) {
    const k = keyOf(h);
    const group = groups.get(k) ?? [];
    if (group.length === 0) {
      report.stale.push(`${k} — sanctioned helper with no such site any more; delete it`);
      continue;
    }
    checkCount(k, group, h.count);
    checkHandoffs(k, group, h.handsOffTo);
    if (h.contextFirst) {
      for (const s of group) {
        if (!s.order?.contextFirst) report.order.push(`${cite(s)}: sanctioned context helper no longer applies context before its first query`);
      }
    }
  }

  for (const entry of entries) {
    const k = keyOf(entry);
    const group = groups.get(k) ?? [];
    if (group.length === 0) {
      report.stale.push(`${k} — no such site any more; delete the entry (and lower TFNR_CEILING if it was one)`);
      continue;
    }
    checkCount(k, group, entry.count);
    checkHandoffs(k, group, entry.handsOffTo);

    // Tables: what the function's SQL touches must already be reviewed.
    const found = sqlTables(group.flatMap((s) => s.sql), census.known);
    const extra = found.filter((t) => !entry.tables.includes(t));
    if (extra.length) report.tables.push(`${k}: SQL touches ${extra.join(', ')} not in entry.tables [${entry.tables.join(', ')}]`);
    const dynamic = group.some((s) => s.dynamicSql);
    const opaque = group.some((s) => s.opaqueSql);
    if (opaque && !entry.dynamicSql) {
      report.tables.push(`${k}: runs SQL that is not a literal (caller-supplied or built), so its tables cannot be read; the entry must set dynamicSql`);
    } else if (dynamic && !entry.dynamicSql) {
      report.tables.push(`${k}: SQL names its table through a substitution; the entry must set dynamicSql`);
    }
    if (!dynamic && !opaque && entry.dynamicSql) {
      report.tables.push(`${k}: entry sets dynamicSql but no SQL here builds a table name or is non-literal`);
    }

    // Category claims, against the census.
    const rls = entry.tables.filter((t) => census.forced.has(t));
    if (entry.category === 'global_table') {
      if (rls.length) report.categories.push(`${k}: global_table names FORCE-RLS table(s) ${rls.join(', ')}`);
      const unexempt = entry.tables.filter((t) => census.tenantScoped.has(t) && !RLS_EXEMPT_TABLES_SHARED.has(t));
      if (unexempt.length) report.categories.push(`${k}: global_table names tenant_id table(s) ${unexempt.join(', ')} that are not RLS-exempt`);
    } else if (!entry.dynamicSql && entry.access !== 'guc-only' && rls.length === 0) {
      // Exempt: dynamic SQL (its tables are only known at runtime) and a GUC
      // literal (it scopes the statements its checkout entry lists).
      report.categories.push(`${k}: ${entry.category} must name at least one FORCE-RLS table (otherwise it is global_table)`);
    }
    if (entry.category === 'tenant_filtered_no_rls' && !entry.migrateBy) {
      report.categories.push(`${k}: tenant_filtered_no_rls needs migrateBy (the audit item that migrates it)`);
    }
    if (
      entry.access === 'guc-only' &&
      entry.category !== 'pre_tenant_lookup' &&
      entry.category !== 'platform_constant_exception' &&
      !entry.migrateBy
    ) {
      report.categories.push(`${k}: a guc-only entry is allowed only as pre_tenant_lookup / platform_constant_exception, or with migrateBy`);
    }

    // R-order: a checkout (or a callback run on one) that claims context must
    // apply it before its first effect.
    if (ORDERED_ACCESS.has(entry.access)) {
      for (const s of group) {
        const o = s.order;
        if (!o || o.contextFirst) continue;
        const what = entry.access === 'pool.connect' ? 'checked-out client' : "callback's client";
        const why = o.clientVar === null
          ? `the ${what} is not bound to a variable the guard can follow`
          : `first effect ${o.firstEffect ? `at :${o.firstEffect.line} (${o.firstEffect.sql})` : '(none)'} with no context helper before it`;
        if (entry.category === 'tenant_context_applied') {
          report.order.push(`${cite(s)}: claims tenant_context_applied but ${why}`);
        } else if (entry.category === 'cross_tenant_intentional' && !entry.migrateBy) {
          report.order.push(`${cite(s)}: cross-tenant checkout on the principal (${why}); apply applyCrossTenantRole first, or name the attribution item in migrateBy`);
        }
      }
    }
  }
  return report;
}

function format(lines: readonly string[], advice: string): string {
  return lines.length ? `${advice}\n  ${lines.join('\n  ')}` : advice;
}

// ─── The guard over the real tree ───────────────────────────────────────────

let census: Census;
let sites: PgAccessSite[];
let report: Report;
let scanMs = 0;

beforeAll(() => {
  const t0 = Date.now();
  census = buildCensus();
  const { rootNames, compilerOptions } = loadBuildProgramInputs(API_DIR);
  sites = findPgAccess(rootNames, compilerOptions, { baseDir: API_DIR });
  report = evaluate(sites, RAW_PG_SITES, census);
  scanMs = Date.now() - t0;
}, 180_000);

describe('raw pg access vs. RLS (STRUCTURAL) — the reviewed allowlist', () => {
  it('scans the production build program (not vacuous)', () => {
    expect(sites.length).toBeGreaterThan(100);
    expect(census.forced.size).toBeGreaterThan(100);
    // Recorded for the lane report: building the ~1.3k-file Program dominates.
    expect(scanMs).toBeGreaterThan(0);
  });

  it('no raw pg access is indirect or on an any-typed receiver', () => {
    expect(
      report.forbidden,
      format(report.forbidden, 'A pg query/connect is referenced without being called (bind, assignment, destructuring) or on an `any` receiver, which the typed rules cannot follow. Call it directly on a typed Pool/client.'),
    ).toEqual([]);
  });

  it('every raw access matches a reviewed entry (file, function, access)', () => {
    expect(
      report.unlisted,
      format(
        report.unlisted,
        'Raw pg access with no reviewed entry. New tenant-scoped code must go through PgBaseRepository.withTenant/withTenantTransaction, withTenantClient/withTenantConnection or withTenantSession (see docs/solutions/architecture-patterns/raw-pg-rls-structural-guard.md). If it genuinely cannot, add a reviewed entry to test/invariants/raw-pool-rls.allowlist.ts.',
      ),
    ).toEqual([]);
  });

  it('each entry appears exactly `count` times (a new statement in a listed function fails)', () => {
    expect(report.counts, format(report.counts, 'Count mismatch: review the new/removed statement and update the entry.')).toEqual([]);
  });

  it('no stale entries (a migrated site leaves the list)', () => {
    expect(report.stale, format(report.stale, 'Entries with no matching site:')).toEqual([]);
  });

  it('the tables a function touches are a subset of its entry, and dynamic SQL is declared', () => {
    expect(report.tables, format(report.tables, 'Table drift: re-review the entry.')).toEqual([]);
  });

  it('category claims hold against the FORCE-RLS census of db/schema.ts', () => {
    expect(report.categories, format(report.categories, 'Category claim contradicted by the schema:')).toEqual([]);
  });

  it('R-order: a checkout that claims context hands the client to a context helper before its first effect', () => {
    expect(report.order, format(report.order, 'Checkout ordering:')).toEqual([]);
  });

  it('every function a checkout or helper callback hands its client to is named in handsOffTo, exactly', () => {
    expect(
      report.handoffs,
      format(report.handoffs, 'Handoff drift: review what the new callee runs on the principal client, then list it (or delete the stale name).'),
    ).toEqual([]);
  });

  it('tenant_filtered_no_rls is frozen debt: the count equals TFNR_CEILING and each names its migration', () => {
    const tfnr = RAW_PG_SITES.filter((e) => e.category === 'tenant_filtered_no_rls');
    expect(
      tfnr.length,
      `tenant_filtered_no_rls entries: ${tfnr.length}, TFNR_CEILING: ${TFNR_CEILING}. Migrated one? Lower TFNR_CEILING. Adding one means raising it, in review.`,
    ).toBe(TFNR_CEILING);
    expect(tfnr.filter((e) => !e.migrateBy).map(keyOf)).toEqual([]);
  });
});

describe('raw pg access vs. RLS (STRUCTURAL) — the allowlist itself', () => {
  it('entries are reasoned, use the enums, name real tables and are unique', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const e of RAW_PG_SITES) {
      const k = keyOf(e);
      if (seen.has(k)) problems.push(`${k}: duplicate key`);
      seen.add(k);
      if (e.why.length < 40) problems.push(`${k}: why is shorter than 40 chars`);
      if (!RAW_PG_CATEGORIES.includes(e.category)) problems.push(`${k}: unknown category ${e.category}`);
      if (!RAW_PG_ACCESS_KINDS.includes(e.access)) problems.push(`${k}: unknown access ${e.access}`);
      if (!Number.isInteger(e.count) || e.count < 1) problems.push(`${k}: count must be a positive integer`);
      if (!/^src\/.+\.ts$/.test(e.file)) problems.push(`${k}: file must be src-relative`);
      for (const t of e.tables) if (!census.known.has(t)) problems.push(`${k}: '${t}' is not a CREATE TABLE name`);
      if (e.dynamicSql && !/dynamic/i.test(e.why)) problems.push(`${k}: a dynamicSql entry's why must say the SQL is dynamic`);
      if (e.migrateBy !== undefined && !/^audit 2026-10-23 §\d/.test(e.migrateBy) && !/^#\d+/.test(e.migrateBy)) {
        problems.push(`${k}: migrateBy must name the audit item or an issue`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('sanctioned helpers are reasoned, keyed like entries, and never also listed', () => {
    const problems: string[] = [];
    const listed = new Set(RAW_PG_SITES.map(keyOf));
    const seen = new Set<string>();
    for (const h of SANCTIONED_HELPERS) {
      const k = keyOf(h);
      if (seen.has(k)) problems.push(`${k}: duplicate sanctioned key`);
      seen.add(k);
      if (listed.has(k)) problems.push(`${k}: both sanctioned and listed`);
      if (h.why.length < 40) problems.push(`${k}: why is shorter than 40 chars`);
      if (!RAW_PG_ACCESS_KINDS.includes(h.access)) problems.push(`${k}: unknown access ${h.access}`);
      if (!Number.isInteger(h.count) || h.count < 1) problems.push(`${k}: count must be a positive integer`);
      if (h.contextFirst && h.access !== 'pool.connect') problems.push(`${k}: contextFirst applies to a checkout only`);
    }
    // Stale / count / contextFirst / handoffs of each one are checked by the
    // real-tree rules above, through evaluate().
    expect(problems).toEqual([]);
  });

  it('handsOffTo is unique and only on checkouts and helper calls', () => {
    const problems: string[] = [];
    for (const e of [...RAW_PG_SITES, ...SANCTIONED_HELPERS]) {
      const list = e.handsOffTo ?? [];
      if (new Set(list).size !== list.length) problems.push(`${keyOf(e)}: duplicate handsOffTo name`);
      if (list.length && !['pool.connect', 'client.connect', 'withClient', 'checkout-callback'].includes(e.access)) {
        problems.push(`${keyOf(e)}: handsOffTo on a ${e.access} entry`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every table listed as lacking a migration really lacks one', () => {
    const sql = getMigrationSQL();
    for (const t of TABLES_WITHOUT_MIGRATION) {
      expect(t.why.length, t.table).toBeGreaterThanOrEqual(40);
      expect(new RegExp(`CREATE TABLE\\s+(IF NOT EXISTS\\s+)?${t.table}\\b`, 'i').test(sql), t.table).toBe(false);
    }
  });

  it('R-guc watches exactly the GUCs the RLS policies read', () => {
    expect([...DEFAULT_GUC_NAMES].sort()).toEqual([...census.policyGucs].sort());
  });
});

describe('raw pg access vs. RLS (STRUCTURAL) — the tables check reads SQL', () => {
  const known = new Set(['tenants', 'customers', 'jobs', 'information_schema.columns']);
  it.each([
    ['SELECT * FROM tenants t, customers c WHERE c.tenant_id = t.id', ['customers', 'tenants']],
    ['SELECT * FROM tenants AS t, jobs AS j WHERE true', ['jobs', 'tenants']],
    ['DELETE FROM tenants USING customers WHERE customers.tenant_id = tenants.id', ['customers', 'tenants']],
    ['TRUNCATE customers', ['customers']],
    ['TRUNCATE TABLE jobs, customers', ['customers', 'jobs']],
    ['COPY customers TO STDOUT', ['customers']],
    ['SELECT * FROM "public"."customers"', ['customers']],
    ['UPDATE jobs SET a = 1 FROM customers WHERE jobs.id = customers.id', ['customers', 'jobs']],
    ['SELECT * FROM jobs j JOIN customers c USING (tenant_id)', ['customers', 'jobs']],
    ['SELECT a FROM customers WHERE x IN (1, 2)', ['customers']],
    ['SELECT table_name FROM information_schema.columns', ['information_schema.columns']],
    // Known limit: a comma item after a subquery or function is not read.
    ['SELECT * FROM tenants CROSS JOIN LATERAL (SELECT 1) x, jobs', ['tenants']],
  ])('%s → %j', (sql, tables) => {
    expect(sqlTables([sql], known)).toEqual(tables);
  });
});

// ─── Negative controls ──────────────────────────────────────────────────────

/** Minimal stand-ins at the real relative paths, so the sanctioned records apply. */
const PLANT_SUPPORT: Record<string, string> = {
  'src/db/pg-base.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    'export class PgBaseRepository {',
    '  constructor(protected readonly pool: Pool) {}',
    '  protected async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {',
    '    const c = await this.pool.connect();',
    '    try { return await fn(c); } finally { c.release(); }',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/db/rls-runtime-role.ts': [
    "import type { PoolClient } from 'pg';",
    'export async function applyTenantContext(client: PoolClient, tenantId: string, _o: { transactional?: boolean } = {}): Promise<void> {',
    "  await client.query(\"SELECT set_config('app.current_tenant_id', $1, true)\", [tenantId]);",
    '}',
    'export async function applyCrossTenantRole(client: PoolClient, _o: { transactional?: boolean } = {}): Promise<void> {',
    "  await client.query('SET LOCAL ROLE rls_cross_tenant');",
    '}',
    '',
  ].join('\n'),
};

const PLANTS: Record<string, string> = {
  // 1. A plain pool.query in a new file.
  'src/c1-plain.ts': [
    "import { Pool } from 'pg';",
    'export async function listCustomers(pool: Pool, tenantId: string) {',
    "  return pool.query('SELECT * FROM customers WHERE tenant_id = $1', [tenantId]);",
    '}',
  ].join('\n'),
  // 2. An alias: the pool under another name.
  'src/c2-alias.ts': [
    "import type { Pool } from 'pg';",
    'export async function viaAlias(deps: { pool: Pool }, tenantId: string) {',
    '  const db = deps.pool;',
    "  return db.query('SELECT id FROM jobs WHERE tenant_id = $1', [tenantId]);",
    '}',
  ].join('\n'),
  // 3. Type aliases: Pick<Pool,'query'>, and a standalone Client behind Pick<Client,…>.
  'src/c3-type-alias.ts': [
    "import type { Client, Pool } from 'pg';",
    "type Q = Pick<Pool, 'query'>;",
    "export function viaPick(q: Q) { return q.query('SELECT total_cents FROM invoices'); }",
    "type L = Pick<Client, 'connect' | 'query'>;",
    'export async function listen(l: L) {',
    '  await l.connect();',
    "  await l.query('LISTEN rotated');",
    '}',
  ].join('\n'),
  // 4. Destructuring, element access, bind, assignment.
  'src/c4-indirect.ts': [
    "import type { Pool } from 'pg';",
    'export function destructured(pool: Pool) { const { query } = pool; return query; }',
    "export function elementAccess(pool: Pool) { return pool['query']('SELECT * FROM leads'); }",
    'export function bound(pool: Pool) { return pool.query.bind(pool); }',
    'export function assigned(pool: Pool) { const q = pool.query; return q; }',
  ].join('\n'),
  // 5a. A checkout that only sets the GUC (looks scoped, is not).
  'src/c5-guc-only.ts': [
    "import type { Pool } from 'pg';",
    'export async function gucOnly(pool: Pool, tenantId: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    "    await client.query(\"SELECT set_config('app.current_tenant_id', $1, true)\", [tenantId]);",
    "    await client.query('SELECT * FROM customers WHERE tenant_id = $1', [tenantId]);",
    "    await client.query('COMMIT');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
  ].join('\n'),
  // 5b. The same checkout with applyTenantContext first — ALLOWED.
  'src/c5-context-first.ts': [
    "import type { Pool } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    'export async function contextFirst(pool: Pool, tenantId: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    await applyTenantContext(client, tenantId, { transactional: true });',
    "    await client.query('SELECT * FROM customers WHERE tenant_id = $1', [tenantId]);",
    "    await client.query('COMMIT');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
  ].join('\n'),
  // 6. withClient through this. and super. in a planted subclass.
  'src/c6-with-client.ts': [
    "import { PgBaseRepository } from './db/pg-base';",
    'export class PgThingRepository extends PgBaseRepository {',
    "  list() { return this.withClient((c) => c.query('SELECT * FROM customers')); }",
    "  listAll() { return super.withClient((c) => c.query('SELECT * FROM jobs')); }",
    '}',
  ].join('\n'),
  // 7. `as any` hides the receiver's type.
  'src/c7-any.ts': [
    "import type { Pool } from 'pg';",
    "export function anyPool(pool: Pool) { return (pool as any).query('SELECT * FROM customers'); }",
  ].join('\n'),
  // 8. An allowlisted global_table function gains a FROM customers.
  'src/c8-gains-table.ts': [
    "import type { Pool } from 'pg';",
    'export async function tenantName(pool: Pool, id: string) {',
    "  await pool.query('SELECT name FROM tenants WHERE id = $1', [id]);",
    "  return pool.query('SELECT * FROM customers WHERE tenant_id = $1', [id]);",
    '}',
  ].join('\n'),
  // 9. A second pool.query in an allowlisted function.
  'src/c9-second-query.ts': [
    "import type { Pool } from 'pg';",
    'export async function ownerOf(pool: Pool, id: string) {',
    "  await pool.query('SELECT name FROM tenants WHERE id = $1', [id]);",
    "  return pool.query('SELECT owner_id FROM tenants WHERE id = $1', [id]);",
    '}',
  ].join('\n'),
  // Inverse: comments are not code.
  'src/c10-comment-only.ts': [
    "// await pool.query('SELECT * FROM customers')",
    '/* const client = await pool.connect(); this.withClient(fn); */',
    'export const ok = true;',
  ].join('\n'),
  // A table name built at runtime.
  'src/c11-dynamic.ts': [
    "import type { Pool } from 'pg';",
    'export async function wipe(pool: Pool, table: string, tenantId: string) {',
    // eslint-disable-next-line no-template-curly-in-string -- planted source text: the substitution is the point
    '  return pool.query(`DELETE FROM "${table}" WHERE tenant_id = $1`, [tenantId]);',
    '}',
  ].join('\n'),
  // set_config through a template literal.
  'src/c12-template-guc.ts': [
    "import type { PoolClient } from 'pg';",
    'export async function setIt(client: PoolClient, tenantId: string) {',
    // eslint-disable-next-line no-template-curly-in-string -- planted source text: the substitution is the point
    "  await client.query(`SELECT set_config('app.current_tenant_id', '${tenantId}', true)`);",
    "  await client.query(`SET LOCAL app.system_lookup = 'true'`);",
    '}',
  ].join('\n'),
  // The checked-out client handed to a helper that is not a context helper.
  'src/c13-handoff.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "async function readCustomers(c: PoolClient) { return c.query('SELECT * FROM customers'); }",
    'export async function handoff(pool: Pool) {',
    '  const client = await pool.connect();',
    '  try { return await readCustomers(client); } finally { client.release(); }',
    '}',
  ].join('\n'),
  // A cross-tenant checkout that never takes the attributed role.
  'src/c14-cross-tenant.ts': [
    "import type { Pool } from 'pg';",
    'export async function sweep(pool: Pool) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    "    return await client.query('SELECT tenant_id FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
  ].join('\n'),
};

function entry(over: Partial<RawPgSite> & Pick<RawPgSite, 'file' | 'fn' | 'access' | 'category'>): RawPgSite {
  return { count: 1, tables: [], why: 'Planted negative-control entry; the reason text is not under test here.', ...over };
}

describe('raw pg access vs. RLS (STRUCTURAL) — negative controls', () => {
  let plantDir = '';
  let planted: PgAccessSite[] = [];
  const inFile = (file: string): PgAccessSite[] => planted.filter((s) => s.file === file);
  const evalFile = (file: string, entries: RawPgSite[]): Report =>
    evaluate(inFile(file), entries, census, SANCTIONED_HELPERS.filter((h) => h.file === file));
  const clean = (): Report => evaluate([], [], census, []);

  beforeAll(() => {
    plantDir = plantTree('raw-pg-guard', { ...PLANT_SUPPORT, ...PLANTS });
    const { rootNames, compilerOptions } = plantProgramInputs(plantDir, API_DIR);
    planted = findPgAccess(rootNames, compilerOptions, { baseDir: plantDir });
  }, 120_000);

  afterAll(() => {
    if (plantDir) removeTree(plantDir);
  });

  it('sanity: `pg` resolves to the real typings in the plant (a planted pool is a Pool, not `any`)', () => {
    const c1 = inFile('src/c1-plain.ts');
    expect(c1.map((s) => [s.access, s.owner])).toEqual([['pool.query', 'Pool']]);
    // The stand-in helpers carry the real sanctioned keys (withClient's
    // checkout, applyTenantContext's GUC), so the real records apply to them.
    const support = planted.filter((s) => s.file.startsWith('src/db/'));
    const theirs = SANCTIONED_HELPERS.filter((h) => support.some((s) => keyOf(s) === keyOf(h)));
    expect(theirs.map(keyOf)).toEqual([
      'src/db/pg-base.ts :: PgBaseRepository.withClient :: pool.connect',
      'src/db/rls-runtime-role.ts :: applyTenantContext :: guc-only',
    ]);
    expect(evaluate(support, [], census, theirs)).toEqual(clean());
  });

  it('1. a plain pool.query in a new file is unlisted', () => {
    const r = evalFile('src/c1-plain.ts', []);
    expect(r.unlisted).toHaveLength(1);
    expect(r.unlisted[0]).toContain('src/c1-plain.ts:3 [pool.query] listCustomers');
    expect(sqlTables(inFile('src/c1-plain.ts')[0].sql, census.known)).toEqual(['customers']);
  });

  it('2. an aliased pool (`const db = deps.pool`) is still a pool.query', () => {
    expect(inFile('src/c2-alias.ts').map((s) => `${s.access} ${s.fn}`)).toEqual(['pool.query viaAlias']);
    expect(evalFile('src/c2-alias.ts', []).unlisted).toHaveLength(1);
  });

  it("3. Pick<Pool,'query'> is a pool.query, and a Pick<Client,…> connect is a client.connect", () => {
    expect(inFile('src/c3-type-alias.ts').map((s) => `${s.access} ${s.fn}`)).toEqual([
      'pool.query viaPick',
      'client.connect listen',
    ]);
    expect(evalFile('src/c3-type-alias.ts', []).unlisted).toHaveLength(2);
  });

  it('4. destructuring, bind and assignment are indirect (never allowlistable); element access is a pool.query', () => {
    const found = inFile('src/c4-indirect.ts').map((s) => `${s.access} ${s.fn}`);
    expect(found).toEqual([
      'indirect destructured',
      'pool.query elementAccess',
      'indirect bound',
      'indirect assigned',
    ]);
    const r = evalFile('src/c4-indirect.ts', [
      // Even "allowlisting" the element-access site leaves the indirect ones failing.
      entry({ file: 'src/c4-indirect.ts', fn: 'elementAccess', access: 'pool.query', category: 'tenant_filtered_no_rls', tables: ['leads'], migrateBy: '#0' }),
    ]);
    expect(r.forbidden).toHaveLength(3);
    expect(r.unlisted).toEqual([]);
  });

  it('5a. a GUC-only checkout claimed as tenant_context_applied fails R-order, and its set_config fails R-guc', () => {
    const r = evalFile('src/c5-guc-only.ts', [
      entry({ file: 'src/c5-guc-only.ts', fn: 'gucOnly', access: 'pool.connect', category: 'tenant_context_applied', tables: ['customers'] }),
    ]);
    expect(r.order).toHaveLength(1);
    expect(r.order[0]).toContain("set_config('app.current_tenant_id'");
    expect(r.unlisted.map((u) => u.split(' — ')[0])).toEqual(['src/c5-guc-only.ts:6 [guc-only] gucOnly']);
  });

  it('5b. ALLOWED — the same checkout with applyTenantContext first passes every rule', () => {
    const r = evalFile('src/c5-context-first.ts', [
      entry({ file: 'src/c5-context-first.ts', fn: 'contextFirst', access: 'pool.connect', category: 'tenant_context_applied', tables: ['customers'] }),
    ]);
    expect(r).toEqual(clean());
    expect(inFile('src/c5-context-first.ts')[0].order).toMatchObject({ clientVar: 'client', contextFirst: true });
  });

  it('6. this.withClient and super.withClient in a PgBaseRepository subclass are listed', () => {
    expect(inFile('src/c6-with-client.ts').map((s) => `${s.access} ${s.fn}`)).toEqual([
      'withClient PgThingRepository.list',
      'withClient PgThingRepository.listAll',
    ]);
    expect(evalFile('src/c6-with-client.ts', []).unlisted).toHaveLength(2);
  });

  it('7. (pool as any).query is R-any (never allowlistable)', () => {
    const r = evalFile('src/c7-any.ts', []);
    expect(r.forbidden).toHaveLength(1);
    expect(r.forbidden[0]).toContain('[any-receiver] anyPool');
  });

  it('8. an allowlisted global_table function that gains FROM customers fails the tables check', () => {
    const r = evalFile('src/c8-gains-table.ts', [
      entry({ file: 'src/c8-gains-table.ts', fn: 'tenantName', access: 'pool.query', count: 2, category: 'global_table', tables: ['tenants'] }),
    ]);
    expect(r.tables).toEqual([
      'src/c8-gains-table.ts :: tenantName :: pool.query: SQL touches customers not in entry.tables [tenants]',
    ]);
    // …and listing customers instead is caught by the census: global_table cannot name an RLS table.
    const relisted = evalFile('src/c8-gains-table.ts', [
      entry({ file: 'src/c8-gains-table.ts', fn: 'tenantName', access: 'pool.query', count: 2, category: 'global_table', tables: ['tenants', 'customers'] }),
    ]);
    expect(relisted.categories.join('\n')).toContain('global_table names FORCE-RLS table(s) customers');
  });

  it('9. a second pool.query in an allowlisted function fails the exact count', () => {
    const r = evalFile('src/c9-second-query.ts', [
      entry({ file: 'src/c9-second-query.ts', fn: 'ownerOf', access: 'pool.query', category: 'global_table', tables: ['tenants'] }),
    ]);
    expect(r.counts).toEqual(['src/c9-second-query.ts :: ownerOf :: pool.query: entry says 1, found 2 at lines 3, 4']);
  });

  it('inverse — pg calls that appear only in comments are not sites', () => {
    expect(inFile('src/c10-comment-only.ts')).toEqual([]);
  });

  it('a stale entry (its site is gone) fails', () => {
    const r = evaluate([], [entry({ file: 'src/gone.ts', fn: 'migrated', access: 'pool.query', category: 'global_table', tables: ['tenants'] })], census, []);
    expect(r.stale).toHaveLength(1);
  });

  it('SQL that builds its table name must be declared dynamicSql', () => {
    const base = { file: 'src/c11-dynamic.ts', fn: 'wipe', access: 'pool.query' as const, category: 'cross_tenant_intentional' as const };
    expect(evalFile('src/c11-dynamic.ts', [entry(base)]).tables.join('\n')).toContain('must set dynamicSql');
    expect(evalFile('src/c11-dynamic.ts', [entry({ ...base, dynamicSql: true })])).toEqual(clean());
  });

  it('R-guc catches set_config and SET LOCAL through template literals', () => {
    expect(inFile('src/c12-template-guc.ts').map((s) => `${s.access}:${s.line}`)).toEqual(['guc-only:3', 'guc-only:4']);
  });

  it('a checkout that hands its client to a non-context helper cannot claim tenant_context_applied', () => {
    const r = evalFile('src/c13-handoff.ts', [
      entry({ file: 'src/c13-handoff.ts', fn: 'handoff', access: 'pool.connect', category: 'tenant_context_applied', tables: ['customers'] }),
    ]);
    expect(r.order).toHaveLength(1);
  });

  it('a cross-tenant checkout without applyCrossTenantRole fails unless its attribution is tracked', () => {
    const base = { file: 'src/c14-cross-tenant.ts', fn: 'sweep', access: 'pool.connect' as const, category: 'cross_tenant_intentional' as const, tables: ['customers'] };
    expect(evalFile('src/c14-cross-tenant.ts', [entry(base)]).order).toHaveLength(1);
    expect(evalFile('src/c14-cross-tenant.ts', [entry({ ...base, migrateBy: 'audit 2026-10-23 §4 P3.3' })]).order).toEqual([]);
  });

  it('a tenant_filtered_no_rls entry without migrateBy, and a bare guc-only cross-tenant entry, fail', () => {
    const r = evalFile('src/c1-plain.ts', [
      entry({ file: 'src/c1-plain.ts', fn: 'listCustomers', access: 'pool.query', category: 'tenant_filtered_no_rls', tables: ['customers'] }),
    ]);
    expect(r.categories.join('\n')).toContain('needs migrateBy');
    const g = evalFile('src/c5-guc-only.ts', [
      entry({ file: 'src/c5-guc-only.ts', fn: 'gucOnly', access: 'guc-only', category: 'cross_tenant_intentional', tables: ['customers'] }),
    ]);
    expect(g.categories.join('\n')).toContain('guc-only entry is allowed only');
  });
});

// ─── Negative controls, round 2: callback handoffs, sanctioned keying, evasions ─

const PLANTS_R2: Record<string, string> = {
  // A raw-checkout helper hands its principal client to the caller's callback.
  'src/r2-callback-helper.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    'async function systemLookup<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    const out = await run(client);',
    "    await client.query('COMMIT');",
    '    return out;',
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'export async function findByDid(pool: Pool, did: string) {',
    "  return systemLookup(pool, async (client) => (await client.query(\"SELECT tenant_id FROM tenant_integrations WHERE provider_data->>'phoneE164' = $1\", [did])).rows);",
    '}',
    '// The evasion: a NEW caller of the listed helper.',
    'export async function dumpTokens(pool: Pool) {',
    "  return systemLookup(pool, async (client) => (await client.query('SELECT auth_token_primary_enc FROM tenant_integrations')).rows);",
    '}',
    '// A wrapper that passes its own callback through makes it a helper too.',
    'export async function lookupVia<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {',
    '  return systemLookup(pool, run);',
    '}',
    'export async function wipeViaWrapper(pool: Pool) {',
    "  return lookupVia(pool, async (c) => c.query('DELETE FROM customers'));",
    '}',
  ].join('\n'),
  // The idempotency-lock shape: the caller reaches the helper through an interface.
  'src/r2-interface-helper.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    'export interface Locker {',
    '  withLock<T>(key: string, fn: (client?: PoolClient) => Promise<T>): Promise<T>;',
    '}',
    'export class PgLocker implements Locker {',
    '  constructor(private readonly pool: Pool) {}',
    '  async withLock<T>(key: string, fn: (client?: PoolClient) => Promise<T>): Promise<T> {',
    '    const client = await this.pool.connect();',
    '    try {',
    "      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);",
    '      return await fn(client);',
    '    } finally {',
    '      client.release();',
    '    }',
    '  }',
    '}',
    'export class Guard {',
    '  constructor(private readonly lock: Locker) {}',
    '  run(key: string, work: () => Promise<void>) {',
    '    return this.lock.withLock(key, async (client) => {',
    "      await client!.query('UPDATE customers SET notes = NULL');",
    '      await work();',
    '    });',
    '  }',
    '}',
  ].join('\n'),
  // A global_table checkout that starts handing its client to a new function.
  'src/r2-handoff.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "function watch(client: PoolClient): void { client.on('error', () => undefined); }",
    "async function readCustomers(c: PoolClient) { return c.query('SELECT * FROM customers'); }",
    'export async function lockAndRead(pool: Pool) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('SELECT pg_advisory_lock(1)');",
    '    watch(client);',
    '    return await readCustomers(client);',
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
  ].join('\n'),
  // The checked-out client under another name, in an object, or returned.
  'src/r2-escapes.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    'export async function aliased(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    '  const c2 = client;',
    '  try {',
    "    await client.query('BEGIN');",
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await c2.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'export async function boxed(pool: Pool): Promise<{ client: PoolClient }> {',
    '  const client = await pool.connect();',
    '  const holder = { client };',
    '  return holder;',
    '}',
    'export async function handedBack(pool: Pool): Promise<PoolClient> {',
    '  const client = await pool.connect();',
    "  await client.query('SELECT 1');",
    '  return client;',
    '}',
  ].join('\n'),
  // A sanctioned helper file that gains a second, raw function.
  'src/workers/tenant-query.ts': [
    "import type { Pool, QueryResult } from 'pg';",
    "import { applyTenantContext } from '../db/rls-runtime-role';",
    'export async function tenantQuery(pool: Pool, tenantId: string, sql: string, params: unknown[] = []): Promise<QueryResult> {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    await applyTenantContext(client, tenantId, { transactional: true });',
    '    const result = await client.query(sql, params);',
    "    await client.query('COMMIT');",
    '    return result;',
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'export async function sneakyRead(pool: Pool) {',
    "  return pool.query('SELECT * FROM customers');",
    '}',
  ].join('\n'),
  // Policy-GUC spellings R-guc must see, and two it must not.
  'src/r2-guc-variants.ts': [
    "import type { PoolClient } from 'pg';",
    "export async function upper(c: PoolClient, t: string) { await c.query(\"SELECT SET_CONFIG('app.current_tenant_id', $1, true)\", [t]); }",
    "export async function session(c: PoolClient) { await c.query(\"SET SESSION app.current_tenant_id = 'x'\"); }",
    "export async function quoted(c: PoolClient) { await c.query('SET LOCAL \"app.portal_token_lookup\" = \\'true\\''); }",
    'export async function notGuc(c: PoolClient) {',
    "  await c.query('RESET app.current_tenant_id');",
    "  await c.query('SET LOCAL ROLE rls_app_runtime');",
    '}',
  ].join('\n'),
  // A Pool reaching SQL through a type the typed rule cannot classify.
  'src/r2-structural-escape.ts': [
    "import type { ClientBase, Pool } from 'pg';",
    'interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }',
    "async function readVia(db: Queryable) { return db.query('SELECT * FROM customers WHERE tenant_id = $1', ['t']); }",
    "async function readClient(c: ClientBase) { return c.query('SELECT * FROM jobs'); }",
    'export async function viaInterface(pool: Pool) { return readVia(pool); }',
    'export async function viaClientCast(pool: Pool) { return readClient(pool as unknown as ClientBase); }',
    "export async function viaCast(pool: Pool) { return (pool as unknown as Queryable).query('SELECT * FROM leads'); }",
    'export async function passThrough(db: Queryable) { return readVia(db); }',
    'export async function viaPassThrough(pool: Pool) { return passThrough(pool); }',
  ].join('\n'),
  // A pool event listener that receives a client.
  'src/r2-pool-listener.ts': [
    "import type { Pool } from 'pg';",
    'export function onConnect(pool: Pool) {',
    "  pool.on('connect', (client) => { void client.query('DELETE FROM customers'); });",
    '}',
  ].join('\n'),
  // Member access the literal-name rules missed.
  'src/r2-element-access.ts': [
    "import type { Pool } from 'pg';",
    "import { PgBaseRepository } from './db/pg-base';",
    "const K = 'query' as const;",
    "export async function viaConstKey(pool: Pool) { return pool[K]('SELECT * FROM customers'); }",
    'export function viaKeyofKey(pool: Pool, k: keyof Pool) { return pool[k]; }',
    "export function computedDestructure(pool: Pool) { const { ['query']: q } = pool; return q; }",
    'export class ElementRepo extends PgBaseRepository {',
    "  list() { return this['withClient']((c) => c.query('SELECT * FROM customers')); }",
    '}',
  ].join('\n'),
};

describe('raw pg access vs. RLS (STRUCTURAL) — negative controls, round 2', () => {
  let plantDir = '';
  let planted: PgAccessSite[] = [];
  const inFile = (file: string): PgAccessSite[] => planted.filter((s) => s.file === file);
  const sanctionedIn = (file: string) => SANCTIONED_HELPERS.filter((h) => h.file === file);
  const evalFile = (file: string, entries: RawPgSite[]): Report => evaluate(inFile(file), entries, census, sanctionedIn(file));

  beforeAll(() => {
    plantDir = plantTree('raw-pg-guard-r2', { ...PLANT_SUPPORT, ...PLANTS_R2 });
    const { rootNames, compilerOptions } = plantProgramInputs(plantDir, API_DIR);
    planted = findPgAccess(rootNames, compilerOptions, { baseDir: plantDir });
  }, 120_000);

  afterAll(() => {
    if (plantDir) removeTree(plantDir);
  });

  it('a new caller of a listed raw-checkout helper is unlisted, and so is a caller of a pass-through wrapper', () => {
    const f = 'src/r2-callback-helper.ts';
    expect(inFile(f).map((s) => `${s.access} ${s.fn}`)).toEqual([
      'pool.connect systemLookup',
      'checkout-callback findByDid',
      'checkout-callback dumpTokens',
      'checkout-callback wipeViaWrapper',
    ]);
    const r = evalFile(f, [
      entry({ file: f, fn: 'systemLookup', access: 'pool.connect', category: 'global_table' }),
      entry({ file: f, fn: 'findByDid', access: 'checkout-callback', category: 'pre_tenant_lookup', tables: ['tenant_integrations'] }),
    ]);
    expect(r.unlisted.map((u) => u.split(' — ')[0])).toEqual([
      'src/r2-callback-helper.ts:18 [checkout-callback] dumpTokens',
      'src/r2-callback-helper.ts:25 [checkout-callback] wipeViaWrapper',
    ]);
    // The callback's SQL is the site's SQL, so the tables check sees it.
    expect(sqlTables(inFile(f).find((s) => s.fn === 'wipeViaWrapper')!.sql, census.known)).toEqual(['customers']);
  });

  it('a caller that reaches the helper through an interface it implements is a site, and its callback SQL is checked', () => {
    const f = 'src/r2-interface-helper.ts';
    expect(inFile(f).map((s) => `${s.access} ${s.fn}`)).toEqual(['pool.connect PgLocker.withLock', 'checkout-callback Guard.run']);
    const r = evalFile(f, [
      entry({ file: f, fn: 'PgLocker.withLock', access: 'pool.connect', category: 'global_table' }),
      entry({ file: f, fn: 'Guard.run', access: 'checkout-callback', category: 'global_table' }),
    ]);
    expect(r.tables).toEqual(['src/r2-interface-helper.ts :: Guard.run :: checkout-callback: SQL touches customers not in entry.tables []']);
  });

  it('a checkout that hands its client to a function its entry does not name fails, and so does a stale handsOffTo', () => {
    const f = 'src/r2-handoff.ts';
    const base = { file: f, fn: 'lockAndRead', access: 'pool.connect' as const, category: 'global_table' as const };
    const r = evalFile(f, [entry({ ...base, handsOffTo: ['watch'] })]);
    expect(r.handoffs).toEqual(['src/r2-handoff.ts :: lockAndRead :: pool.connect: hands the client to readCustomers, which handsOffTo does not name']);
    // One hop into the named function: its SQL is the checkout's SQL too.
    expect(r.tables.join('\n')).toContain('SQL touches customers');
    const stale = evalFile(f, [entry({ ...base, tables: ['customers'], handsOffTo: ['watch', 'readCustomers', 'gone'] })]);
    expect(stale.handoffs).toEqual(['src/r2-handoff.ts :: lockAndRead :: pool.connect: handsOffTo names gone, which no longer receives the client']);
  });

  it('an aliased, boxed or returned client is a handoff the entry must name', () => {
    const f = 'src/r2-escapes.ts';
    expect(inFile(f).map((s) => `${s.fn} ${JSON.stringify(s.handoffs)}`)).toEqual([
      'aliased ["<alias c2>"]',
      'boxed ["<object>"]',
      'handedBack ["<return>"]',
    ]);
    const r = evalFile(f, [
      entry({ file: f, fn: 'aliased', access: 'pool.connect', category: 'tenant_context_applied', tables: ['customers'] }),
      entry({ file: f, fn: 'boxed', access: 'pool.connect', category: 'global_table' }),
      entry({ file: f, fn: 'handedBack', access: 'pool.connect', category: 'global_table' }),
    ]);
    expect(r.handoffs.map((h) => h.replace(/^.* :: pool\.connect: /, ''))).toEqual([
      'hands the client to <alias c2>, which handsOffTo does not name',
      'hands the client to <object>, which handsOffTo does not name',
      'hands the client to <return>, which handsOffTo does not name',
    ]);
  });

  it('a sanctioned helper is keyed by function, access and count: a second raw function in its file is unlisted', () => {
    const f = 'src/workers/tenant-query.ts';
    const sites = inFile(f);
    const r = evaluate(sites, [], census, sanctionedIn(f));
    expect(r.unlisted.map((u) => u.split(' — ')[0])).toEqual(['src/workers/tenant-query.ts:16 [pool.query] sneakyRead']);
    expect({ ...r, unlisted: [] }).toEqual(evaluate([], [], census, []));
    // …and the count and stale rules apply to it like any entry.
    const tq = sites.filter((s) => s.fn === 'tenantQuery');
    expect(evaluate([...tq, ...tq], [], census, sanctionedIn(f)).counts).toHaveLength(1);
    expect(evaluate([], [], census, sanctionedIn(f)).stale).toHaveLength(1);
  });

  it('R-guc: upper-case set_config, SET SESSION and a quoted GUC name are caught; RESET and SET LOCAL ROLE are not', () => {
    expect(inFile('src/r2-guc-variants.ts').map((s) => `${s.access}:${s.line} ${s.fn}`)).toEqual([
      'guc-only:2 upper',
      'guc-only:3 session',
      'guc-only:4 quoted',
    ]);
  });

  it('a Pool reaching SQL through a structural parameter, a pass-through, or an as-unknown-as cast is a pool-escape site', () => {
    const f = 'src/r2-structural-escape.ts';
    expect(inFile(f).map((s) => `${s.access} ${s.fn}`)).toEqual([
      'pool-escape viaInterface',
      'pool-escape viaClientCast',
      'pool-escape viaCast',
      'pool-escape viaPassThrough',
    ]);
    const r = evalFile(f, []);
    expect(r.unlisted).toHaveLength(4);
    // The SQL the escaped pool runs is the site's SQL, so the tables check sees it.
    expect(sqlTables(inFile(f).flatMap((s) => s.sql), census.known)).toEqual(['customers', 'jobs', 'leads']);
  });

  it("pool.on('connect', …) hands every new client to its listener: a checkout-callback site", () => {
    const sites = inFile('src/r2-pool-listener.ts');
    expect(sites.map((s) => `${s.access} ${s.fn} ${s.owner}`)).toEqual(['checkout-callback onConnect Pool.on']);
    expect(sqlTables(sites[0].sql, census.known)).toEqual(['customers']);
  });

  it('element access through a const key, a keyof key, a computed destructuring key and this[\'withClient\'] are all seen', () => {
    expect(inFile('src/r2-element-access.ts').map((s) => `${s.access} ${s.fn}`)).toEqual([
      'pool.query viaConstKey',
      'indirect viaKeyofKey',
      'indirect computedDestructure',
      'withClient ElementRepo.list',
    ]);
  });
});

// ─── Negative controls, round 3: pre-context delegates, client closures, evasions ─

const PLANTS_R3: Record<string, string> = {
  // A delegate handed the client BEFORE the context helper runs its SQL as the principal.
  'src/r3-pre-context-delegate.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    "async function peek(c: PoolClient) { return c.query('SELECT id FROM customers LIMIT 1'); }",
    "async function lock(c: PoolClient, key: number) { await c.query('SELECT pg_advisory_xact_lock($1)', [key]); }",
    'export async function peekFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    await peek(client);',
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    '// ALLOWED: a delegate that only takes a lock before context.',
    'export async function lockFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    await lock(client, 1);',
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'async function withPrincipal<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {',
    '  const client = await pool.connect();',
    '  try { return await fn(client); } finally { client.release(); }',
    '}',
    'export async function callbackPeekFirst(pool: Pool, t: string) {',
    '  return withPrincipal(pool, async (c) => {',
    '    await peek(c);',
    '    await applyTenantContext(c, t, { transactional: true });',
    "    return c.query('SELECT * FROM customers');",
    '  });',
    '}',
    '// Fails closed: a delegate whose body the scan cannot read is the first effect.',
    'interface Peeker { peek(c: PoolClient): Promise<unknown> }',
    'export class InjectedPeek {',
    '  constructor(private readonly peeker: Peeker) {}',
    '  async run(pool: Pool, t: string) {',
    '    const client = await pool.connect();',
    '    try {',
    "      await client.query('BEGIN');",
    '      await this.peeker.peek(client);',
    '      await applyTenantContext(client, t, { transactional: true });',
    "      return await client.query('SELECT * FROM customers');",
    '    } finally {',
    '      client.release();',
    '    }',
    '  }',
    '}',
    "async function peekObj(args: { client: PoolClient }) { return args.client.query('SELECT id FROM customers LIMIT 1'); }",
    'export async function objectArgFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    await peekObj({ client });',
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'export async function callFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    await peek.call(undefined, client);',
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    '// …and so is a call that reaches the client only inside an array literal or a spread of one.',
    'export async function applyFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN');",
    '    await peek.apply(undefined, [client]);',
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    "async function peekTuple(t: [PoolClient, string]) { return t[0].query('SELECT id FROM customers LIMIT 1'); }",
    "async function peekNested(a: { all: PoolClient[] }) { return a.all[0].query('SELECT id FROM customers LIMIT 1'); }",
    'export async function reflectApplyFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await Reflect.apply(peek, undefined, [client]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function spreadFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peek(...([client] as [PoolClient])); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function tupleFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekTuple([client, 'x']); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function nestedFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekNested({ all: [client] }); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    '// SQL that is not a literal is never BEGIN / a lock, whatever literal it may also be;',
    '// nor is a statement list that starts with one.',
    'export async function maybeBeginFirst(pool: Pool, t: string, sql: string, fresh: boolean) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query(fresh ? 'BEGIN' : sql);",
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'export async function beginThenReadFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await client.query('BEGIN; SELECT id FROM customers LIMIT 1');",
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
  ].join('\n'),
  // Closures over a checked-out client, and SQL whose text is not a literal.
  'src/r3-closures.ts': [
    "import type { Pool, PoolClient, QueryResult } from 'pg';",
    'type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;',
    '// A helper hands its caller a query FUNCTION over its principal client.',
    'export async function withQuery<T>(pool: Pool, fn: (q: Q) => Promise<T>): Promise<T> {',
    '  const client = await pool.connect();',
    '  try {',
    '    return await fn((sql, params) => client.query(sql, params));',
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'export async function readViaQuery(pool: Pool) {',
    "  return withQuery(pool, (q) => q('SELECT * FROM customers'));",
    '}',
    '// A factory returns a closure over a principal client it never releases.',
    'export async function queryFactory(pool: Pool): Promise<Q> {',
    '  const client = await pool.connect();',
    '  return (sql, params) => client.query(sql, params);',
    '}',
    'function later(work: () => Promise<unknown>): void {',
    '  setTimeout(() => void work(), 0);',
    '}',
    '// A closure handed to a named function, directly or through a const.',
    'export async function deferred(pool: Pool) {',
    '  const client = await pool.connect();',
    "  later(() => client.query('LISTEN wake'));",
    '}',
    'export async function storedThenPassed(pool: Pool) {',
    '  const client = await pool.connect();',
    "  const unlisten = () => client.query('UNLISTEN wake');",
    '  later(unlisten);',
    '}',
    '// ALLOWED: a closure kept in a const and only called in place.',
    'export async function calledInPlace(pool: Pool) {',
    '  const client = await pool.connect();',
    '  const release = () => client.release();',
    '  try {',
    "    return await client.query('SELECT 1');",
    '  } finally {',
    '    release();',
    '  }',
    '}',
    '// Caller-supplied SQL straight onto the pool.',
    'export async function anySql(pool: Pool, sql: string) {',
    '  return pool.query(sql);',
    '}',
    '// An alias of a closure local is the closure: passed, or returned.',
    'export async function aliasPassed(pool: Pool) {',
    '  const client = await pool.connect();',
    "  const q = () => client.query('SELECT 1');",
    '  const r = q;',
    '  later(r);',
    '}',
    'export async function aliasReturned(pool: Pool) {',
    '  const client = await pool.connect();',
    "  const q = () => client.query('SELECT 1');",
    '  const r = q;',
    '  return r;',
    '}',
    '// Closures declared above the checkout, or used above their declaration: their SQL is read too.',
    'export async function declaredAbove(pool: Pool) {',
    "  function q() { return client.query('SELECT 2'); }",
    '  const client = await pool.connect();',
    '  later(q);',
    '}',
    'export async function letThenAssign(pool: Pool) {',
    '  let client: PoolClient | undefined;',
    "  const q = () => client!.query('SELECT 3');",
    '  client = await pool.connect();',
    '  later(q);',
    '}',
    'export async function usedAboveDeclaration(pool: Pool) {',
    '  const client = await pool.connect();',
    '  later(q);',
    "  function q() { return client.query('SELECT 4'); }",
    '}',
    '// A built-in callee is not a callback the caller supplies: ids.map(…) over the client is a <closure>.',
    'export async function insertAll(pool: Pool, ids: string[]) {',
    '  const client = await pool.connect();',
    '  try {',
    "    await Promise.all(ids.map((id) => client.query('SELECT $1::text', [id])));",
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    'export async function importBatch(pool: Pool) {',
    "  return insertAll(pool, ['a', 'b']);",
    '}',
    'export async function mapSet(pool: Pool, map: Map<string, () => Promise<unknown>>) {',
    '  const client = await pool.connect();',
    "  map.set('k', () => client.query('SELECT 1'));",
    '}',
    '// Known limits: a class expression over the client; an unawaited IIFE (run in place, by design).',
    'export async function classExpr(pool: Pool) {',
    '  const client = await pool.connect();',
    "  return new (class { run() { return client.query('SELECT 1'); } })();",
    '}',
    'export async function unawaitedIife(pool: Pool) {',
    '  const client = await pool.connect();',
    "  void (async () => { await new Promise((r) => setTimeout(r, 10)); await client.query('SELECT 1'); })();",
    '  client.release();',
    '}',
  ].join('\n'),
  // SQL whose text is not (wholly) a literal: each spelling hides a statement.
  'src/r3-opaque.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    // eslint-disable-next-line no-template-curly-in-string -- planted source text: the substitution is the point
    'function build(table: string): string { return `SELECT * FROM ${table}`; }',
    'async function runRaw(c: PoolClient, sql: string, _label: string): Promise<unknown> { return c.query(sql); }',
    "export async function concat(pool: Pool, sql: string) { return pool.query(sql + ' LIMIT 100'); }",
    // eslint-disable-next-line no-template-curly-in-string -- planted source text: the substitution is the point
    'export async function template(pool: Pool, sql: string) { return pool.query(`${sql}`); }',
    "export async function ternary(pool: Pool, sql: string, probe: boolean) { return pool.query(probe ? 'SELECT 1' : sql); }",
    "export async function built(pool: Pool) { return pool.query(build('customers')); }",
    "export async function config(pool: Pool, sql: string) { return pool.query({ text: sql, values: ['x'] }); }",
    "export async function joined(pool: Pool, parts: string[]) { return pool.query(parts.join(' ')); }",
    'export async function checkoutConcat(pool: Pool, sql: string) {',
    '  const client = await pool.connect();',
    "  try { return await client.query(sql + ';'); } finally { client.release(); }",
    '}',
    'export async function delegateLabel(pool: Pool, sql: string) {',
    '  const client = await pool.connect();',
    "  try { return await runRaw(client, sql, 'audit'); } finally { client.release(); }",
    '}',
    '// ALLOWED: readable spellings, and a delegate whose SQL parameter is bound to a literal here.',
    "const BASE = 'SELECT id FROM customers';",
    'export async function readable(pool: Pool, flag: boolean) {',
    "  await pool.query(BASE + ' LIMIT 1');",
    "  await pool.query(flag ? BASE : 'SELECT 1');",
    '  await pool.query({ text: BASE, values: [] });',
    // eslint-disable-next-line no-template-curly-in-string -- planted source text: the substitution is the point
    "  return pool.query(`${BASE} WHERE id = $1`, ['x']);",
    '}',
    'export async function delegateLiteral(pool: Pool) {',
    '  const client = await pool.connect();',
    "  try { return await runRaw(client, 'SELECT id FROM customers', 'audit'); } finally { client.release(); }",
    '}',
  ].join('\n'),
  // Cheap spellings the round-2 rules missed, and the documented limits.
  'src/r3-evasions.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { PgBaseRepository } from './db/pg-base';",
    "export async function spaced(c: PoolClient, t: string) { await c.query(\"SELECT set_config ('app.current_tenant_id', $1, true)\", [t]); }",
    'export async function newline(c: PoolClient, t: string) { await c.query(`SELECT set_config',
    "  ('app.system_lookup', $1, true)`, [t]); }",
    "export async function quotedParts(c: PoolClient) { await c.query('SET LOCAL \"app\".\"current_tenant_id\" = \\'x\\''); }",
    "export async function optionalPool(pool: Pool | undefined) { return pool?.['query']('SELECT * FROM customers'); }",
    'export class UnionKeyRepo extends PgBaseRepository {',
    '  protected async withOther<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> { return fn(null as unknown as PoolClient); }',
    "  run(k: 'withClient' | 'withOther') { return this[k]((c: PoolClient) => c.query('SELECT * FROM customers')); }",
    '}',
    '// Known limits (see the doc): an E-string or dollar-quoted GUC name, pg_settings, a name split across literals.',
    "export async function eString(c: PoolClient, t: string) { await c.query(\"SELECT set_config(E'app.current_tenant_id', $1, true)\", [t]); }",
    "export async function dollar(c: PoolClient, t: string) { await c.query('SELECT set_config($$app.current_tenant_id$$, $1, true)', [t]); }",
    "export async function pgSettings(c: PoolClient, t: string) { await c.query(\"UPDATE pg_settings SET setting = $1 WHERE name = 'app.current_tenant_id'\", [t]); }",
    "export async function split(c: PoolClient, t: string) { await c.query('SELECT set_config(' + \"'app.current_tenant_id', $1, true)\", [t]); }",
    '// Read once SQL comments are stripped: a quoted function name, a comment before ( or after SET, a spaced dot.',
    "export async function quotedFn(c: PoolClient, t: string) { await c.query('SELECT \"set_config\"(\\'app.current_tenant_id\\', $1, true)', [t]); }",
    "export async function commentParen(c: PoolClient, t: string) { await c.query(\"SELECT set_config/**/('app.current_tenant_id', $1, true)\", [t]); }",
    "export async function commentAfterSet(c: PoolClient) { await c.query(\"SET LOCAL /* scope */ app.system_lookup = 'on'\"); }",
    "export async function lineComment(c: PoolClient) { await c.query('SET LOCAL -- scope\\n  app.portal_token_lookup = \\'on\\''); }",
    "export async function spacedDot(c: PoolClient) { await c.query(\"SET LOCAL app . current_tenant_id = 'x'\"); }",
    "// Known limits: a U&'…' name, the name concatenated in SQL.",
    "export async function uescape(c: PoolClient, t: string) { await c.query(\"SELECT set_config(U&'app.current_tenant_id', $1, true)\", [t]); }",
    "export async function sqlConcat(c: PoolClient, t: string) { await c.query(\"SELECT set_config('app.' || 'current_tenant_id', $1, true)\", [t]); }",
  ].join('\n'),
  // A named delegate hands the client on again (runStartTransaction → runSteps → …).
  'src/r3-two-hop.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "async function hop2(c: PoolClient) { await c.query('DELETE FROM invoices'); }",
    'async function steps(c: PoolClient) {',
    "  await c.query('SELECT 1');",
    '  await hop2(c);',
    '}',
    'export async function twoHop(pool: Pool) {',
    '  const client = await pool.connect();',
    '  try {',
    '    await steps(client);',
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
  ].join('\n'),
};

// ─── Negative controls, round 4: Function.prototype on a parameter, tx control, bracket access ─

const PLANTS_R4: Record<string, string> = {
  // Function.prototype.call / apply / bind on a PARAMETER runs the caller's function.
  'src/r4-function-methods.ts': [
    "import type { Pool, QueryResult } from 'pg';",
    'type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;',
    'export async function withQueryCall<T>(pool: Pool, fn: (q: Q) => Promise<T>): Promise<T> {',
    '  const client = await pool.connect();',
    '  try { return await fn.call(undefined, (sql: string, params?: unknown[]) => client.query(sql, params)); } finally { client.release(); }',
    '}',
    "export async function readViaCall(pool: Pool) { return withQueryCall(pool, (q) => q('SELECT * FROM customers')); }",
    'export async function withQueryApply<T>(pool: Pool, fn: (q: Q) => Promise<T>): Promise<T> {',
    '  const client = await pool.connect();',
    '  try { return await fn.apply(undefined, [(sql: string) => client.query(sql)]); } finally { client.release(); }',
    '}',
    "export async function readViaApply(pool: Pool) { return withQueryApply(pool, (q) => q('SELECT * FROM jobs')); }",
    'export async function withQueryBind<T>(pool: Pool, fn: (q: Q) => Promise<T>): Promise<T> {',
    '  const client = await pool.connect();',
    '  try { return await fn.bind(undefined, (sql: string) => client.query(sql))(); } finally { client.release(); }',
    '}',
    "export async function readViaBind(pool: Pool) { return withQueryBind(pool, (q) => q('SELECT * FROM leads')); }",
    'export async function withQueryBracketCall<T>(pool: Pool, fn: (q: Q) => Promise<T>): Promise<T> {',
    '  const client = await pool.connect();',
    "  try { return await fn['call'](undefined, (sql: string) => client.query(sql)); } finally { client.release(); }",
    '}',
    "export async function readViaBracketCall(pool: Pool) { return withQueryBracketCall(pool, (q) => q('SELECT * FROM invoices')); }",
  ].join('\n'),
  // Closures declared above connect() that only end the transaction, and one that reads.
  'src/r4-tx-control.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    '// ALLOWED: COMMIT / ROLLBACK [TO SAVEPOINT] / END / ABORT touch no table, so they are not a first effect.',
    'export async function cleanupAbove(pool: Pool, t: string, ok: boolean) {',
    '  let client: PoolClient | undefined;',
    "  const finish = async () => { await client?.query(ok ? 'COMMIT' : 'ROLLBACK'); };",
    "  const bail = async () => { await client?.query('ROLLBACK TO SAVEPOINT sp'); await client?.query('ABORT'); await client?.query('END'); };",
    '  try {',
    '    client = await pool.connect();',
    "    await client.query('BEGIN');",
    '    await applyTenantContext(client, t, { transactional: true });',
    "    const out = await client.query('SELECT * FROM customers');",
    '    await finish();',
    '    return out;',
    '  } catch (e) {',
    '    await bail();',
    '    throw e;',
    '  } finally {',
    '    client?.release();',
    '  }',
    '}',
    '// …but a read in such a closure still is.',
    'export async function readAbove(pool: Pool, t: string) {',
    '  let client: PoolClient | undefined;',
    "  const peek = async () => { await client?.query('SELECT id FROM customers LIMIT 1'); };",
    '  try {',
    '    client = await pool.connect();',
    "    await client.query('BEGIN');",
    '    await applyTenantContext(client, t, { transactional: true });',
    "    return await client.query('SELECT * FROM customers');",
    '  } catch (e) {',
    '    await peek();',
    '    throw e;',
    '  } finally {',
    '    client?.release();',
    '  }',
    '}',
  ].join('\n'),
  // A member named by bracket access: a literal key, or a const whose type is one literal.
  'src/r4-bracket-access.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    'interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }',
    "const K = 'query';",
    "async function readBracket(db: Queryable) { return db['query']('SELECT * FROM invoices'); }",
    "async function readConstKey(db: Queryable) { return db[K]('SELECT * FROM estimates'); }",
    'export async function viaBracket(pool: Pool) { return readBracket(pool); }',
    'export async function viaConstKey(pool: Pool) { return readConstKey(pool); }',
    "export async function anyConstKey(pool: Pool) { return (pool as any)[K]('SELECT * FROM leads'); }",
    'export async function bracketTables(pool: Pool) {',
    '  const client = await pool.connect();',
    "  try { return await client['query']('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    "async function peekBracket(c: PoolClient) { return c[K]('SELECT id FROM customers LIMIT 1'); }",
    'export async function bracketDelegateFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekBracket(client); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
  ].join('\n'),
  // A pool listener registered through bracket access.
  'src/r4-listener-bracket.ts': [
    "import type { Pool } from 'pg';",
    "const ON = 'on';",
    "export function onBracket(pool: Pool) { pool['on']('connect', (client) => { void client.query('DELETE FROM customers'); }); }",
    "export function onConstKey(pool: Pool) { pool[ON]('connect', (client) => { void client.query('DELETE FROM jobs'); }); }",
    "export function onOptional(pool?: Pool) { pool?.['on']('connect', (client) => { void client.query('DELETE FROM leads'); }); }",
  ].join('\n'),
  // The client inside an array or object literal behind a ternary, `??` / `||`, or an index.
  'src/r4-literal-branches.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    "const PEEK = 'SELECT id FROM customers LIMIT 1';",
    'async function peekA(c: PoolClient) { return c.query(PEEK); }',
    'async function peekArr(a: PoolClient[]) { return a[0].query(PEEK); }',
    'async function peekObj(o: { c: PoolClient }) { return o.c.query(PEEK); }',
    'export async function condArrayFirst(pool: Pool, t: string, flag: boolean) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekArr(flag ? [client] : []); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function nullishArrayFirst(pool: Pool, t: string, given?: PoolClient[]) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekArr(given ?? [client]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function orArrayFirst(pool: Pool, t: string, given: PoolClient[] | null) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekArr(given || [client]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function indexArrayFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekA([client][0]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function condObjectFirst(pool: Pool, t: string, flag: boolean) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekObj(flag ? { c: client } : { c: client }); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    '// ALLOWED: the same handoff after the context helper only has to be named.',
    'export async function condArrayAfter(pool: Pool, t: string, flag: boolean) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext(client, t, { transactional: true }); await peekArr(flag ? [client] : []); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
  ].join('\n'),
  // A Pool reaching a structural `query` through a property of a parameter, or through Function.prototype.
  'src/r4-param-property-escape.ts': [
    "import type { Pool } from 'pg';",
    'interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }',
    "async function readDeps(deps: { db: Queryable }) { return deps.db.query('SELECT * FROM customers'); }",
    "async function readDepsBracket(deps: { db: Queryable }) { return deps.db['query']('SELECT * FROM jobs'); }",
    "async function readCall(db: Queryable) { return db['query'].call(db, 'SELECT * FROM leads'); }",
    "async function readApply(db: Queryable) { return db.query.apply(db, ['SELECT * FROM invoices']); }",
    "async function readBind(db: Queryable) { return db.query.bind(db)('SELECT * FROM estimates'); }",
    'async function passDeps(deps: { db: Queryable }) { return readDeps(deps); }',
    'export async function viaDeps(pool: Pool) { return readDeps({ db: pool }); }',
    'export async function viaDepsBracket(pool: Pool) { return readDepsBracket({ db: pool }); }',
    'export async function viaCall(pool: Pool) { return readCall(pool); }',
    'export async function viaApply(pool: Pool) { return readApply(pool); }',
    'export async function viaBind(pool: Pool) { return readBind(pool); }',
    'export async function viaPassDeps(pool: Pool) { return passDeps({ db: pool }); }',
  ].join('\n'),
  // The client in a literal reached through an element or property access on a receiver that holds it.
  'src/r4-literal-access.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    "const PEEK = 'SELECT id FROM customers LIMIT 1';",
    'async function peekA(c: PoolClient | undefined) { return c?.query(PEEK); }',
    'export async function indexCondFirst(pool: Pool, t: string, flag: boolean) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekA((flag ? [client] : [client])[0]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function indexNullishFirst(pool: Pool, t: string, given?: PoolClient[]) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekA((given ?? [client])[0]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function indexOrFirst(pool: Pool, t: string, given: PoolClient[] | null) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekA((given || [client])[0]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function propCondFirst(pool: Pool, t: string, flag: boolean) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekA((flag ? { c: client } : { c: client }).c); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function doubleIndexFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekA([[client]][0][0]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function propIndexFirst(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await peekA({ all: [client] }.all[0]); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    '// ALLOWED: the same handoffs after the context helper only have to be named.',
    'export async function indexCondAfter(pool: Pool, t: string, flag: boolean) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext(client, t, { transactional: true }); await peekA((flag ? [client] : [client])[0]); await peekA({ all: [client] }.all[0]); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
  ].join('\n'),
  // A structurally typed parameter passed on in a shorthand property (`read({ db })`), like the longhand `{ db: db }`.
  'src/r4-shorthand-pass.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    'interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }',
    "async function readDb({ db }: { db: Queryable }) { return db.query('SELECT * FROM customers'); }",
    "async function readPath(deps: { db: Queryable }) { return deps.db.query('SELECT * FROM jobs'); }",
    "async function readNested(deps: { a: { db: Queryable } }) { return deps.a.db.query('SELECT * FROM leads'); }",
    'async function passShorthand(db: Queryable) { return readDb({ db }); }',
    'async function passPathShorthand(db: Queryable) { return readPath({ db }); }',
    'async function passPrefixShorthand(a: { db: Queryable }) { return readNested({ a }); }',
    'async function passLonghand(db: Queryable) { return readDb({ db: db }); }',
    'export async function viaShorthand(pool: Pool) { return passShorthand(pool); }',
    'export async function viaPathShorthand(pool: Pool) { return passPathShorthand(pool); }',
    'export async function viaPrefixShorthand(pool: Pool) { return passPrefixShorthand({ db: pool }); }',
    'export async function viaLonghand(pool: Pool) { return passLonghand(pool); }',
    '// The same shorthand passing a caller-supplied callback on to a raw-checkout helper.',
    'type Run = (c: PoolClient) => Promise<unknown>;',
    'async function withOpts(pool: Pool, opts: { run: Run }) {',
    '  const client = await pool.connect();',
    '  try { return await opts.run(client); } finally { client.release(); }',
    '}',
    'async function passRunShorthand(pool: Pool, run: Run) { return withOpts(pool, { run }); }',
    "export async function viaRunShorthand(pool: Pool) { return passRunShorthand(pool, async (c) => c.query('SELECT * FROM customers')); }",
  ].join('\n'),
  // A pool listener whose callee is parenthesised, non-null asserted or cast.
  'src/r4-listener-callee.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "export function onParenBracket(pool: Pool) { (pool['on'])('connect', (client) => { void client.query('DELETE FROM customers'); }); }",
    "export function onParenMember(pool: Pool) { (pool.on)('connect', (client) => { void client.query('DELETE FROM jobs'); }); }",
    "export function onNonNull(pool: Pool) { pool.on!('connect', (client) => { void client.query('DELETE FROM leads'); }); }",
    "export function onCast(pool: Pool) { (pool['on'] as Pool['on'])('connect', (client: PoolClient) => { void client.query('DELETE FROM invoices'); }); }",
  ].join('\n'),
  // The context helper handed an element or property of a literal that holds the client: it may be another client.
  'src/r4-context-literal.ts': [
    "import type { Pool, PoolClient } from 'pg';",
    "import { applyTenantContext } from './db/rls-runtime-role';",
    'export async function ctxIndexOfCond(pool: Pool, t: string, flag: boolean, other: PoolClient) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext((flag ? [client] : [other])[0], t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function ctxIndexLiteral(pool: Pool, t: string, other: PoolClient) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext([other, client][0], t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function ctxPropLiteral(pool: Pool, t: string, other: PoolClient) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext({ c: client, o: other }.o, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function ctxNullishIndex(pool: Pool, t: string, given?: PoolClient[]) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext((given ?? [client])[0], t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function ctxDoubleIndex(pool: Pool, t: string, other: PoolClient) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext([[other], [client]][0][0], t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function ctxPropOfCond(pool: Pool, t: string, flag: boolean, other: PoolClient) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext((flag ? { c: client } : { c: other }).c, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    '// ALLOWED: the client itself, and (a known limit) the client on a ternary branch.',
    'export async function ctxDirect(pool: Pool, t: string) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext(client, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
    'export async function ctxTernaryDirect(pool: Pool, t: string, flag: boolean, other: PoolClient) {',
    '  const client = await pool.connect();',
    "  try { await client.query('BEGIN'); await applyTenantContext(flag ? client : other, t, { transactional: true }); return await client.query('SELECT * FROM customers'); } finally { client.release(); }",
    '}',
  ].join('\n'),
};

describe('raw pg access vs. RLS (STRUCTURAL) — negative controls, rounds 3 and 4', () => {
  let plantDir = '';
  let planted: PgAccessSite[] = [];
  const inFile = (file: string): PgAccessSite[] => planted.filter((s) => s.file === file);
  const evalFile = (file: string, entries: RawPgSite[]): Report =>
    evaluate(inFile(file), entries, census, SANCTIONED_HELPERS.filter((h) => h.file === file));
  const clean = (): Report => evaluate([], [], census, []);

  beforeAll(() => {
    plantDir = plantTree('raw-pg-guard-r3', { ...PLANT_SUPPORT, ...PLANTS_R3, ...PLANTS_R4 });
    const { rootNames, compilerOptions } = plantProgramInputs(plantDir, API_DIR);
    planted = findPgAccess(rootNames, compilerOptions, { baseDir: plantDir });
  }, 120_000);

  afterAll(() => {
    if (plantDir) removeTree(plantDir);
  });

  it('R-order: SQL a delegate runs on the client before the context helper is the first effect', () => {
    const f = 'src/r3-pre-context-delegate.ts';
    const ctx = { access: 'pool.connect' as const, category: 'tenant_context_applied' as const, tables: ['customers'] };
    const entries = [
      entry({ file: f, fn: 'peekFirst', ...ctx, handsOffTo: ['peek'] }),
      entry({ file: f, fn: 'lockFirst', ...ctx, handsOffTo: ['lock'] }),
      entry({ file: f, fn: 'withPrincipal', access: 'pool.connect', category: 'global_table' }),
      entry({ file: f, fn: 'callbackPeekFirst', ...ctx, access: 'checkout-callback', handsOffTo: ['peek'] }),
      entry({ file: f, fn: 'InjectedPeek.run', ...ctx, handsOffTo: ['this.peeker.peek'] }),
      entry({ file: f, fn: 'objectArgFirst', ...ctx, handsOffTo: ['peekObj'] }),
      entry({ file: f, fn: 'callFirst', ...ctx, handsOffTo: ['peek.call'] }),
      entry({ file: f, fn: 'applyFirst', ...ctx, handsOffTo: ['<object>', 'peek.apply'] }),
      entry({ file: f, fn: 'reflectApplyFirst', ...ctx, handsOffTo: ['<object>', 'Reflect.apply'] }),
      entry({ file: f, fn: 'spreadFirst', ...ctx, handsOffTo: ['<object>', 'peek'] }),
      entry({ file: f, fn: 'tupleFirst', ...ctx, handsOffTo: ['<object>', 'peekTuple'] }),
      entry({ file: f, fn: 'nestedFirst', ...ctx, handsOffTo: ['<object>', 'peekNested'] }),
      entry({ file: f, fn: 'maybeBeginFirst', ...ctx, dynamicSql: true }),
      entry({ file: f, fn: 'beginThenReadFirst', ...ctx }),
    ];
    const r = evalFile(f, entries);
    expect(r.order.map((o) => `${o.split(' — ')[0]} ${/first effect at :\d+ \(.*?\)/.exec(o)?.[0]}`)).toEqual([
      'src/r3-pre-context-delegate.ts:6 [pool.connect] peekFirst first effect at :9 (SELECT id FROM customers LIMIT 1)',
      'src/r3-pre-context-delegate.ts:33 [checkout-callback] callbackPeekFirst first effect at :34 (SELECT id FROM customers LIMIT 1)',
      // Fails closed: an interface-typed injected dependency, the client inside
      // an object literal, Function.prototype.call — the body is not read.
      'src/r3-pre-context-delegate.ts:44 [pool.connect] InjectedPeek.run first effect at :47 (<unread delegate this.peeker.peek>)',
      'src/r3-pre-context-delegate.ts:57 [pool.connect] objectArgFirst first effect at :60 (<unread delegate peekObj>)',
      'src/r3-pre-context-delegate.ts:68 [pool.connect] callFirst first effect at :71 (<unread delegate peek.call>)',
      // …and the client inside an array literal (at any depth) or a spread of
      // one: Function.prototype.apply, Reflect.apply, f(...[c]), f([c, x]), f({ all: [c] }).
      'src/r3-pre-context-delegate.ts:80 [pool.connect] applyFirst first effect at :83 (<unread delegate peek.apply>)',
      'src/r3-pre-context-delegate.ts:93 [pool.connect] reflectApplyFirst first effect at :94 (<unread delegate Reflect.apply>)',
      'src/r3-pre-context-delegate.ts:97 [pool.connect] spreadFirst first effect at :98 (<unread delegate peek>)',
      'src/r3-pre-context-delegate.ts:101 [pool.connect] tupleFirst first effect at :102 (<unread delegate peekTuple>)',
      'src/r3-pre-context-delegate.ts:105 [pool.connect] nestedFirst first effect at :106 (<unread delegate peekNested>)',
      'src/r3-pre-context-delegate.ts:111 [pool.connect] maybeBeginFirst first effect at :113 (<non-literal SQL>)',
      'src/r3-pre-context-delegate.ts:121 [pool.connect] beginThenReadFirst first effect at :123 (BEGIN; SELECT id FROM customers LIMIT 1)',
    ]);
    // A delegate that only takes a lock before context still passes, and nothing else fires.
    expect({ ...r, order: [] }).toEqual(clean());
  });

  const closures = 'src/r3-closures.ts';
  const closureEntry = (fn: string, over: Partial<RawPgSite> = {}): RawPgSite =>
    entry({ file: closures, fn, access: 'pool.connect', category: 'global_table', ...over });
  /** Closures (round 4) that leave the checkout: the entry must list <closure>. */
  const leavingClosures = [
    'aliasPassed', 'aliasReturned', 'declaredAbove', 'letThenAssign', 'usedAboveDeclaration', 'insertAll', 'mapSet',
  ];
  const closuresAsGlobal = (): Report => evalFile(closures, [
    closureEntry('withQuery'), closureEntry('queryFactory'), closureEntry('deferred'),
    closureEntry('storedThenPassed'), closureEntry('calledInPlace'), closureEntry('anySql', { access: 'pool.query' }),
    ...[...leavingClosures, 'classExpr', 'unawaitedIife'].map((fn) => closureEntry(fn)),
  ]);

  it('a closure over a checked-out client that is passed, returned or stored is a <closure> handoff; handed to a callback it makes a helper', () => {
    expect(inFile(closures).map((s) => `${s.access} ${s.fn} ${JSON.stringify(s.handoffs ?? [])}`)).toEqual([
      'pool.connect withQuery []',
      'checkout-callback readViaQuery []',
      'pool.connect queryFactory ["<closure>"]',
      'pool.connect deferred ["<closure>"]',
      'pool.connect storedThenPassed ["<closure>"]',
      'pool.connect calledInPlace []',
      'pool.query anySql []',
      // An alias of a closure local, passed or returned.
      'pool.connect aliasPassed ["<closure>"]',
      'pool.connect aliasReturned ["<closure>"]',
      // Declared above connect() (a hoisted function, a let assigned later), or used above its declaration.
      'pool.connect declaredAbove ["<closure>"]',
      'pool.connect letThenAssign ["<closure>"]',
      'pool.connect usedAboveDeclaration ["<closure>"]',
      // A built-in callee (Array#map, Map#set) on a parameter is a plain <closure>,
      // not a raw-checkout helper slot: insertAll's caller importBatch is not a site.
      'pool.connect insertAll ["<closure>"]',
      'pool.connect mapSet ["<closure>"]',
      // Known limit: a class expression's method over the client is not seen.
      'pool.connect classExpr []',
      // By design: an IIFE runs in place, even unawaited (whether it outlives release() is review's).
      'pool.connect unawaitedIife []',
    ]);
    // The callback's calls of the query function it was handed are its SQL.
    expect(sqlTables(inFile(closures).find((s) => s.fn === 'readViaQuery')!.sql, census.known)).toEqual(['customers']);
    // A closure declared above connect() (or used above its declaration) has its SQL read too.
    expect(['declaredAbove', 'letThenAssign', 'usedAboveDeclaration'].map((fn) => inFile(closures).find((s) => s.fn === fn)!.sql)).toEqual([
      ['SELECT 2'], ['SELECT 3'], ['SELECT 4'],
    ]);
    const r = closuresAsGlobal();
    expect(r.unlisted.map((u) => u.split(' — ')[0])).toEqual(['src/r3-closures.ts:13 [checkout-callback] readViaQuery']);
    expect(r.handoffs).toEqual(['queryFactory', 'deferred', 'storedThenPassed', ...leavingClosures].map(
      (fn) => `src/r3-closures.ts :: ${fn} :: pool.connect: hands the client to <closure>, which handsOffTo does not name`,
    ));
  });

  const opaque = 'src/r3-opaque.ts';
  /** The eight spellings whose SQL text the scan cannot read, listed as an evader would. */
  const opaqueSpellings = ['concat', 'template', 'ternary', 'built', 'config', 'joined', 'checkoutConcat', 'delegateLabel'];
  const opaqueEntry = (fn: string, over: Partial<RawPgSite> = {}): RawPgSite =>
    entry({
      file: opaque, fn, category: 'global_table',
      access: fn === 'checkoutConcat' || fn === 'delegateLabel' || fn === 'delegateLiteral' ? 'pool.connect' : 'pool.query',
      ...(fn === 'delegateLabel' || fn === 'delegateLiteral' ? { handsOffTo: ['runRaw'] } : {}),
      ...over,
    });
  const readableEntries = [
    opaqueEntry('readable', { count: 4, category: 'tenant_filtered_no_rls', tables: ['customers'], migrateBy: '#0' }),
    opaqueEntry('delegateLiteral', { category: 'tenant_filtered_no_rls', tables: ['customers'], migrateBy: '#0' }),
  ];

  it('SQL whose text is not a literal (caller-supplied) must be declared dynamicSql, so it cannot pass as global_table with tables []', () => {
    expect(closuresAsGlobal().tables).toEqual(['withQuery :: pool.connect', 'queryFactory :: pool.connect', 'anySql :: pool.query'].map(
      (k) => `src/r3-closures.ts :: ${k}: runs SQL that is not a literal (caller-supplied or built), so its tables cannot be read; the entry must set dynamicSql`,
    ));
    // Readable is decided from the argument's structure, not from whether some
    // literal was found in it: a literal beside a parameter, a template or
    // ternary over one, a call, a query config, a delegate run on a caller's sql.
    expect(evalFile(opaque, [...opaqueSpellings.map((fn) => opaqueEntry(fn)), ...readableEntries]).tables).toEqual(opaqueSpellings.map(
      (fn) => `src/r3-opaque.ts :: ${fn} :: ${opaqueEntry(fn).access}: runs SQL that is not a literal (caller-supplied or built), so its tables cannot be read; the entry must set dynamicSql`,
    ));
    // Listing each one honestly (closures and dynamicSql declared) clears every rule.
    const listed = evalFile(closures, [
      closureEntry('withQuery', { dynamicSql: true }),
      closureEntry('queryFactory', { dynamicSql: true, handsOffTo: ['<closure>'] }),
      closureEntry('deferred', { handsOffTo: ['<closure>'] }),
      closureEntry('storedThenPassed', { handsOffTo: ['<closure>'] }),
      closureEntry('calledInPlace'),
      closureEntry('anySql', { access: 'pool.query', dynamicSql: true }),
      closureEntry('readViaQuery', { access: 'checkout-callback', category: 'tenant_filtered_no_rls', tables: ['customers'], migrateBy: '#0' }),
      ...leavingClosures.map((fn) => closureEntry(fn, { handsOffTo: ['<closure>'] })),
      closureEntry('classExpr'),
      closureEntry('unawaitedIife'),
    ]);
    expect(listed).toEqual(clean());
    expect(evalFile(opaque, [...opaqueSpellings.map((fn) => opaqueEntry(fn, { dynamicSql: true })), ...readableEntries])).toEqual(clean());
  });

  it('R-guc and member access: set_config before a spaced or wrapped paren, "app"."name" quoting, SQL comments, a spaced dot, pool?.[\'query\'], a union key naming a helper', () => {
    expect(inFile('src/r3-evasions.ts').map((s) => `${s.access}:${s.line} ${s.fn}`)).toEqual([
      'guc-only:3 spaced',
      'guc-only:4 newline',
      'guc-only:6 quotedParts',
      'pool.query:7 optionalPool',
      'indirect:10 UnionKeyRepo.run',
      'guc-only:18 quotedFn',
      'guc-only:19 commentParen',
      'guc-only:20 commentAfterSet',
      'guc-only:21 lineComment',
      'guc-only:22 spacedDot',
    ]);
    // Known limits, pinned so a fix updates the doc too: E'…', $$…$$, pg_settings,
    // a split literal, U&'…', SQL-side concatenation.
    expect(
      inFile('src/r3-evasions.ts').filter((s) => ['eString', 'dollar', 'pgSettings', 'split', 'uescape', 'sqlConcat'].includes(s.fn)),
    ).toEqual([]);
  });

  it("a one-hop delegate's own handoffs are the entry's too (`steps > hop2`); the second hop's SQL is left to review", () => {
    const f = 'src/r3-two-hop.ts';
    const base = { file: f, fn: 'twoHop', access: 'pool.connect' as const, category: 'global_table' as const };
    const r = evalFile(f, [entry({ ...base, handsOffTo: ['steps'] })]);
    expect(r.handoffs).toEqual([
      'src/r3-two-hop.ts :: twoHop :: pool.connect: hands the client to steps > hop2, which handsOffTo does not name',
    ]);
    // Known limit: hop2's DELETE FROM invoices is two hops away and not read.
    expect(r.tables).toEqual([]);
    expect(evalFile(f, [entry({ ...base, handsOffTo: ['steps', 'steps > hop2'] })])).toEqual(clean());
  });

  it("round 4: fn.call / fn.apply / fn.bind on a parameter is not a built-in: a closure handed through one makes a raw-checkout helper, and each caller is a site", () => {
    const f = 'src/r4-function-methods.ts';
    expect(inFile(f).map((s) => `${s.access} ${s.fn} ${JSON.stringify(s.handoffs ?? [])}`)).toEqual([
      'pool.connect withQueryCall []',
      `checkout-callback readViaCall ["callback (q) => q('SELECT * FROM customers').call"]`,
      'pool.connect withQueryApply []',
      `checkout-callback readViaApply ["callback (q) => q('SELECT * FROM jobs').apply"]`,
      'pool.connect withQueryBind []',
      `checkout-callback readViaBind ["callback (q) => q('SELECT * FROM leads').bind"]`,
      'pool.connect withQueryBracketCall []',
      `checkout-callback readViaBracketCall ["callback (q) => q('SELECT * FROM invoices').call"]`,
    ]);
    // Listing only the helpers (as an evader would) leaves every caller unlisted.
    const helpers = ['withQueryCall', 'withQueryApply', 'withQueryBind', 'withQueryBracketCall'].map((fn) =>
      entry({ file: f, fn, access: 'pool.connect', category: 'global_table', dynamicSql: true }),
    );
    expect(evalFile(f, helpers).unlisted.map((u) => u.split(' — ')[0])).toEqual([
      'src/r4-function-methods.ts:7 [checkout-callback] readViaCall',
      'src/r4-function-methods.ts:12 [checkout-callback] readViaApply',
      'src/r4-function-methods.ts:17 [checkout-callback] readViaBind',
      'src/r4-function-methods.ts:22 [checkout-callback] readViaBracketCall',
    ]);
  });

  it('round 4: a closure above connect() that only runs COMMIT / ROLLBACK / END / ABORT is not the first effect; a read in one still is', () => {
    const f = 'src/r4-tx-control.ts';
    const ctx = { file: f, access: 'pool.connect' as const, category: 'tenant_context_applied' as const, tables: ['customers'] };
    const r = evalFile(f, [entry({ ...ctx, fn: 'cleanupAbove' }), entry({ ...ctx, fn: 'readAbove' })]);
    expect(r.order.map((o) => `${o.split(' — ')[0]} ${/first effect at :\d+ \(.*?\)/.exec(o)?.[0]}`)).toEqual([
      'src/r4-tx-control.ts:27 [pool.connect] readAbove first effect at :25 (SELECT id FROM customers LIMIT 1)',
    ]);
    expect({ ...r, order: [] }).toEqual(clean());
    expect(inFile(f).find((s) => s.fn === 'cleanupAbove')!.order).toMatchObject({ contextFirst: true, contextLine: 11, firstEffect: { line: 12 } });
  });

  const bracket = 'src/r4-bracket-access.ts';
  const bracketEntries = [
    entry({ file: bracket, fn: 'bracketTables', access: 'pool.connect', category: 'global_table' }),
    entry({ file: bracket, fn: 'bracketDelegateFirst', access: 'pool.connect', category: 'tenant_context_applied', tables: ['customers'], handsOffTo: ['peekBracket'] }),
  ];

  it("round 4: db['query'] / db[K] in a structurally typed helper is a pool-escape, and (pool as any)[K] is R-any", () => {
    const sites = inFile(bracket).filter((s) => s.access !== 'pool.connect');
    expect(sites.map((s) => `${s.access}:${s.line} ${s.fn}`)).toEqual([
      'pool-escape:7 viaBracket',
      'pool-escape:8 viaConstKey',
      'any-receiver:9 anyConstKey',
    ]);
    // The escaped pool's SQL is the site's SQL.
    expect(sites.slice(0, 2).map((s) => sqlTables(s.sql, census.known))).toEqual([['invoices'], ['estimates']]);
    const r = evalFile(bracket, bracketEntries);
    expect(r.unlisted.map((u) => u.split(' — ')[0])).toEqual([
      'src/r4-bracket-access.ts:7 [pool-escape] viaBracket',
      'src/r4-bracket-access.ts:8 [pool-escape] viaConstKey',
    ]);
    expect(r.forbidden.map((u) => u.split(' — ')[0])).toEqual(['src/r4-bracket-access.ts:9 [any-receiver] anyConstKey']);
  });

  it("round 4: client['query'] / c[K] on a checked-out client is read like client.query (its tables, and R-order through a delegate)", () => {
    const r = evalFile(bracket, bracketEntries);
    expect(r.tables).toEqual([
      'src/r4-bracket-access.ts :: bracketTables :: pool.connect: SQL touches customers not in entry.tables []',
    ]);
    expect(r.order.map((o) => `${o.split(' — ')[0]} ${/first effect at :\d+ \(.*?\)/.exec(o)?.[0]}`)).toEqual([
      'src/r4-bracket-access.ts:16 [pool.connect] bracketDelegateFirst first effect at :17 (SELECT id FROM customers LIMIT 1)',
    ]);
  });

  it("round 4: pool['on'](…), pool[K](…) with K = 'on' and pool?.['on'](…) register a listener like pool.on: a checkout-callback site", () => {
    const f = 'src/r4-listener-bracket.ts';
    expect(inFile(f).map((s) => `${s.access}:${s.line} ${s.fn} ${s.owner}`)).toEqual([
      'checkout-callback:3 onBracket Pool.on',
      'checkout-callback:4 onConstKey Pool.on',
      'checkout-callback:5 onOptional Pool.on',
    ]);
    // The listener's SQL is the site's SQL, and an unlisted listener fails.
    expect(inFile(f).map((s) => sqlTables(s.sql, census.known))).toEqual([['customers'], ['jobs'], ['leads']]);
    expect(evalFile(f, []).unlisted).toHaveLength(3);
  });

  it('round 4: the client in an array or object literal behind a ternary, ?? / ||, or an index is a named handoff that fails R-order closed', () => {
    const f = 'src/r4-literal-branches.ts';
    const ctx = { file: f, access: 'pool.connect' as const, category: 'tenant_context_applied' as const, tables: ['customers'] };
    const entries = [
      entry({ ...ctx, fn: 'condArrayFirst', handsOffTo: ['<object>', 'peekArr'] }),
      entry({ ...ctx, fn: 'nullishArrayFirst', handsOffTo: ['<object>', 'peekArr'] }),
      entry({ ...ctx, fn: 'orArrayFirst', handsOffTo: ['<object>', 'peekArr'] }),
      entry({ ...ctx, fn: 'indexArrayFirst', handsOffTo: ['<object>', 'peekA'] }),
      entry({ ...ctx, fn: 'condObjectFirst', handsOffTo: ['<object>', 'peekObj'] }),
      entry({ ...ctx, fn: 'condArrayAfter', handsOffTo: ['<object>', 'peekArr'] }),
    ];
    const r = evalFile(f, entries);
    expect(r.order.map((o) => `${o.split(' — ')[0]} ${/first effect at :\d+ \(.*?\)/.exec(o)?.[0]}`)).toEqual([
      'src/r4-literal-branches.ts:8 [pool.connect] condArrayFirst first effect at :9 (<unread delegate peekArr>)',
      'src/r4-literal-branches.ts:12 [pool.connect] nullishArrayFirst first effect at :13 (<unread delegate peekArr>)',
      'src/r4-literal-branches.ts:16 [pool.connect] orArrayFirst first effect at :17 (<unread delegate peekArr>)',
      'src/r4-literal-branches.ts:20 [pool.connect] indexArrayFirst first effect at :21 (<unread delegate peekA>)',
      'src/r4-literal-branches.ts:24 [pool.connect] condObjectFirst first effect at :25 (<unread delegate peekObj>)',
    ]);
    // Each handoff is named, and after the context helper it only has to be.
    expect({ ...r, order: [] }).toEqual(clean());
  });

  it("round 4: a Pool reaching a structural query through a property of a parameter (deps.db.query, deps.db['query']) or Function.prototype (db['query'].call, .apply, .bind) is a pool-escape", () => {
    const f = 'src/r4-param-property-escape.ts';
    const sites = inFile(f);
    expect(sites.map((s) => `${s.access}:${s.line} ${s.fn} ${s.opaqueSql}`)).toEqual([
      'pool-escape:9 viaDeps false',
      'pool-escape:10 viaDepsBracket false',
      'pool-escape:11 viaCall false',
      'pool-escape:12 viaApply false',
      'pool-escape:13 viaBind false',
      'pool-escape:14 viaPassDeps false',
    ]);
    // The escaped pool's SQL is the site's SQL, read through .call / .apply / .bind too.
    expect(sites.map((s) => sqlTables(s.sql, census.known))).toEqual([
      ['customers'],
      ['jobs'],
      ['leads'],
      ['invoices'],
      ['estimates'],
      ['customers'],
    ]);
    expect(evalFile(f, []).unlisted).toHaveLength(6);
  });

  it('round 4: the client in a literal reached through an index or property on a receiver that holds it (a ternary, ?? / ||, a nested literal) fails R-order closed', () => {
    const f = 'src/r4-literal-access.ts';
    const ctx = { file: f, access: 'pool.connect' as const, category: 'tenant_context_applied' as const, tables: ['customers'] };
    const fns = ['indexCondFirst', 'indexNullishFirst', 'indexOrFirst', 'propCondFirst', 'doubleIndexFirst', 'propIndexFirst', 'indexCondAfter'];
    const r = evalFile(f, fns.map((fn) => entry({ ...ctx, fn, handsOffTo: ['<object>', 'peekA'] })));
    expect(r.order.map((o) => `${o.split(' — ')[0]} ${/first effect at :\d+ \(.*?\)/.exec(o)?.[0]}`)).toEqual([
      'src/r4-literal-access.ts:6 [pool.connect] indexCondFirst first effect at :7 (<unread delegate peekA>)',
      'src/r4-literal-access.ts:10 [pool.connect] indexNullishFirst first effect at :11 (<unread delegate peekA>)',
      'src/r4-literal-access.ts:14 [pool.connect] indexOrFirst first effect at :15 (<unread delegate peekA>)',
      'src/r4-literal-access.ts:18 [pool.connect] propCondFirst first effect at :19 (<unread delegate peekA>)',
      'src/r4-literal-access.ts:22 [pool.connect] doubleIndexFirst first effect at :23 (<unread delegate peekA>)',
      'src/r4-literal-access.ts:26 [pool.connect] propIndexFirst first effect at :27 (<unread delegate peekA>)',
    ]);
    // Each call is the named handoff peekA, and after the context helper it only has to be named.
    expect({ ...r, order: [] }).toEqual(clean());
    expect(inFile(f).find((s) => s.fn === 'indexCondAfter')!.order).toMatchObject({ contextFirst: true });
  });

  it('round 4: a parameter passed on in a shorthand property (read({ db }), withOpts(pool, { run })) is followed like the longhand { db: db }', () => {
    const f = 'src/r4-shorthand-pass.ts';
    const escapes = inFile(f).filter((s) => s.access === 'pool-escape');
    expect(escapes.map((s) => `${s.access}:${s.line} ${s.fn}`)).toEqual([
      'pool-escape:10 viaShorthand',
      'pool-escape:11 viaPathShorthand',
      'pool-escape:12 viaPrefixShorthand',
      'pool-escape:13 viaLonghand',
    ]);
    expect(escapes.map((s) => sqlTables(s.sql, census.known))).toEqual([['customers'], ['jobs'], ['leads'], ['customers']]);
    // A callback passed through the same way makes passRunShorthand a pass-through
    // helper: its caller is the site, and the callback's SQL is read.
    const helper = inFile(f).filter((s) => s.access !== 'pool-escape');
    expect(helper.map((s) => `${s.access}:${s.line} ${s.fn} ${JSON.stringify(s.handoffs ?? [])}`)).toEqual([
      'pool.connect:17 withOpts []',
      'checkout-callback:21 viaRunShorthand []',
    ]);
    expect(sqlTables(helper[1].sql, census.known)).toEqual(['customers']);
    const r = evalFile(f, [entry({ file: f, fn: 'withOpts', access: 'pool.connect', category: 'global_table' })]);
    expect(r.unlisted.map((u) => u.split(' — ')[0])).toEqual([
      'src/r4-shorthand-pass.ts:10 [pool-escape] viaShorthand',
      'src/r4-shorthand-pass.ts:11 [pool-escape] viaPathShorthand',
      'src/r4-shorthand-pass.ts:12 [pool-escape] viaPrefixShorthand',
      'src/r4-shorthand-pass.ts:13 [pool-escape] viaLonghand',
      'src/r4-shorthand-pass.ts:21 [checkout-callback] viaRunShorthand',
    ]);
  });

  it("round 4: a listener callee in parentheses, behind ! or cast ((pool['on'])(…), (pool.on)(…), pool.on!(…), (pool['on'] as Pool['on'])(…)) is read like pool.on", () => {
    const f = 'src/r4-listener-callee.ts';
    expect(inFile(f).map((s) => `${s.access}:${s.line} ${s.fn} ${s.owner}`)).toEqual([
      'checkout-callback:2 onParenBracket Pool.on',
      'checkout-callback:3 onParenMember Pool.on',
      'checkout-callback:4 onNonNull Pool.on',
      'checkout-callback:5 onCast Pool.on',
    ]);
    expect(inFile(f).map((s) => sqlTables(s.sql, census.known))).toEqual([['customers'], ['jobs'], ['leads'], ['invoices']]);
    expect(evalFile(f, []).unlisted).toHaveLength(4);
  });

  it('round 4: a context helper handed an index or property of a literal that holds the client (it may be another client) is an unread handoff that fails R-order closed', () => {
    const f = 'src/r4-context-literal.ts';
    const ctx = { file: f, access: 'pool.connect' as const, category: 'tenant_context_applied' as const, tables: ['customers'] };
    const evasions = ['ctxIndexOfCond', 'ctxIndexLiteral', 'ctxPropLiteral', 'ctxNullishIndex', 'ctxDoubleIndex', 'ctxPropOfCond'];
    const r = evalFile(f, [
      ...evasions.map((fn) => entry({ ...ctx, fn, handsOffTo: ['<object>', 'applyTenantContext'] })),
      entry({ ...ctx, fn: 'ctxDirect' }),
      entry({ ...ctx, fn: 'ctxTernaryDirect' }),
    ]);
    expect(r.order.map((o) => `${o.split(' — ')[0]} ${/first effect at :\d+ \(.*?\)/.exec(o)?.[0]}`)).toEqual([
      'src/r4-context-literal.ts:4 [pool.connect] ctxIndexOfCond first effect at :5 (<unread delegate applyTenantContext>)',
      'src/r4-context-literal.ts:8 [pool.connect] ctxIndexLiteral first effect at :9 (<unread delegate applyTenantContext>)',
      'src/r4-context-literal.ts:12 [pool.connect] ctxPropLiteral first effect at :13 (<unread delegate applyTenantContext>)',
      'src/r4-context-literal.ts:16 [pool.connect] ctxNullishIndex first effect at :17 (<unread delegate applyTenantContext>)',
      'src/r4-context-literal.ts:20 [pool.connect] ctxDoubleIndex first effect at :21 (<unread delegate applyTenantContext>)',
      'src/r4-context-literal.ts:24 [pool.connect] ctxPropOfCond first effect at :25 (<unread delegate applyTenantContext>)',
    ]);
    // Each is the named handoff applyTenantContext, not context; the client
    // itself (and, a known limit, on a ternary branch) still counts.
    expect({ ...r, order: [] }).toEqual(clean());
    expect(inFile(f).map((s) => `${s.fn} ${JSON.stringify(s.handoffs ?? [])} contextFirst=${s.order?.contextFirst}`)).toEqual([
      ...evasions.map((fn) => `${fn} ["<object>","applyTenantContext"] contextFirst=false`),
      'ctxDirect [] contextFirst=true',
      'ctxTernaryDirect [] contextFirst=true',
    ]);
  });
});
