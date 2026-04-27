import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import { findRow, type MatrixRow } from '../matrix';
import { RowEvidence } from './evidence';
import { ApiVerifier } from './api-verifier';
import { DbVerifier } from './db-verifier';
import { apiBase, dbUrl, tenantA, tenantB, type TenantFixture } from '../fixtures/tokens';

export { test, expect };

export interface RowHarness {
  row: MatrixRow;
  evidence: RowEvidence;
  api: ApiVerifier;
  db: DbVerifier;
  page: Page;
  tenantA: TenantFixture;
  tenantB: TenantFixture;
  /** Capture a screenshot and record it as a UI artifact. */
  snapshot(label: string, fullPage?: boolean): Promise<void>;
}

export async function setupRow(
  id: string,
  request: APIRequestContext,
  page: Page,
  opts: { loadTenantB?: boolean } = {}
): Promise<RowHarness> {
  const row = findRow(id);
  if (!row) throw new Error(`Unknown matrix row: ${id}`);
  const evidence = new RowEvidence(row);
  const api = new ApiVerifier(request, apiBase(), evidence);
  const db = new DbVerifier(dbUrl(), evidence);
  const h: RowHarness = {
    row,
    evidence,
    api,
    db,
    page,
    tenantA: tenantA(),
    tenantB: opts.loadTenantB === false ? ({} as TenantFixture) : tenantB(),
    async snapshot(label: string, fullPage = true) {
      const path = join(evidence.uiDir(), `${label}.png`);
      try {
        await page.screenshot({ path, fullPage });
        evidence.addArtifact({ kind: 'ui', path, label: `UI ${label}` });
      } catch (err) {
        evidence.note(`screenshot ${label} failed: ${(err as Error).message}`);
      }
    },
  };
  return h;
}

export async function teardownRow(harness: RowHarness): Promise<void> {
  harness.evidence.finalize();
  await harness.db.close();
}

/**
 * Declares a matrix test. Body receives a harness plus Playwright's page.
 * Verdict must be set on harness.evidence (pass/partial/fail/na). If the
 * body throws before setting a verdict, the row is recorded as 'fail' with
 * the error message.
 */
export function matrixTest(
  id: string,
  title: string,
  body: (h: RowHarness) => Promise<void>,
  opts: { loadTenantB?: boolean } = {}
): void {
  test(`${id} — ${title}`, async ({ request, page }) => {
    const harness = await setupRow(id, request, page, opts);
    try {
      await body(harness);
    } catch (err) {
      if (harness.evidence.verdict === 'fail' && !harness.evidence.failureReason) {
        harness.evidence.fail(`Uncaught error: ${(err as Error).message}`);
      }
      throw err;
    } finally {
      await teardownRow(harness);
    }
  });
}
