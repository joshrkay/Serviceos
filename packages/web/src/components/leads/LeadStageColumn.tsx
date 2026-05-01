import React from 'react';
import { LeadCard, LeadCardData } from './LeadCard';

export interface LeadStageColumnProps {
  stage: string;
  label: string;
  leads: LeadCardData[];
  onCardClick?: (id: string) => void;
  onDropLead?: (leadId: string, toStage: string) => void;
}

export function LeadStageColumn({
  stage,
  label,
  leads,
  onCardClick,
  onDropLead,
}: LeadStageColumnProps) {
  const [isOver, setIsOver] = React.useState(false);

  return (
    <div
      data-testid={`lead-column-${stage}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const leadId = e.dataTransfer.getData('text/plain');
        if (leadId) onDropLead?.(leadId, stage);
      }}
      className={`flex flex-col gap-2 rounded-xl border p-3 min-h-[120px] ${
        isOver ? 'border-blue-400 bg-blue-50/50' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm text-slate-700">{label}</p>
        <span className="text-xs bg-white border border-slate-200 rounded-full px-2 py-0.5 text-slate-600">
          {leads.length}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {leads.map((lead) => (
          <LeadCard key={lead.id} lead={lead} onClick={onCardClick} />
        ))}
        {leads.length === 0 && (
          <p className="text-xs text-slate-400 px-1">No leads in this stage.</p>
        )}
      </div>
    </div>
  );
}
