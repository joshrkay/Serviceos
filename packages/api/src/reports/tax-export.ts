/**
 * Tax-ready export (§8) — the date-range packet the owner hands their
 * accountant: income (from paid invoices) + expenses (by category and
 * job). Hand-rolled CSV builder — no new dependency, RFC-4180 quoting.
 * PDF is explicitly deferred post-launch (the spec's "CSV/PDF" minimum
 * credible version is satisfied by CSV).
 */
import type { Payment } from '../invoices/payment';

export interface TaxExportRow {
  /** 'YYYY-MM-DD'. */
  date: string;
  type: 'income' | 'expense';
  category: string;
  description: string;
  /** Optional job linkage. */
  jobId?: string;
  /**
   * Integer cents. NEGATIVE for refund rows (D2-4) so YTD income nets
   * correctly when summed against the paired original payment row.
   */
  amountCents: number;
}

const HEADER = 'Date,Type,Category,Description,Job ID,Amount';

/**
 * RFC-4180 field quoting + CSV formula-injection neutralization.
 *
 * Spreadsheet apps (Excel, Numbers, Sheets) interpret a cell starting with
 * `=`, `+`, `-`, `@`, `\t`, or `\r` as a formula — letting an attacker
 * pass `=HYPERLINK(...)` or `=cmd|...` through any free-text field
 * (vendor, description, invoice number) and have it execute when the
 * accountant opens the CSV. OWASP "CSV Injection" / CWE-1236.
 *
 * Mitigation: any value whose FIRST NON-WHITESPACE character is one of
 * those prefixes is force-quoted and inner-prefixed with `'` so the
 * spreadsheet treats it as a string. We strip leading whitespace before
 * the check because Excel/Numbers trim leading whitespace when deciding
 * whether to evaluate a cell as a formula — `" =CMD"` is still dangerous.
 */
function csvField(value: string): string {
  const trimmed = value.replace(/^\s+/, '');
  const dangerous = /^[=+\-@\t\r]/.test(trimmed);
  if (dangerous) {
    return `"'${value.replace(/"/g, '""')}"`;
  }
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCents(cents: number): string {
  // Negative cents render with a leading '-' (e.g. -50000 → "-500.00") so
  // accountants and spreadsheet apps subtract refund rows naturally.
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

/**
 * D2-4 — build the income rows for a single payment, accounting for
 * partial refunds. A refund is NOT a status flip; the original payment
 * row keeps its full magnitude (cash that DID arrive in this period for
 * tax purposes) and any refunded portion is emitted as a SEPARATE
 * negative-income row dated by `refundedAt`. YTD income therefore nets
 * correctly when an accountant sums the Amount column.
 *
 * Returns 1 row for a payment with no refund; 2 rows when
 * `refundedAmountCents > 0`. The refund row's description is prefixed
 * with "[REFUND] " and references the original payment id so the pair
 * is easy to reconcile.
 */
export interface PaymentRowContext {
  /** Invoice number for the description (or any human-readable token). */
  invoiceNumber: string;
  /** Optional job linkage carried onto both rows. */
  jobId?: string;
}

export function buildPaymentIncomeRows(
  payment: Payment,
  ctx: PaymentRowContext,
): TaxExportRow[] {
  const out: TaxExportRow[] = [];
  // Original payment — full magnitude, original received date.
  out.push({
    date: payment.receivedAt.toISOString().slice(0, 10),
    type: 'income',
    category: 'invoice',
    description: ctx.invoiceNumber,
    ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
    amountCents: payment.amountCents,
  });

  const refundedCents = payment.refundedAmountCents ?? 0;
  if (refundedCents > 0 && payment.refundedAt) {
    out.push({
      date: payment.refundedAt.toISOString().slice(0, 10),
      type: 'income',
      category: 'invoice',
      description: `[REFUND] ${ctx.invoiceNumber} (payment ${payment.id})`,
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
      amountCents: -refundedCents,
    });
  }
  return out;
}
