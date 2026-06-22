/**
 * Client-side estimate "Download PDF" via the browser's print pipeline
 * (Save as PDF). Opens an isolated print document so the app's DOM/CSS
 * doesn't interfere, then triggers print. No server dependency — a
 * server-side renderer is the future step for emailing/attaching a PDF
 * to the customer link.
 */
export interface EstimatePrintLineItem {
  description: string;
  qty: number;
  /** Unit price in dollars. */
  rate: number;
}

export interface EstimatePrintData {
  estimateNumber: string;
  customerName: string;
  businessName: string;
  businessContact?: string;
  description?: string;
  validUntil?: string;
  lineItems: EstimatePrintLineItem[];
  /** Optional override total in dollars; defaults to sum of line items. */
  totalDollars?: number;
  /**
   * Tenant-facing document label (e.g. 'Quote', 'Bid'). Defaults to
   * 'Estimate'. The canonical entity is unchanged — this only relabels the
   * printed document so it matches how the tenant talks to customers.
   */
  documentLabel?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function usd(amount: number): string {
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Open a print-ready estimate document and invoke the browser print
 * dialog. Returns false when the popup was blocked so callers can surface
 * a hint. All interpolated strings are HTML-escaped.
 */
export function printEstimateDocument(data: EstimatePrintData): boolean {
  const total = data.totalDollars ?? data.lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  const documentLabel = data.documentLabel?.trim() || 'Estimate';

  const rows = data.lineItems
    .map(
      (item) => `
        <tr>
          <td class="desc">${escapeHtml(item.description)}</td>
          <td class="num">${item.qty}</td>
          <td class="num">${usd(item.rate)}</td>
          <td class="num">${usd(item.qty * item.rate)}</td>
        </tr>`,
    )
    .join('');

  const win = window.open('', '_blank', 'width=820,height=1040');
  if (!win) return false; // popup blocked

  win.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(documentLabel)} ${escapeHtml(data.estimateNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 40px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
    .biz { font-size: 16px; font-weight: 600; }
    .muted { color: #64748b; font-size: 12px; }
    .doc-meta { text-align: right; }
    .doc-meta .num { font-size: 14px; }
    .section { margin-bottom: 20px; }
    .label { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
    .desc-note { font-style: italic; color: #475569; font-size: 13px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { text-align: left; font-size: 11px; color: #64748b; border-bottom: 1px solid #e2e8f0; padding: 8px 6px; }
    th.num, td.num { text-align: right; }
    td { font-size: 13px; padding: 10px 6px; border-bottom: 1px solid #f1f5f9; }
    td.desc { width: 60%; }
    .total { display: flex; justify-content: space-between; align-items: center; background: #0f172a; color: #fff; padding: 14px 16px; border-radius: 10px; font-size: 15px; }
    @media print { body { padding: 24px; } @page { margin: 16mm; } }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="biz">${escapeHtml(data.businessName)}</div>
      ${data.businessContact ? `<div class="muted">${escapeHtml(data.businessContact)}</div>` : ''}
    </div>
    <div class="doc-meta">
      <div class="label">${escapeHtml(documentLabel)}</div>
      <div class="num">${escapeHtml(data.estimateNumber)}</div>
      ${data.validUntil ? `<div class="muted">Valid until ${escapeHtml(data.validUntil)}</div>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="label">Prepared for</div>
    <div>${escapeHtml(data.customerName)}</div>
  </div>

  ${data.description ? `<div class="desc-note">${escapeHtml(data.description)}</div>` : ''}

  <table>
    <thead>
      <tr>
        <th class="desc">Description</th>
        <th class="num">Qty</th>
        <th class="num">Rate</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="total">
    <span>Total</span>
    <span>${usd(total)}</span>
  </div>

  <script>
    window.onload = function () {
      window.focus();
      window.print();
    };
  </script>
</body>
</html>`);
  win.document.close();
  return true;
}
