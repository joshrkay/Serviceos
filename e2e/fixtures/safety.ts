/**
 * Production-DB safety guard for the ephemeral test-DB scripts.
 *
 * Refuses to run against any URL that looks like production. The journey
 * setup/seed/teardown scripts ALL truncate or drop data — running them
 * against the wrong DB would be catastrophic.
 *
 * Heuristic-only: name contains 'prod' / 'main' / 'production', or the
 * host matches the Railway public proxy pattern (shinkansen.proxy.rlwy.net,
 * containers-us-west, etc.) AND the database name is not obviously a test
 * DB. To override (e.g. you really do want to wipe a long-lived test DB),
 * set E2E_DB_ALLOW_UNSAFE=1.
 */
import { URL } from 'node:url';

export interface SafetyDecision {
  allowed: boolean;
  reason: string;
  url: string;
}

const PROD_NAME_PATTERNS = [/prod/i, /production/i, /\bmain\b/i, /\blive\b/i];
const SAFE_NAME_PATTERNS = [
  /test/i,
  /^e2e/i,
  /_e2e$/i,
  /ephemeral/i,
  /ci$/i,
  /^ci_/i,
  /serviceos_test/i,
];

export function checkDatabaseUrlSafety(rawUrl: string | undefined): SafetyDecision {
  if (!rawUrl) {
    return { allowed: false, reason: 'DATABASE_URL is not set', url: '' };
  }

  const redacted = redact(rawUrl);

  if (process.env.E2E_DB_ALLOW_UNSAFE === '1') {
    return {
      allowed: true,
      reason: 'E2E_DB_ALLOW_UNSAFE=1 — operator opted in',
      url: redacted,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'DATABASE_URL is not a valid URL', url: redacted };
  }

  const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const haystack = `${host} ${dbName}`;

  // Refuse if any prod marker appears anywhere
  for (const re of PROD_NAME_PATTERNS) {
    if (re.test(haystack)) {
      return {
        allowed: false,
        reason: `URL host or db name matches production pattern /${re.source}/`,
        url: redacted,
      };
    }
  }

  // Only allow if the db name explicitly opts into test usage. This is the
  // strictest gate — without it, an empty db name on a random Postgres host
  // would pass the prod-pattern check above.
  const isExplicitTest = SAFE_NAME_PATTERNS.some((re) => re.test(dbName));
  if (!isExplicitTest) {
    return {
      allowed: false,
      reason:
        `Database name '${dbName || '(empty)'}' is not recognized as a test DB. ` +
        `Use a name containing 'test', 'e2e', 'ephemeral', or 'ci', ` +
        `or set E2E_DB_ALLOW_UNSAFE=1 to override.`,
      url: redacted,
    };
  }

  return {
    allowed: true,
    reason: `Database name '${dbName}' matches a test-DB pattern`,
    url: redacted,
  };
}

/** Strip password from a postgres URL for logging. */
export function redact(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable URL)';
  }
}

export function exitIfUnsafe(decision: SafetyDecision): void {
  if (!decision.allowed) {
    console.error(`[safety] REFUSED: ${decision.reason}`);
    console.error(`[safety] URL (redacted): ${decision.url}`);
    console.error('[safety] These scripts will TRUNCATE data — refusing to run.');
    process.exit(2);
  }
  console.log(`[safety] OK — ${decision.reason}`);
  console.log(`[safety] Target: ${decision.url}`);
}
