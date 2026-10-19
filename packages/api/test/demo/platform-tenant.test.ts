import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';
import {
  DEMO_PLATFORM_TENANT_ID,
  DEMO_PLATFORM_OWNER_ID,
  DEMO_PLATFORM_OWNER_EMAIL,
} from '../../src/demo/platform-tenant';

/**
 * D1 — the platform tenant's identity is written twice: once as the
 * migration's INSERT literal (immutable once applied) and once as the
 * constant the code reads. They must never drift.
 */
describe('demo platform tenant constants', () => {
  const sql = MIGRATIONS['317_demo_calls'];

  it('the fixed uuid is the one migration 317 inserts', () => {
    expect(DEMO_PLATFORM_TENANT_ID).toBe('00000000-0000-4000-8000-00000000d3a0');
    expect(sql).toContain(`'${DEMO_PLATFORM_TENANT_ID}'`);
  });

  it('the synthetic owner id and non-deliverable email match the INSERT', () => {
    expect(sql).toContain(`'${DEMO_PLATFORM_OWNER_ID}'`);
    expect(sql).toContain(`'${DEMO_PLATFORM_OWNER_EMAIL}'`);
    expect(DEMO_PLATFORM_OWNER_EMAIL.endsWith('.invalid.rivet.local') || DEMO_PLATFORM_OWNER_EMAIL.includes('@invalid.')).toBe(true);
  });
});
