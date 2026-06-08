/**
 * Feature 8 (security guard) — tenant isolation on call data.
 *
 * Call recordings, transcripts, and session context contain PII; cross-tenant
 * leakage is a regulatory issue, not just a bug. This is a fast, Docker-free
 * regression guard that the RLS policies are not silently dropped from the
 * schema. A full row-visibility integration test (with Postgres) lives under
 * vitest.integration.config.ts; this gate runs in the standard unit pass so a
 * dropped policy fails CI immediately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(resolve(here, '../../src/db/schema.ts'), 'utf8');

/** PII-bearing voice tables that must enforce per-tenant row isolation. */
const PII_TABLES = ['voice_recordings', 'call_transcript_turns', 'voice_sessions'];

describe('Feature 8 — RLS tenant isolation on call PII', () => {
  it.each(PII_TABLES)('%s has ROW LEVEL SECURITY enabled', (table) => {
    expect(schemaSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  });

  it.each(PII_TABLES)('%s has a tenant-isolation policy keyed on current_tenant_id', (table) => {
    const policy = new RegExp(
      `CREATE POLICY[\\s\\S]*?ON ${table}[\\s\\S]*?current_setting\\('app\\.current_tenant_id'\\)`,
    );
    expect(policy.test(schemaSql)).toBe(true);
  });
});
