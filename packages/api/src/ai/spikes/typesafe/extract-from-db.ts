/**
 * Extract scrubbed caller utterances from a NON-PRODUCTION database for the
 * TypeSafe frustration spike. Read-only (see pg-source.ts).
 *
 *   DATABASE_URL=postgres://...staging... npx tsx src/ai/spikes/typesafe/extract-from-db.ts \
 *     --tenant <uuid> --from 2026-09-15 --to 2026-10-15 --out utterances.txt \
 *     --confirm-non-prod [--limit 400] [--seed 1]
 *
 * The output still needs a human skim (names are not scrubbed) before it is fed
 * to sample-for-labeling.ts, which sends it to api.typesafe.ai.
 */
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { extractFrustrationUtterances, toUtterancesFile } from './extract-utterances';
import { PgUtteranceSource } from './pg-source';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const tenantId = arg('tenant');
  const from = arg('from');
  const to = arg('to');
  const out = arg('out');
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!tenantId || !from || !to || !out) {
    throw new Error('usage: --tenant <uuid> --from <date> --to <date> --out <file> --confirm-non-prod');
  }
  if (!process.argv.includes('--confirm-non-prod')) {
    throw new Error('refusing to run without --confirm-non-prod (point DATABASE_URL at staging or a replica)');
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) throw new Error('invalid --from/--to');

  const host = new URL(url).host; // log host only — never credentials
  console.log(`reading from ${host}, tenant ${tenantId}, ${from} → ${to}`);

  const pool = new Pool({ connectionString: url, max: 1, ssl: process.env.DB_SSL === 'false' ? false : undefined });
  try {
    const rows = await extractFrustrationUtterances(new PgUtteranceSource(pool), {
      tenantId,
      from: fromMs,
      to: toMs,
      limit: Number(arg('limit') ?? 400),
      seed: Number(arg('seed') ?? 1),
    });
    writeFileSync(out, toUtterancesFile(rows));
    const fired = rows.filter((r) => r.firedBaseline).length;
    console.log(`wrote ${rows.length} utterances (${fired} where the baseline fired) -> ${out}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
