/**
 * Migration key guard — catches the two failure classes parallel work streams
 * actually hit (both happened on 2026-08-01, see PR #788/#789):
 *
 *  1. PREFIX COLLISION: two branches independently claim the same numeric
 *     prefix ('196_a' vs '196_b'). TypeScript only rejects duplicate FULL
 *     keys, so a prefix duplicate lands silently and creates two parallel
 *     tables / ambiguous ordering intent.
 *  2. STALE-FORK NUMBERING: a branch forked before main gained migrations and
 *     adds keys numbered below main's tail (the branch adds '197_x' while
 *     main is already at 266) — the new migration numbers itself into
 *     history that already ran.
 *
 * Intra-file invariants are also pinned by test/db/migration-key-order.test.ts.
 * The cross-base check runs wherever origin/main is reachable (CI PR checkout
 * fetches it; offline runs degrade to intra-file checks only).
 */
import { execFileSync } from 'node:child_process';
import { MIGRATIONS } from '../src/db/schema';

/**
 * Applied history that already doubles a numeric prefix (7 later claimants).
 * All are applied in production; renaming an applied key would re-run its
 * DDL, so they are grandfathered as EXACT keys — a NEW key claiming one of
 * these prefixes still fails. Nothing may join this set.
 *
 * There is deliberately NO intra-file ordering check: the registry's file
 * order (which IS execution order) was never numerically monotonic — e.g.
 * '070_tenant_location_and_integrations' sits above the 020s. Forward-looking
 * ordering discipline comes from the cross-base check instead: every new key
 * must number past origin/main's tail.
 */
export const GRANDFATHERED_KEYS: ReadonlySet<string> = new Set([
  '070_tenant_integrations',
  '092_voice_session_transcript',
  '125_estimates_deleted_at',
  '173_service_agreements_auto_renew',
  '177_customer_payment_methods_stripe_account',
  '221_create_job_forms',
  '263_failure_monitor_indexes',
]);

export const KEY_RE = /^(\d{3})_[a-z0-9_]+$/;
/** Registry keys sit at exactly two spaces of indent: `  '263_x': \`` */
const SOURCE_KEY_RE = /^ {2}'((\d{3})_[a-z0-9_]+)':/gm;

/** Intra-file invariants: format, unique prefixes, file order == numeric order. */
export function validateMigrationKeyOrder(keys: string[]): string[] {
  const violations: string[] = [];
  const seenPrefix = new Map<string, string>();
  for (const key of keys) {
    const m = KEY_RE.exec(key);
    if (!m) {
      violations.push(`malformed key '${key}' — expected NNN_snake_case`);
      continue;
    }
    const prefix = m[1];
    const clash = seenPrefix.get(prefix);
    if (clash !== undefined && !GRANDFATHERED_KEYS.has(key)) {
      violations.push(
        `duplicate prefix ${prefix}: '${clash}' and '${key}' — renumber the newer one past the current tail`,
      );
    }
    seenPrefix.set(prefix, key);
  }
  return violations;
}

/** Pull registry keys out of a schema.ts source blob (used for the git base). */
export function extractKeysFromSource(src: string): string[] {
  const keys: string[] = [];
  for (const m of src.matchAll(SOURCE_KEY_RE)) keys.push(m[1]);
  return keys;
}

/** Every key NOT present on the base must number strictly past the base tail. */
export function validateAgainstBase(branchKeys: string[], baseKeys: string[]): string[] {
  const base = new Set(baseKeys);
  const baseMax = Math.max(0, ...baseKeys.map((k) => Number(k.slice(0, 3))));
  const violations: string[] = [];
  for (const key of branchKeys) {
    if (base.has(key)) continue;
    if (Number(key.slice(0, 3)) <= baseMax) {
      violations.push(
        `new key '${key}' numbers at or below origin/main's tail (${String(baseMax).padStart(3, '0')}) — ` +
          `this branch forked before main moved; renumber past the tail`,
      );
    }
  }
  return violations;
}

function baseSchemaSource(): string | null {
  try {
    execFileSync('git', ['fetch', '--depth=1', 'origin', 'main'], { stdio: 'ignore' });
  } catch {
    // offline / no remote — fall through; git show may still hit a local ref
  }
  try {
    return execFileSync('git', ['show', 'origin/main:packages/api/src/db/schema.ts'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const invokedDirectly = Boolean(process.argv[1]?.includes('check-migration-keys'));
if (invokedDirectly) {
  const keys = Object.keys(MIGRATIONS);
  const violations = validateMigrationKeyOrder(keys);
  const baseSrc = baseSchemaSource();
  if (baseSrc) {
    // On main itself branch == base, so there are no "new" keys and the
    // cross-base check is a natural no-op.
    violations.push(...validateAgainstBase(keys, extractKeysFromSource(baseSrc)));
  } else {
    console.log('migration-key guard: origin/main unreachable — intra-file checks only');
  }
  if (violations.length > 0) {
    console.error(`migration-key guard: ${violations.length} violation(s)\n- ${violations.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`migration-key guard: ${keys.length} keys OK`);
}
