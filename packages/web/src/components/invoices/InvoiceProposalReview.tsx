import React from 'react';
import { formatCurrency as formatCents } from '../../utils/currency';

/**
 * P2-035 (U2) — the backend's per-line catalog-grounding signal. 'manual'
 * is operator-entered and intentionally not badged.
 */
export type InvoicePricingSource = 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  category?: string;
  /** P2-035 (U2) — where this line's price came from. */
  pricingSource?: InvoicePricingSource;
}

/**
 * P2-035 (U2) — the 4-tier confidence vocabulary the backend stamps on
 * `payload._meta.overallConfidence` (mirrors the API's CONFIDENCE_LEVELS).
 */
export type InvoiceConfidenceLevel = 'high' | 'medium' | 'low' | 'very_low';

/**
 * P2-035 (U2) — UI-shaped projection of the backend's
 * `proposalConfidenceMetaSchema` (`_meta`). Only the fields this review
 * surfaces are carried; additive-only. Absent on legacy proposals — the
 * coarse `confidenceScore` percentage is the fallback.
 */
export interface InvoiceConfidenceMeta {
  overallConfidence: InvoiceConfidenceLevel;
  fieldConfidence?: Record<string, InvoiceConfidenceLevel>;
  /** "What I wasn't sure about" callouts surfaced under the header. */
  markers?: { path: string; reason: string }[];
}

export interface InvoiceProposalData {
  id: string;
  customerId: string;
  jobId: string;
  estimateId?: string;
  lineItems: InvoiceLineItem[];
  discountCents: number;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  customerMessage?: string;
  explanation?: string;
  confidenceScore?: number;
  /**
   * P2-035 (U2) — the backend's `_meta` confidence fragment. When present
   * the 4-tier overall-confidence chip + markers render; falls back to the
   * coarse `confidenceScore` percentage when absent.
   */
  meta?: InvoiceConfidenceMeta;
  status: string;
}

// P2-035 (U2) — 4-tier overall-confidence chip styling sourced from
// `meta.overallConfidence`. Mirrors AIProposalCard's CONFIDENCE_LEVEL_CONFIG.
const CONFIDENCE_LEVEL_LABEL: Record<InvoiceConfidenceLevel, { label: string; classes: string }> = {
  high:     { label: 'High confidence',     classes: 'bg-green-50 text-green-700 border-green-200' },
  medium:   { label: 'Review recommended',  classes: 'bg-amber-50 text-amber-800 border-amber-200' },
  low:      { label: 'Low confidence',      classes: 'bg-orange-50 text-orange-700 border-orange-200' },
  very_low: { label: 'Very low confidence', classes: 'bg-red-50 text-red-700 border-red-200' },
};

// P2-035 (U2) — per-line catalog-grounding badge styling. 'manual' is
// operator-entered, so it carries no badge (not a key here).
const PRICING_SOURCE_BADGE: Record<'catalog' | 'ambiguous' | 'uncatalogued', { label: string; classes: string }> = {
  catalog:      { label: 'From catalog',  classes: 'bg-green-50 text-green-700 border-green-200' },
  ambiguous:    { label: 'Needs a pick',  classes: 'bg-amber-50 text-amber-800 border-amber-200' },
  uncatalogued: { label: 'AI-estimated',  classes: 'bg-orange-50 text-orange-700 border-orange-200' },
};

export interface InvoiceProposalReviewProps {
  proposal: InvoiceProposalData;
  onEdit?: (proposalId: string) => void;
  onApprove?: (proposalId: string) => void;
  onReject?: (proposalId: string) => void;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function InvoiceProposalReview({
  proposal,
  onEdit,
  onApprove,
  onReject,
}: InvoiceProposalReviewProps) {
  return (
    <div className="invoice-proposal-review" data-testid="invoice-proposal-review">
      <div className="proposal-header" data-testid="proposal-header">
        <h3>Invoice Proposal</h3>
        <span className="proposal-status" data-testid="proposal-status">
          {proposal.status}
        </span>
        {/* P2-035 (U2) — prefer the backend's 4-tier `_meta` chip when
            present; fall back to the coarse confidence percentage so legacy
            proposals (and any without `_meta`) render unchanged. */}
        {proposal.meta?.overallConfidence ? (
          <span
            className={`confidence-level inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
              CONFIDENCE_LEVEL_LABEL[proposal.meta.overallConfidence].classes
            }`}
            data-testid="confidence-level"
            data-level={proposal.meta.overallConfidence}
          >
            {CONFIDENCE_LEVEL_LABEL[proposal.meta.overallConfidence].label}
          </span>
        ) : (
          proposal.confidenceScore !== undefined && (
            <span className="confidence-score" data-testid="confidence-score">
              {Math.round(proposal.confidenceScore * 100)}% confidence
            </span>
          )
        )}
      </div>

      {/* P2-035 (U2) — "what I wasn't sure about" callouts from `_meta.markers`.
          Each marker explains a low-certainty field (uncatalogued price,
          ambiguous catalog match) so the operator knows what to check. */}
      {proposal.meta?.markers && proposal.meta.markers.length > 0 && (
        <div
          className="confidence-markers mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
          data-testid="confidence-markers"
        >
          <p className="text-xs font-medium text-amber-900">What I wasn’t sure about</p>
          <ul className="mt-1 flex flex-col gap-1">
            {proposal.meta.markers.map((m, i) => (
              <li key={`${m.path}-${i}`} className="text-xs text-amber-800">
                {m.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposal.explanation && (
        <div className="proposal-explanation" data-testid="proposal-explanation">
          {proposal.explanation}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="line-items-table" data-testid="line-items-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Qty</th>
              <th>Unit Price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {proposal.lineItems.map((item, index) => {
              // P2-035 (U2) — surface WHERE this line's price came from.
              // 'manual' (operator-entered) and absent sources are not badged.
              const badge =
                item.pricingSource && item.pricingSource !== 'manual'
                  ? PRICING_SOURCE_BADGE[item.pricingSource]
                  : null;
              return (
                <tr key={index} data-testid={`line-item-${index}`}>
                  <td>
                    {item.description}
                    {badge && (
                      <span
                        data-testid={`pricing-source-${item.pricingSource}`}
                        className={`ml-2 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${badge.classes}`}
                      >
                        {badge.label}
                      </span>
                    )}
                  </td>
                  <td>{item.quantity}</td>
                  <td>{formatCents(item.unitPrice)}</td>
                  <td>{formatCents(Math.round(item.quantity * item.unitPrice))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="totals-section" data-testid="totals-section">
        <div className="total-row" data-testid="subtotal">
          <span>Subtotal:</span>
          <span>{formatCents(proposal.subtotalCents)}</span>
        </div>
        {proposal.discountCents > 0 && (
          <div className="total-row" data-testid="discount">
            <span>Discount:</span>
            <span>-{formatCents(proposal.discountCents)}</span>
          </div>
        )}
        {proposal.taxRateBps > 0 && (
          <div className="total-row" data-testid="tax">
            <span>Tax ({formatBps(proposal.taxRateBps)}):</span>
            <span>{formatCents(proposal.taxCents)}</span>
          </div>
        )}
        <div className="total-row total-final" data-testid="total">
          <span>Total:</span>
          <span>{formatCents(proposal.totalCents)}</span>
        </div>
      </div>

      {proposal.customerMessage && (
        <div className="customer-message" data-testid="customer-message">
          <strong>Customer Message:</strong> {proposal.customerMessage}
        </div>
      )}

      {proposal.estimateId && (
        <div className="estimate-reference" data-testid="estimate-reference">
          Based on estimate: {proposal.estimateId}
        </div>
      )}
    </div>
  );
}
