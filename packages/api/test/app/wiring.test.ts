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
});
