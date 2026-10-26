/**
 * GATEWAY-05 — the RELEASE_LUA token-debt assertions run on every PR.
 *
 * The Redis quota store's release script carries an underestimate as debt
 * (down to -bucketCapacity) instead of forgiving it at zero. ioredis-mock
 * cannot run that Lua, so only a real Redis proves it. Those assertions lived
 * in redis-tenant-quota-two-instance.test.ts behind
 * `describe.skipIf(!TEST_REDIS_URL)`, which only the weekly
 * redis-multi-instance.yml sets, so a regression in RELEASE_LUA could merge and
 * stay green for up to a week.
 *
 * They now live in an integration test that starts its own `redis:7-alpine`
 * testcontainer when TEST_REDIS_URL is unset (the same Redis the integration
 * suite already starts for dispatch-presence-redis.test.ts), and PR CI's `test`
 * job runs the whole integration suite. This pins that chain so the assertion
 * cannot quietly fall back to a weekly-only run.
 *
 * Same string-assertion approach as the ci-workflow*.test.ts pins.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const apiRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(apiRoot, '../..');
const DEBT_TEST = 'test/integration/redis-tenant-quota-debt.test.ts';

const read = (p: string): string => fs.readFileSync(p, 'utf-8');

/** The `test:` job of pr-checks.yml, up to the next top-level job. */
function prTestJob(): string {
  const src = read(path.join(repoRoot, '.github/workflows/pr-checks.yml'));
  const start = src.search(/^ {2}test:\s*$/m);
  expect(start, 'pr-checks.yml test job').toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('GATEWAY-05 — the RELEASE_LUA debt assertions run in PR CI', () => {
  it('the debt cases live in an integration test with no skip gate', () => {
    const file = path.join(apiRoot, DEBT_TEST);
    expect(fs.existsSync(file), DEBT_TEST).toBe(true);
    const src = read(file);
    expect(src).toMatch(/carries an underestimate as debt/);
    expect(src).toMatch(/floors carried debt at -bucketCapacity/);
    // A skipped Redis suite is not a green gate (comments may name the old gate).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.skipIf\(|\.skip\(|\.todo\(/);
  });

  it('it brings its own Redis when TEST_REDIS_URL is unset (a redis:7-alpine testcontainer)', () => {
    const src = read(path.join(apiRoot, DEBT_TEST));
    expect(src).toMatch(/process\.env\.TEST_REDIS_URL/);
    expect(src).toMatch(/new GenericContainer\('redis:7-alpine'\)/);
  });

  it('the integration config picks it up', () => {
    const cfg = read(path.join(apiRoot, 'vitest.integration.config.mts'));
    expect(cfg).toMatch(/include:\s*\['test\/integration\/\*\*\/\*\.test\.ts'\]/);
  });

  it("pr-checks.yml's test job runs the integration suite in packages/api", () => {
    const job = prTestJob();
    expect(job).toMatch(/run: npm run test:integration\s*\n\s*working-directory: packages\/api/);
    expect(read(path.join(apiRoot, 'package.json'))).toMatch(
      /"test:integration": "RLS_RUNTIME_ROLE=true vitest run --config vitest\.integration\.config\.mts"/,
    );
  });

  it('the CI gating matrix says so: the debt cases gate in the PR integration job, not the weekly Redis job', () => {
    const rows = read(path.join(repoRoot, 'docs/launch/ci-gating.md')).split('\n');
    const integration = rows.find((l) => l.startsWith('| API integration (testcontainers) |'));
    const weekly = rows.find((l) => l.startsWith('| Redis multi-instance correctness |'));
    expect(integration, 'API integration row').toBeDefined();
    expect(weekly, 'Redis multi-instance row').toBeDefined();
    expect(integration).toContain(DEBT_TEST);
    expect(weekly).toMatch(/Not the quota token-debt gate: the RELEASE_LUA debt cases run on every PR/);
  });
});
