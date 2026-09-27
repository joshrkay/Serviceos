/**
 * #1400 — client-side "Download receipt" for a paid invoice, via the
 * browser's print pipeline (Save as PDF), same approach as estimatePdf.ts.
 * Every amount is the API's integer cents (document totals, payments,
 * balance) — nothing here re-derives money from line items.
 */
export interface ReceiptPayment {
  receivedAt: string;
  method: string;
  amountCents: number;
}

export interface InvoiceReceiptData {
  invoiceNumber: string;
  customerName: string;
  businessName: string;
  businessContact?: string;
  lineItems: Array<{ description: string; quantity: number; totalCents: number }>;
  totals: { subtotalCents: number; discountCents: number; taxRateBps: number; taxCents: number; totalCents: number };
  amountPaidCents: number;
  amountDueCents: number;
  payments: ReceiptPayment[];
  /** Formats an ISO instant as a tenant-local date. */
  formatDate: (iso: string) => string;
  /** Human label for a payment method code. */
  methodLabel: (method: string) => string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function usdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Opens the print-ready receipt; returns false when the popup was blocked. */
export function printInvoiceReceipt(data: InvoiceReceiptData): boolean {
  const { totals } = data;
  const lines = data.lineItems
    .map((li) => `<tr><td>${escapeHtml(li.description)}</td><td class="num">${li.quantity}</td><td class="num">${usdCents(li.totalCents)}</td></tr>`)
    .join('');
  const payments = data.payments
    .map((p) => `<tr><td>${escapeHtml(data.formatDate(p.receivedAt))}</td><td>${escapeHtml(data.methodLabel(p.method))}</td><td class="num">${usdCents(p.amountCents)}</td></tr>`)
    .join('');

  const win = window.open('', '_blank', 'width=820,height=1040');
  if (!win) return false;

  win.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt ${escapeHtml(data.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 40px; }
    .head { display: flex; justify-content: space-between; margin-bottom: 28px; }
    .biz { font-size: 16px; font-weight: 600; }
    .muted { color: #64748b; font-size: 12px; }
    .label { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { text-align: left; font-size: 11px; color: #64748b; border-bottom: 1px solid #e2e8f0; padding: 8px 6px; }
    td { font-size: 13px; padding: 8px 6px; border-bottom: 1px solid #f1f5f9; }
    .num { text-align: right; }
    .row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 6px; }
    .strong { font-weight: 600; }
    @media print { body { padding: 24px; } @page { margin: 16mm; } }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="biz">${escapeHtml(data.businessName)}</div>
      ${data.businessContact ? `<div class="muted">${escapeHtml(data.businessContact)}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div class="label">Receipt</div>
      <div>${escapeHtml(data.invoiceNumber)}</div>
    </div>
  </div>
  <div class="label">Billed to</div>
  <div style="margin-bottom:20px">${escapeHtml(data.customerName)}</div>

  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>

  <div class="row"><span>Subtotal</span><span>${usdCents(totals.subtotalCents)}</span></div>
  ${totals.discountCents > 0 ? `<div class="row"><span>Discount</span><span>-${usdCents(totals.discountCents)}</span></div>` : ''}
  ${totals.taxRateBps > 0 ? `<div class="row"><span>Tax (${(totals.taxRateBps / 100).toFixed(2)}%)</span><span>${usdCents(totals.taxCents)}</span></div>` : ''}
  <div class="row strong"><span>Total</span><span>${usdCents(totals.totalCents)}</span></div>

  <div class="label" style="margin-top:24px">Payments</div>
  <table>
    <thead><tr><th>Date</th><th>Method</th><th class="num">Amount</th></tr></thead>
    <tbody>${payments}</tbody>
  </table>
  <div class="row"><span>Paid</span><span>${usdCents(data.amountPaidCents)}</span></div>
  <div class="row strong"><span>Balance due</span><span>${usdCents(data.amountDueCents)}</span></div>

  <script>window.onload = function () { window.focus(); window.print(); };</script>
</body>
</html>`);
  win.document.close();
  return true;
}
