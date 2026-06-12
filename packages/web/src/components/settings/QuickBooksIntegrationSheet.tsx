/**
 * Tier 4 (QuickBooks — F17 / P15-001).
 *
 * Closes the QuickBooks stub on Settings. Operators connect via OAuth,
 * view sync status, trigger manual sync, and disconnect.
 */
import { X } from 'lucide-react';
import { QuickBooksConnect } from '../integrations/QuickBooksConnect';

interface QuickBooksIntegrationSheetProps {
  onClose: () => void;
  onConnectionChange?: () => void;
}

export function QuickBooksIntegrationSheet({
  onClose,
  onConnectionChange,
}: QuickBooksIntegrationSheetProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="quickbooks-integration-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid="quickbooks-integration-sheet"
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-[#2CA01C] text-white text-xs font-mono">
            QB
          </span>
          <h2 id="quickbooks-integration-title" className="flex-1 text-base text-slate-900">
            QuickBooks Online
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5">
          <p className="text-xs text-slate-500 mb-4">
            Connect QuickBooks Online to automatically sync paid invoices and
            customer records — no double entry.
          </p>
          <QuickBooksConnect onStatusChange={onConnectionChange} />
        </div>
      </div>
    </div>
  );
}
