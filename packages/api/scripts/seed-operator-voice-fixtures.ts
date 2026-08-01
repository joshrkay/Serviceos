#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool } from '../src/db/pool';
import {
  runOperatorVoiceFixtureSeed,
  validateOperatorVoiceFixtureRunOptions,
} from '../src/seed/operator-voice-fixture-runner';

const CATALOG_PATH = resolve(
  __dirname,
  '../../../fixtures/voice/operator-voice-fixture-catalog.json',
);
const OUTSIDE_DEVELOPMENT_OVERRIDE =
  'ALLOW_OPERATOR_VOICE_FIXTURE_SEED_OUTSIDE_DEVELOPMENT';

async function main(): Promise<void> {
  const options = validateOperatorVoiceFixtureRunOptions({
    qaTenantId: process.env.QA_TENANT_ID,
    qaActorId: process.env.QA_ACTOR_ID,
    targetEnvironment:
      process.env.RAILWAY_ENVIRONMENT_NAME ??
      process.env.RAILWAY_ENVIRONMENT ??
      process.env.NODE_ENV,
    allowUnsafeTarget: process.env[OUTSIDE_DEVELOPMENT_OVERRIDE] === 'true',
  });
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const pool = createPool();
  try {
    const result = await runOperatorVoiceFixtureSeed(pool, catalog, options);
    process.stdout.write(
      [
        'Operator voice QA fixture seed complete.',
        `tenant: ${result.tenantId}`,
        `created: ${result.createdKeys.length}`,
        `reused: ${result.reusedKeys.length}`,
        `records: ${Object.keys(result.records).length}`,
      ].join('\n') + '\n',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `operator voice fixture seed failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
