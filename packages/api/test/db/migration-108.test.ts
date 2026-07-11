import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

// The .sql file under src/db/migrations/ was a documentation copy only
// (never executed at runtime — see docs/runbooks/migration-discipline.md)
// and was removed 2026-07; MIGRATIONS in schema.ts is the sole source of
// truth, so this test asserts against it directly.
describe('Migration 108 — voice_agent_live_at', () => {
  it('is registered in MIGRATIONS', () => {
    expect(MIGRATIONS['108_tenant_settings_voice_agent_live']).toMatch(
      /voice_agent_live_at\s+TIMESTAMPTZ/,
    );
  });
});
