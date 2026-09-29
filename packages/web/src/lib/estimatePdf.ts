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
  /**
   * B7.5 — descriptive unit of measure ('each', 'hour', 'sq ft', …) printed
   * next to the quantity so the document says what the rate measures.
   * DESCRIPTIVE ONLY: the row and document totals below never read it.
   */
  unit?: string;
  /** Unit price in dollars. */
  rate: number;
  /** EE-4 — optional signed thumbnail URL shown beside the description. */
  imageUrl?: string;
}

export interface EstimatePrintTotals {
  subtotalCents: number;
  discountCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
}

export interface EstimatePrintData {
  estimateNumber: string;
  customerName: string;
  businessName: string;
  businessContact?: string;
  /** #1402 §13 — tenant mailing address; newlines become separate printed lines. */
  businessAddress?: string;
  description?: string;
  validUntil?: string;
  lineItems: EstimatePrintLineItem[];
  /**
   * #1400 — the document's money, integer cents, exactly as the API (or the
   * billing-engine-mirroring accept preview) states it. The printed document
   * never re-sums qty × rate: that re-sum ignored tax and discount and
   * printed $300.99 for a $325.82 estimate.
   */
  totals: EstimatePrintTotals;
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

function usdCents(cents: number): string {
  return usd(cents / 100);
}

/**
 * Open a print-ready estimate document and invoke the browser print
 * dialog. Returns false when the popup was blocked so callers can surface
 * a hint. All interpolated strings are HTML-escaped.
 */
export function printEstimateDocument(data: EstimatePrintData): boolean {
  const { totals } = data;
  const documentLabel = data.documentLabel?.trim() || 'Estimate';

  const rows = data.lineItems
    .map(
      (item) => `
        <tr>
          <td class="desc">${item.imageUrl ? `<img class="thumb" src="${escapeHtml(item.imageUrl)}" alt="" />` : ''}${escapeHtml(item.description)}</td>
          <td class="num">${item.qty}${item.unit ? ` <span class="unit">${escapeHtml(item.unit)}</span>` : ''}</td>
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
    .thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; vertical-align: middle; margin-right: 8px; }
    /* B7.5 — descriptive unit beside the quantity; muted so the number reads first. */
    .unit { color: #64748b; font-size: 11px; }
    .breakdown { margin-bottom: 12px; }
    .breakdown .row { display: flex; justify-content: space-between; font-size: 13px; color: #475569; padding: 4px 6px; }
    .total { display: flex; justify-content: space-between; align-items: center; background: #0f172a; color: #fff; padding: 14px 16px; border-radius: 10px; font-size: 15px; }
    @media print { body { padding: 24px; } @page { margin: 16mm; } }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="biz">${escapeHtml(data.businessName)}</div>
      ${data.businessAddress?.trim() ? `<div class="muted address">${data.businessAddress.trim().split('\n').map((line) => escapeHtml(line.trim())).join('<br>')}</div>` : ''}
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

  <div class="breakdown">
    <div class="row"><span>Subtotal</span><span>${usdCents(totals.subtotalCents)}</span></div>
    ${totals.discountCents > 0 ? `<div class="row"><span>Discount</span><span>-${usdCents(totals.discountCents)}</span></div>` : ''}
    ${totals.taxRateBps > 0 ? `<div class="row"><span>Tax (${(totals.taxRateBps / 100).toFixed(2)}%)</span><span>${usdCents(totals.taxCents)}</span></div>` : ''}
  </div>

  <div class="total">
    <span>Total</span>
    <span>${usdCents(totals.totalCents)}</span>
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
