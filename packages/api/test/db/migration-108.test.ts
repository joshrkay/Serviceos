import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 108 — voice_agent_live_at', () => {
  it('is registered in MIGRATIONS', () => {
    expect(MIGRATIONS['108_tenant_settings_voice_agent_live']).toMatch(
      /voice_agent_live_at\s+TIMESTAMPTZ/,
    );
  });

  it('matches on-disk SQL', () => {
    const sql = readFileSync(
      join(__dirname, '../../src/db/migrations/108_tenant_settings_voice_agent_live.sql'),
      'utf8',
    );
    expect(sql).toMatch(/voice_agent_live_at/);
  });
});
