export function requireReleaseCredentials(env) {
  for (const [key, prefix] of [
    ['E2E_CLERK_PUBLISHABLE_KEY', 'pk_test_'],
    ['E2E_CLERK_SECRET_KEY', 'sk_test_'],
  ]) {
    if (!env[key]?.startsWith(prefix)) throw new Error(`${key} must be a Clerk development key`);
  }
}

export function verifyReleaseResults(stats, errors = []) {
  if (!Number.isInteger(stats?.expected) || stats.expected < 1 ||
      ['skipped', 'unexpected', 'flaky'].some(key => !Number.isInteger(stats[key]) || stats[key] !== 0) ||
      errors.length > 0) {
    throw new Error('Release verification requires executed tests, zero failures, zero skips, zero retries passing after failure, and zero runner errors');
  }
}

