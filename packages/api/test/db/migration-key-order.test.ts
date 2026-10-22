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
  extractPinnedKeysFromSnapshot,
  GRANDFATHERED_KEYS,
  baseFetchArgs,
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

  it('a key the base snapshot still pins is a restoration, not a new key, even below the tail', () => {
    // 2026-10-22: a merge dropped '332_assignment_overlap_accepted' from main's
    // registry while the snapshot kept its pin; putting it back must pass.
    const base = ['331_a', '333_b', '334_c', '335_d'];
    const pinned = ['331_a', '332_restored', '333_b', '334_c', '335_d'];
    expect(validateAgainstBase([...base, '332_restored'], base, pinned)).toEqual([]);
    // ...but an unpinned key below the tail is still stale-fork numbering.
    expect(validateAgainstBase([...base, '332_other'], base, pinned)).toHaveLength(1);
  });

  it('extractPinnedKeysFromSnapshot reads snapshot rows only', () => {
    const src =
      "const SNAPSHOT = [\n" +
      "  ['332_assignment_overlap_accepted', 'eb06c6a9b4dc679fa9532a486a8941a19abcceb6e95875e0fb9d930b94eef471'],\n" +
      "  // ['333_commented_out', 'eb06c6a9b4dc679fa9532a486a8941a19abcceb6e95875e0fb9d930b94eef471'],\n" +
      "  ['334_next', 'a55ccb06da1509baa49df4ff5d76102e8f9ea2115ae2a3f28516b78e7966755c'],\n" +
      '];\n';
    expect(extractPinnedKeysFromSnapshot(src)).toEqual(['332_assignment_overlap_accepted', '334_next']);
  });

  it('extractKeysFromSource matches registry keys only, never SQL body text', () => {
    const src =
      "  '263_failure_monitor_indexes': `\n" +
      "    CREATE INDEX i ON t ('263_not_a_key');\n" +
      '  `,\n' +
      "  '264_next': `x`,\n";
    expect(extractKeysFromSource(src)).toEqual(['263_failure_monitor_indexes', '264_next']);
  });

  // `git fetch --depth=N` on a FULL clone writes `.git/shallow`, which every
  // worktree of that clone shares: afterwards `origin/main..HEAD` and
  // merge-base stop at the grafted commit in every worktree on the machine.
  // Only CI's checkout is already shallow, so only there may the fetch stay
  // depth-limited.
  it('fetches origin/main depth-limited only when the clone is already shallow', () => {
    expect(baseFetchArgs({ isShallowRepository: true })).toEqual([
      'fetch',
      '--depth=1',
      'origin',
      'main',
    ]);
    expect(baseFetchArgs({ isShallowRepository: false })).toEqual(['fetch', 'origin', 'main']);
  });
});
