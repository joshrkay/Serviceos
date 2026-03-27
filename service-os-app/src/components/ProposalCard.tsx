'use client';

import { Check, Pencil, AlertCircle, User } from 'lucide-react';

export interface Proposal {
  type: string;
  customer: {
    name: string;
    id?: string;
    is_new?: boolean;
    match_confidence?: number;
  };
  amount?: number;
  service_description?: string;
  materials?: { name: string; quantity?: number }[];
  confidence: number;
  confidence_level: 'high' | 'medium' | 'low';
  confirmation_message: string;
  clarification_needed?: string | null;
  clarification_question?: string | null;
  alternatives?: { name: string; id: string; confidence: number }[];
}

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  create_invoice: { label: 'Create Invoice', color: 'bg-blue-100 text-blue-700' },
  update_status: { label: 'Update Status', color: 'bg-green-100 text-green-700' },
  create_estimate: { label: 'Estimate', color: 'bg-purple-100 text-purple-700' },
  schedule_job: { label: 'Schedule', color: 'bg-amber-100 text-amber-700' },
  add_customer: { label: 'New Customer', color: 'bg-teal-100 text-teal-700' },
};

const CONFIDENCE_DOT: Record<string, string> = {
  high: 'bg-green-500',
  medium: 'bg-amber-500',
  low: 'bg-red-500',
};

export default function ProposalCard({
  proposal,
  onApprove,
  onEdit,
}: {
  proposal: Proposal;
  onApprove?: () => void;
  onEdit?: () => void;
}) {
  const typeInfo = TYPE_LABELS[proposal.type] || { label: proposal.type, color: 'bg-slate-100 text-slate-700' };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${typeInfo.color}`}>
          {typeInfo.label}
        </span>
        <div className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${CONFIDENCE_DOT[proposal.confidence_level]}`} />
          <span className="text-xs text-slate-400">
            {Math.round(proposal.confidence * 100)}%
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 space-y-1.5">
        {/* Customer */}
        <div className="flex items-center gap-1.5">
          <User size={14} className="text-slate-400" />
          <span className="text-sm font-medium">{proposal.customer.name}</span>
          {proposal.customer.is_new && (
            <span className="text-xs bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded-full">New</span>
          )}
        </div>

        {/* Amount */}
        {proposal.amount != null && (
          <p className="text-lg font-semibold text-slate-800">
            ${(proposal.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </p>
        )}

        {/* Service */}
        {proposal.service_description && (
          <p className="text-sm text-slate-600">{proposal.service_description}</p>
        )}

        {/* Materials */}
        {proposal.materials && proposal.materials.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {proposal.materials.map((m, i) => (
              <span key={i} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                {m.name}{m.quantity && m.quantity > 1 ? ` x${m.quantity}` : ''}
              </span>
            ))}
          </div>
        )}

        {/* Alternatives (disambiguation) */}
        {proposal.alternatives && proposal.alternatives.length > 0 && (
          <div className="pt-1 space-y-1">
            <p className="text-xs text-slate-500 flex items-center gap-1">
              <AlertCircle size={12} /> Did you mean:
            </p>
            {proposal.alternatives.map((alt, i) => (
              <button
                key={i}
                className="w-full text-left text-sm px-2 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
              >
                {alt.name}
                <span className="text-xs text-slate-400 ml-2">{Math.round(alt.confidence * 100)}%</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex border-t border-slate-100">
        <button
          onClick={onApprove}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium text-green-600 hover:bg-green-50 transition-colors"
        >
          <Check size={16} /> Approve
        </button>
        <div className="w-px bg-slate-100" />
        <button
          onClick={onEdit}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium text-amber-600 hover:bg-amber-50 transition-colors"
        >
          <Pencil size={16} /> Edit
        </button>
      </div>
    </div>
  );
}
