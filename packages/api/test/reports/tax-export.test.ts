import { describe, it, expect } from 'vitest';
import { buildTaxExportCsv, TaxExportRow } from '../../src/reports/tax-export';

const rows: TaxExportRow[] = [
  {
    date: '2026-05-03',
    type: 'income',
    category: 'invoice',
    description: 'INV-1001',
    jobId: 'job-aaa',
    amountCents: 250000,
  },
  {
    date: '2026-05-10',
    type: 'expense',
    category: 'materials',
    description: 'Copper, "Big Box" supply',
    jobId: 'job-bbb',
    amountCents: 24000,
  },
  {
    date: '2026-05-12',
    type: 'expense',
    category: 'fuel',
    description: 'Diesel',
    amountCents: 8000,
  },
];

describe('buildTaxExportCsv', () => {
  it('emits a header row followed by one row per entry', () => {
    const csv = buildTaxExportCsv(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Type,Category,Description,Job ID,Amount');
    expect(lines).toHaveLength(4);
  });

  it('formats cents as a decimal dollar amount', () => {
    const csv = buildTaxExportCsv(rows);
    expect(csv).toContain('2026-05-03,income,invoice,INV-1001,job-aaa,2500.00');
    expect(csv).toContain('2026-05-12,expense,fuel,Diesel,,80.00');
  });

  it('quotes and escapes fields containing commas or quotes', () => {
    const csv = buildTaxExportCsv(rows);
    expect(csv).toContain('"Copper, ""Big Box"" supply"');
  });

  it('returns just the header for an empty row set', () => {
    expect(buildTaxExportCsv([])).toBe('Date,Type,Category,Description,Job ID,Amount');
  });

  it('neutralizes CSV formula-injection in free-text fields (OWASP CWE-1236)', () => {
    const csv = buildTaxExportCsv([
      {
        date: '2026-05-10',
        type: 'expense',
        category: 'materials',
        description: '=HYPERLINK("http://evil.example","click")',
        amountCents: 1000,
      },
      {
        date: '2026-05-11',
        type: 'expense',
        category: 'fuel',
        description: '+1234',
        amountCents: 500,
      },
      {
        date: '2026-05-12',
        type: 'expense',
        category: 'tools',
        description: '@SUM(A1:A10)',
        amountCents: 700,
      },
    ]);
    // Each dangerous prefix is force-quoted and prepended with `'` so the
    // spreadsheet treats the cell as a string literal, not a formula.
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example"",""click"")"');
    expect(csv).toContain("\"'+1234\"");
    expect(csv).toContain("\"'@SUM(A1:A10)\"");
  });
});
