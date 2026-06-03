/**
 * P0-023 — app-wiring static-source assertion.
 *
 * Loads packages/api/src/app.ts as text and asserts that each of the six
 * Wave 1A entities is wired through the standard `pool ? Pg : InMemory`
 * ternary. We deliberately do not boot the app — booting requires Pg in
 * staging/prod (and a stubbed pool in dev). A source-level check is
 * cheaper, faster, and immune to future side effects in createApp().
 *
 * If a regression renames either the Pg or InMemory class, or accidentally
 * drops the ternary (e.g. by re-introducing a bare `new InMemoryX()`), this
 * test fails with the offending entity name.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('P0-023 — app-wiring (pool ternary coverage)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

  it.each([
    ['Assignment', 'PgAssignmentRepository', 'InMemoryAssignmentRepository'],
    ['WebhookEvent', 'PgWebhookEventRepository', 'InMemoryWebhookEventRepository'],
    ['DocumentRevision', 'PgDocumentRevisionRepository', 'InMemoryDocumentRevisionRepository'],
    ['DiffAnalysis', 'PgDiffAnalysisRepository', 'InMemoryDiffAnalysisRepository'],
    ['DispatchAnalytics', 'PgDispatchAnalyticsRepository', 'InMemoryDispatchAnalyticsRepository'],
    ['DelayNoticeState', 'PgDelayNoticeStateRepository', 'InMemoryDelayNoticeStateRepository'],
  ])('%s repo wired through pool ternary', (_label, pgClass, inMemoryClass) => {
    expect(src).toContain(pgClass);
    expect(src).toContain(inMemoryClass);
    const ternaryPattern = new RegExp(
      `pool\\s*\\?\\s*new\\s+${pgClass}[\\s\\S]*?:\\s*new\\s+${inMemoryClass}`,
      'm',
    );
    expect(src).toMatch(ternaryPattern);
  });

  it('graceful shutdown registers SIGTERM/SIGINT pool drain', () => {
    expect(src).toMatch(/process\.once\(\s*['"]SIGTERM['"]/);
    expect(src).toMatch(/process\.once\(\s*['"]SIGINT['"]/);
    expect(src).toMatch(/pool\.end\(\)/);
  });

  it('pool initialization is gated on DATABASE_URL', () => {
    expect(src).toMatch(/process\.env\.DATABASE_URL\s*\?\s*createPool\(\)/);
  });

  // Blocker 5 — graceful shutdown stops background loops before draining the
  // pool, and tenant-wide sweeps are leader-elected via a Postgres advisory
  // lock so they don't duplicate on multi-instance deploys.
  describe('Blocker 5 — background-loop lifecycle + leader election', () => {
    it('shutdown clears all registered background intervals before pool drain', () => {
      expect(src).toMatch(/const\s+backgroundIntervals\s*:\s*NodeJS\.Timeout\[\]/);
      expect(src).toMatch(/registerInterval\(setInterval\(/);
      expect(src).toMatch(/for\s*\(const\s+handle\s+of\s+backgroundIntervals\)\s*clearInterval\(handle\)/);
      // The clearInterval loop must run inside the shutdown handler, before pool.end().
      const shutdownIdx = src.indexOf('const shutdown = async (signal');
      const clearIdx = src.indexOf('for (const handle of backgroundIntervals)');
      const poolEndIdx = src.indexOf('pool.end()');
      expect(shutdownIdx).toBeGreaterThan(-1);
      expect(clearIdx).toBeGreaterThan(shutdownIdx);
      expect(poolEndIdx).toBeGreaterThan(clearIdx);
    });

    it('a shuttingDown guard gates new sweep work', () => {
      expect(src).toMatch(/let\s+shuttingDown\s*=\s*false/);
      expect(src).toMatch(/shuttingDown\s*=\s*true/);
      expect(src).toMatch(/if\s*\(shuttingDown\)\s*return/);
    });

    it('tenant-wide sweeps are wrapped in runAsLeader with a pg advisory lock', () => {
      expect(src).toMatch(/pg_try_advisory_lock/);
      expect(src).toMatch(/pg_advisory_unlock/);
      // Each of the six tenant-wide sweeps is gated by a distinct lock key.
      for (const key of [
        'recurringAgreements',
        'overdueInvoice',
        'appointmentReminder',
        'estimateReminder',
        'estimateExpiry',
        'googleReviews',
      ]) {
        expect(src).toMatch(new RegExp(`runAsLeader\\(SWEEP_LOCK\\.${key}`));
      }
    });
  });
});
