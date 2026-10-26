/**
 * U7-04a (STRUCTURAL) — every `audit_events` write goes through the audit
 * repository (`src/audit/pg-audit.ts`).
 *
 * **The rule in one sentence:** no production module outside the audit
 * repository may hold SQL that writes `audit_events` (INSERT, MERGE or
 * COPY … FROM); a writer already inside a transaction calls the repository's
 * on-client insert, `insertAuditEventOnClient(client, event)`, so the row
 * still commits or rolls back with the caller's work.
 *
 * Why it matters: U7 (data-subject erasure, design 002a) puts a value probe
 * for late audit writes in the repository insert. Before this slice four
 * modules wrote their own `INSERT INTO audit_events` on a caller's client —
 * the card-number split rewrite (voice/pg-call-transcript-turn.ts), the
 * shadow-comparison purge (workers/shadow-comparison-retention-worker.ts), the
 * demo platform transaction (demo/platform-audit.ts) and the entity-alias
 * repository (learning/entity-aliases/pg-entity-alias.ts) — and a probe in the
 * repository would never have seen those rows. The repository holds exactly
 * two statements: `create` (its own tenant-scoped client) and the on-client
 * insert.
 *
 * The scan reads SQL text wherever it sits: string and template literals keep
 * their contents (`stripComments` blanks only comments), and a statement may
 * wrap across lines. Known limit: a table name the SQL text does not spell out
 * (`INSERT INTO ${table}`, a concatenated name) is invisible here; the raw-pg
 * guard (raw-pool-rls.structural.test.ts) is where dynamic SQL is declared and
 * reviewed.
 *
 * Evidence class: STRUCTURAL. The negative controls plant each write shape
 * into a temp tree and show the guard reporting it, and show the reads,
 * comments and look-alike tables it must not report.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  formatViolations,
  listSourceFiles,
  plantTree,
  removeTree,
  type Violation,
} from '../support/structural-scan';

const API_DIR = path.resolve(__dirname, '../..');
/** Production code: the app and its operator scripts. */
const ROOTS = [path.join(API_DIR, 'src'), path.join(API_DIR, 'scripts')];
const EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs'];

/** The one module allowed to hold audit_events write SQL. */
export const AUDIT_REPOSITORY_REL = 'src/audit/pg-audit.ts';
/** `PgAuditRepository.create` and `insertAuditEventOnClient`. */
const AUDIT_REPOSITORY_STATEMENTS = 2;

/** `audit_events`, optionally schema-qualified and/or quoted, never `audit_events_x`. */
const TABLE = String.raw`(?:"?public"?\s*\.\s*)?"?audit_events\b"?`;

/**
 * The write shapes, matched case-insensitively over the comment-stripped file
 * text, so a statement wrapped across lines (`INSERT INTO\n  audit_events`)
 * still matches. `COPY` counts only as `COPY … FROM` (a load); `COPY … TO` is
 * a read.
 */
const AUDIT_EVENTS_WRITE = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|MERGE\s+INTO)\s+${TABLE}|\bCOPY\s+${TABLE}(?:\s*\([^)]*\))?\s+FROM\b`,
  'gi',
);

/** Every audit_events write statement under `roots`, the repository's included. */
export function auditEventsWrites(roots: readonly string[]): Violation[] {
  const found: Violation[] = [];
  for (const file of listSourceFiles(roots, { extensions: EXTENSIONS })) {
    const textLines = file.text.split('\n');
    for (const match of file.code.matchAll(AUDIT_EVENTS_WRITE)) {
      const line = file.code.slice(0, match.index).split('\n').length;
      found.push({
        at: `${file.rel}:${line}`,
        file: file.rel,
        line,
        snippet: (textLines[line - 1] ?? '').trim(),
      });
    }
  }
  return found;
}

/** The writes outside the audit repository: each one is a violation. */
export function rawAuditEventsWrites(roots: readonly string[]): Violation[] {
  return auditEventsWrites(roots).filter((v) => v.file !== AUDIT_REPOSITORY_REL);
}

describe('U7-04a (STRUCTURAL) — audit_events is written only through the audit repository', () => {
  it('the sweep is not vacuous: it sees the repository statements', () => {
    expect(
      auditEventsWrites(ROOTS).filter((v) => v.file === AUDIT_REPOSITORY_REL).length,
    ).toBeGreaterThan(0);
  });

  it('no production module outside src/audit/pg-audit.ts writes audit_events SQL', () => {
    expect(
      formatViolations(rawAuditEventsWrites(ROOTS)),
      [
        'SQL that writes audit_events appeared outside the audit repository.',
        '',
        'Build the event with createAuditEvent and write it with',
        "insertAuditEventOnClient(client, event) from src/audit/pg-audit.ts on the caller's",
        'client (it stays in the same transaction), or with AuditRepository.create when',
        'there is no surrounding transaction.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the repository holds exactly its two statements: create and insertAuditEventOnClient', () => {
    // A third statement there would be a third insert path for the U7
    // late-write probe to miss; adding one must change this count in review.
    expect(
      auditEventsWrites(ROOTS)
        .filter((v) => v.file === AUDIT_REPOSITORY_REL)
        .map((v) => v.snippet),
    ).toHaveLength(AUDIT_REPOSITORY_STATEMENTS);
  });

  // ─── Negative controls ────────────────────────────────────────────────────

  it('NEGATIVE CONTROL — each planted write shape is reported, on the line it starts on', () => {
    const dir = plantTree('audit-events-raw-insert', {
      'src/single-line.ts': [
        'export async function a(client: { query(sql: string): Promise<unknown> }) {',
        "  await client.query('INSERT INTO audit_events (id) VALUES ($1)');",
        '}',
        '',
      ].join('\n'),
      'src/wrapped.ts': [
        'export const SQL = `',
        '  INSERT INTO',
        '    audit_events',
        '      (id, tenant_id) VALUES ($1, $2)`;',
        '',
      ].join('\n'),
      'src/qualified.ts': [
        'export const Q1 = "insert into public.audit_events (id) values ($1)";',
        "export const Q2 = 'INSERT INTO \"public\".\"audit_events\" (id) VALUES ($1)';",
        "export const Q3 = 'INSERT INTO \"audit_events\" (id) VALUES ($1)';",
        '',
      ].join('\n'),
      'src/cte.ts': [
        'export const CTE = `WITH moved AS (DELETE FROM x RETURNING id)',
        '  INSERT INTO audit_events (id) SELECT id FROM moved`;',
        '',
      ].join('\n'),
      'src/merge-copy.ts': [
        "export const M = 'MERGE INTO audit_events a USING s ON a.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)';",
        "export const C = 'COPY audit_events (id, tenant_id) FROM STDIN';",
        '',
      ].join('\n'),
      'src/audit/pg-audit-legacy.ts': [
        "export const LEGACY = 'INSERT INTO audit_events (id) VALUES ($1)';",
        '',
      ].join('\n'),
    });
    try {
      expect(rawAuditEventsWrites([path.join(dir, 'src')]).map((v) => v.at)).toEqual([
        // Exempt by exact path only: a sibling of the repository is not it.
        'src/audit/pg-audit-legacy.ts:1',
        'src/cte.ts:2',
        'src/merge-copy.ts:1',
        'src/merge-copy.ts:2',
        'src/qualified.ts:1',
        'src/qualified.ts:2',
        'src/qualified.ts:3',
        'src/single-line.ts:2',
        'src/wrapped.ts:2',
      ]);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (inverse) — reads, deletes, comments, COPY … TO and look-alike tables are not reported; the repository itself is exempt', () => {
    const dir = plantTree('audit-events-raw-insert-clean', {
      'src/audit/pg-audit.ts': [
        "export const CREATE = 'INSERT INTO audit_events (id) VALUES ($1)';",
        '',
      ].join('\n'),
      'src/reads.ts': [
        '/**',
        ' * This used to run `INSERT INTO audit_events (...)` itself; it now calls',
        ' * insertAuditEventOnClient.',
        ' */',
        '// INSERT INTO audit_events (id) VALUES ($1)',
        "export const READ = 'SELECT * FROM audit_events WHERE tenant_id = $1';",
        "export const PURGE = 'DELETE FROM audit_events WHERE tenant_id = $1';",
        "export const EXPORT = 'COPY audit_events TO STDOUT';",
        "export const ARCHIVE = 'INSERT INTO audit_events_archive (id) VALUES ($1)';",
        "export const OTHER = 'INSERT INTO ai_runs (id) VALUES ($1)';",
        '',
      ].join('\n'),
    });
    try {
      expect(rawAuditEventsWrites([path.join(dir, 'src')])).toEqual([]);
      expect(auditEventsWrites([path.join(dir, 'src')]).map((v) => v.at)).toEqual([
        'src/audit/pg-audit.ts:1',
      ]);
    } finally {
      removeTree(dir);
    }
  });
});
