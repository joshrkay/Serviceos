import { useState } from 'react';
import { X, Check, Receipt } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { uiLineItemsToApiPayload, type UiLineItem } from '../../lib/lineItems';

export interface ConvertToInvoiceInput {
  estimateId: string;
  jobId: string;
  estimateNumber: string;
  customerName: string;
  description?: string;
  lineItems: UiLineItem[];
  discountCents?: number;
  taxRateBps?: number;
  approvedLabel?: string;
}

export function ConvertToInvoiceSheet({
  input,
  onClose,
  onConverted,
}: {
  input: ConvertToInvoiceInput;
  onClose: () => void;
  onConverted: (invoiceId: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = input.lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
  const lineItems = uiLineItemsToApiPayload(input.lineItems);

  async function convert() {
    if (!input.jobId) {
      setError('This estimate is not linked to a job. Link a job before creating an invoice.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: input.jobId,
          estimateId: input.estimateId,
          lineItems,
          discountCents: input.discountCents ?? 0,
          taxRateBps: input.taxRateBps ?? 0,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          typeof body?.message === 'string'
            ? body.message
            : `Could not create invoice (HTTP ${res.status})`;
        throw new Error(msg);
      }
      const invoice = (await res.json()) as { id: string };
      setDone(true);
      setTimeout(() => {
        onConverted(invoice.id);
        onClose();
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl shadow-2xl overflow-y-auto max-h-[85vh]"
        style={{ animation: 'slideUp 0.25s ease' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-8 h-1 rounded-full bg-slate-200" />
        </div>

        <div className="px-5 pb-8">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-slate-900" style={{ fontSize: '1rem' }}>Create invoice</p>
              <p className="text-xs text-slate-400 mt-0.5">From approved {input.estimateNumber}</p>
            </div>
            <button
              onClick={onClose}
              type="button"
              className="flex size-7 items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
            >
              <X size={15} className="text-slate-500" />
            </button>
          </div>

          {done ? (
            <div className="flex flex-col items-center py-10 gap-3" style={{ animation: 'fadeUp 0.2s ease' }}>
              <div className="flex size-14 items-center justify-center rounded-full bg-green-100">
                <Check size={24} className="text-green-600" />
              </div>
              <p className="text-slate-800">Invoice created</p>
              <p className="text-xs text-slate-400">
                Opening invoice for {input.customerName.split(' ')[0]}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-4 mb-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800">{input.customerName}</p>
                    {input.description && (
                      <p className="text-xs text-slate-400 mt-0.5 truncate">{input.description}</p>
                    )}
                  </div>
                  <p className="text-sm text-slate-900 shrink-0">${total.toLocaleString()}</p>
                </div>
                {input.approvedLabel && (
                  <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-green-50 border border-green-100 px-3 py-2">
                    <Check size={11} className="text-green-600 shrink-0" />
                    <span className="text-xs text-green-700">{input.approvedLabel}</span>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden mb-4">
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
                  <p className="text-xs text-slate-500">{input.lineItems.length} line items</p>
                </div>
                <div className="divide-y divide-slate-50">
                  {input.lineItems.map((item, i) => (
                    <div key={i} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-700 truncate">{item.description}</p>
                        {item.qty > 1 && (
                          <p className="text-xs text-slate-400">
                            {item.qty} × ${item.rate.toLocaleString()}
                          </p>
                        )}
                      </div>
                      <p className="text-sm text-slate-800 shrink-0 ml-3">
                        ${(item.qty * item.rate).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-t border-slate-100">
                  <p className="text-sm text-slate-600">Total</p>
                  <p className="text-sm text-slate-900">${total.toLocaleString()}</p>
                </div>
              </div>

              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

              <button
                onClick={() => void convert()}
                disabled={loading}
                type="button"
                className={`w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-sm transition-all ${
                  loading ? 'bg-slate-400 text-white' : 'bg-slate-900 text-white hover:bg-slate-700'
                }`}
              >
                {loading ? (
                  <>
                    <span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />{' '}
                    Creating…
                  </>
                ) : (
                  <>
                    <Receipt size={14} /> Create invoice for ${total.toLocaleString()}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideUp { from { transform:translateY(100%) } to { transform:translateY(0) } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  );
}
