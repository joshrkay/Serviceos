/**
 * #1736 — export the owners' pending "correct this call" entries into the
 * voice-quality corpus as regression cases.
 *
 * Usage (DATABASE_URL points at the production read/write DB):
 *   npm run voice-quality:export-corrections
 *
 * Writes scripts/13-owner-corrections/*.json + golden + placeholder cassettes
 * under src/ai/voice-quality/corpus, marks each correction exported, and
 * prints what to do next. PII redaction is best-effort: READ EVERY NEW SCRIPT
 * before committing, then run `npm run voice-quality:record` to record its
 * cassette.
 */
import * as path from 'path';
import { Pool } from 'pg';
import { exportPendingCorrections } from '../src/ai/voice-quality/corpus/export-corrections';
import { listAllTenantIds } from '../src/tenants/list-tenant-ids';
import { PgVoiceSessionGradeStore } from '../src/voice/quality/pg-voice-session-grade-store';
import { PgCallScoreStore } from '../src/voice/scoring/pg-call-score-store';

/** Resolves true when every pending correction was exported. */
async function main(): Promise<boolean> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await exportPendingCorrections(await listAllTenantIds(pool), {
      store: new PgCallScoreStore(pool),
      sessions: new PgVoiceSessionGradeStore(pool),
      corpusRoot: path.resolve(__dirname, '../src/ai/voice-quality/corpus'),
    });
    for (const e of result.exported) console.log(`exported ${e.scriptId} (tenant ${e.tenantId})`);
    for (const f of result.failed) console.error(`FAILED ${f.correctionId} (tenant ${f.tenantId}): ${f.reason}`);
    if (result.exported.length > 0) {
      console.log('\nNext: review the new scripts for leftover PII, `npm run voice-quality:record`, commit.');
    }
    return result.failed.length === 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
