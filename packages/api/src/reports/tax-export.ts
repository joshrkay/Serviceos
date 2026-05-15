/**
 * Tax-ready export (§8) — the date-range packet the owner hands their
 * accountant: income (from paid invoices) + expenses (by category and
 * job). Hand-rolled CSV builder — no new dependency, RFC-4180 quoting.
 * PDF is explicitly deferred post-launch (the spec's "CSV/PDF" minimum
 * credible version is satisfied by CSV).
 */
export interface TaxExportRow {
  /** 'YYYY-MM-DD'. */
  date: string;
  type: 'income' | 'expense';
  category: string;
  description: string;
  /** Optional job linkage. */
  jobId?: string;
  /** Integer cents. */
  amountCents: number;
}

const HEADER = 'Date,Type,Category,Description,Job ID,Amount';

/** RFC-4180 field quoting: wrap in quotes + double internal quotes when needed. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function buildTaxExportCsv(rows: TaxExportRow[]): string {
  const lines = [HEADER];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.date),
        csvField(row.type),
        csvField(row.category),
        csvField(row.description),
        csvField(row.jobId ?? ''),
        formatCents(row.amountCents),
      ].join(','),
    );
  }
  return lines.join('\n');
}
