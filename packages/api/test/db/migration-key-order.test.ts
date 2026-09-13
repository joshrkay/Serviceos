/**
 * Migration key guard — intra-file invariants for the MIGRATIONS registry.
 * The cross-base (stale-fork numbering) half lives in
 * scripts/check-migration-keys.ts and runs in PR CI where origin/main is
 * fetchable; its pure validators are unit-tested here.
 */
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';
import {
  validateMigrationKeyOrder,
  validateAgainstBase,
  extractKeysFromSource,
  GRANDFATHERED_KEYS,
} from '../../scripts/check-migration-keys';

describe('migration key guard', () => {
  it('the live MIGRATIONS registry has no collisions or ordering violations', () => {
    expect(validateMigrationKeyOrder(Object.keys(MIGRATIONS))).toEqual([]);
  });

  it('rejects a duplicate numeric prefix (parallel branches claiming the same number)', () => {
    const v = validateMigrationKeyOrder(['270_a', '271_b', '271_c']);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('duplicate prefix 271');
  });

  it('grandfathers exactly the 7 applied historical prefix doubles, nothing new', () => {
    expect(GRANDFATHERED_KEYS.size).toBe(7);
    // A THIRD claimant of an already-doubled prefix still fails — the
    // grandfather list is exact keys, not prefixes.
    const v = validateMigrationKeyOrder([
      '070_tenant_location_and_integrations',
      '070_tenant_integrations',
      '070_third_claimant',
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("'070_third_claimant'");
  });

  it('rejects malformed keys', () => {
    expect(validateMigrationKeyOrder(['27_too_short'])).toHaveLength(1);
    expect(validateMigrationKeyOrder(['270-dashed'])).toHaveLength(1);
  });

  it('stale-fork numbering: a NEW key at or below the base tail is a violation', () => {
    const base = ['264_x', '265_y', '266_z'];
    const v = validateAgainstBase([...base, '196_mine'], base);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("'196_mine'");
    expect(validateAgainstBase([...base, '267_mine'], base)).toEqual([]);
  });

  it('extractKeysFromSource matches registry keys only, never SQL body text', () => {
    const src =
      "  '263_failure_monitor_indexes': `\n" +
      "    CREATE INDEX i ON t ('263_not_a_key');\n" +
      '  `,\n' +
      "  '264_next': `x`,\n";
    expect(extractKeysFromSource(src)).toEqual(['263_failure_monitor_indexes', '264_next']);
  });
});
