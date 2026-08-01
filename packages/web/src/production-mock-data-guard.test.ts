import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Fixture arrays / live mock data must not ship in production UI modules.
 * Types live in `types/job-ui.ts` and `types/assistant-ui.ts` only.
 */
const TYPE_MODULES = ['types/job-ui.ts', 'types/assistant-ui.ts'] as const;

const ROUTED_COMPONENTS = [
  'components/jobs/NewJobFlow.tsx',
  'components/jobs/JobDetail.tsx',
  // Job detail sheets (estimate/invoice/text/call) — reached from routed job
  // pages; must fetch real docs, never render fixture estimates/invoices.
  'components/jobs/JobSheets.tsx',
  'components/schedule/SchedulePage.tsx',
  'components/estimates/NewEstimateFlow.tsx',
  'components/estimates/EstimatesPage.tsx',
  'components/invoices/InvoicesPage.tsx',
  // Public, unauthenticated customer page — must never render fixture data
  // (it would leak another customer's details). See Blocker 8.
  'components/customer/EstimateApprovalPage.tsx',
];

/** Any import of the deleted mock-data module is forbidden. */
const MOCK_DATA_IMPORT = /from\s+['"][^'"]*mock-data['"]/;

/** Value exports that look like fixture arrays (not types/interfaces). */
const FIXTURE_ARRAY_EXPORT =
  /export\s+const\s+\w+\s*:\s*\w+(\[\])?\s*=\s*\[/;

describe('production UI type modules', () => {
  it.each(TYPE_MODULES)('%s exists and exports types only (no fixture arrays)', (relPath) => {
    const abs = join(__dirname, relPath);
    expect(existsSync(abs)).toBe(true);
    const src = readFileSync(abs, 'utf8');
    expect(src).not.toMatch(FIXTURE_ARRAY_EXPORT);
    // No runtime data helpers either — calcs live in utils/.
    expect(src).not.toMatch(/export\s+function\s+calc/);
  });

  it('legacy data/mock-data.ts is gone', () => {
    expect(existsSync(join(__dirname, 'data/mock-data.ts'))).toBe(false);
  });
});

describe('production mock-data guard', () => {
  it.each(ROUTED_COMPONENTS)('%s does not import mock-data', (relPath) => {
    const abs = join(__dirname, relPath);
    const src = readFileSync(abs, 'utf8');
    expect(src).not.toMatch(MOCK_DATA_IMPORT);
  });
});
