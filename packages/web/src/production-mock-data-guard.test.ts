import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Routed legacy components must not import live data from mock-data.
 * Type-only imports in shared utilities are allowed separately.
 */
const ROUTED_COMPONENTS = [
  'components/jobs/NewJobFlow.tsx',
  'components/jobs/JobDetail.tsx',
  'components/schedule/SchedulePage.tsx',
  'components/estimates/NewEstimateFlow.tsx',
  'components/estimates/EstimatesPage.tsx',
  'components/invoices/InvoicesPage.tsx',
];

/** Value imports from mock-data are forbidden; `import type` is allowed. */
const MOCK_IMPORT = /import\s+(?!type\s)(?:type\s+)?\{[^}]+\}\s+from\s+['"][^'"]*mock-data['"]/;

describe('production mock-data guard', () => {
  it.each(ROUTED_COMPONENTS)('%s does not import mock-data', (relPath) => {
    const abs = join(__dirname, relPath);
    const src = readFileSync(abs, 'utf8');
    expect(src).not.toMatch(MOCK_IMPORT);
  });
});
