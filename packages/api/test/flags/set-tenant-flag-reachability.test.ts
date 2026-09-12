/**
 * #1011 (wayfinder map #995) — `setTenantFlag` reachability.
 *
 * `PgTenantFeatureFlagRepository.setTenantFlag` is the per-tenant capability
 * WRITER. Before this ticket it had **zero production call sites**: the method
 * existed, was unit-tested, and no route could ever reach it, so an owner could
 * not turn on `dropped_call_recovery` (row 2.7) or `voice_vulnerability_triage`
 * (row 2.6) — only a platform admin ramping `tenantIds` through
 * `PUT /api/admin/feature-flags/:name` could.
 *
 * §12.4c published that as a grep. This file makes it a permanent guard, in
 * both directions:
 *
 *  - the writer is reachable from EXACTLY ONE route file, and
 *  - no other file writes `tenant_feature_flags` directly.
 *
 * The second assertion is the one with teeth over time: a tenant override WINS
 * over the platform flag (pg-tenant-feature-flags.ts:145-147), so a second,
 * un-audited writer to that table is a way to switch off a safety gate with no
 * audit row behind it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import express from 'express';
import { buildRouteManifest } from '../../src/app-route-manifest';
import { createSettingsRouter } from '../../src/routes/settings';
import { InMemorySettingsRepository } from '../../src/settings/settings';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

/** Every .ts file under packages/api/src, as repo-relative paths. */
function sourceFiles(dir: string = SRC_ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = sourceFiles();

function filesMatching(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC_ROOT, f))
    .sort();
}

/** Where the method is DEFINED — never a call site. */
const DEFINITION = 'flags/pg-tenant-feature-flags.ts';

describe('#1011 — setTenantFlag is reachable from exactly one route', () => {
  it('negative control: the grep finds real call sites for a wired sibling', () => {
    // If this ever returns [], the walker or the pattern is broken and every
    // other assertion in this file is vacuously true.
    const readers = filesMatching(/\.isEnabledForTenant\(/).filter(
      (f) => f !== DEFINITION,
    );
    expect(readers.length).toBeGreaterThan(0);
  });

  it('has exactly one production call site, and it is routes/settings.ts', () => {
    const callers = filesMatching(/\.setTenantFlag\(/).filter((f) => f !== DEFINITION);
    expect(callers).toEqual(['routes/settings.ts']);
  });

  it('PERMANENT GUARD: no file other than the repository writes tenant_feature_flags', () => {
    // Any INSERT/UPDATE/DELETE naming the table. A second writer must go
    // through the repository (and therefore through its RLS-scoped
    // `withTenant`), never straight at the table.
    const writers = filesMatching(
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+tenant_feature_flags/i,
    );
    expect(writers).toEqual([DEFINITION]);
  });
});

/**
 * Structural companion (D12). The capability routes live INSIDE the existing
 * `/api/settings` router, so they inherit its mount — and its exposure class.
 * This asserts that directly rather than trusting the mount: a route registered
 * in front of `requireAuth`, or promoted to its own top-level mount, changes
 * the answer here before it changes anything a type check can see.
 */
describe('#1011 — the capability routes sit behind the settings mount', () => {
  const manifest = (() => {
    const app = express();
    app.use('/api/settings', createSettingsRouter(new InMemorySettingsRepository()));
    return buildRouteManifest(app);
  })();

  const settingsEntry = manifest.entries.find((e) => e.path === '/api/settings');

  it('registers both capability routes as children of /api/settings', () => {
    expect(settingsEntry).toBeDefined();
    expect(settingsEntry!.children).toContain('GET /capabilities');
    expect(settingsEntry!.children).toContain('PUT /capabilities/:key');
  });

  it('classifies the mount carrying them as authenticated', () => {
    expect(settingsEntry!.exposure).toBe('authenticated');
  });

  it('adds NO new top-level mount (D12 — the D-022/D-024 review stays narrow)', () => {
    const mounts = manifest.entries.filter((e) => e.kind === 'router').map((e) => e.path);
    expect(mounts).toEqual(['/api/settings']);
  });
});
