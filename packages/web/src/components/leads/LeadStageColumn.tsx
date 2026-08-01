import React from 'react';
import { LeadCard, LeadCardData } from './LeadCard';

/** Stages that accept kanban drops. Won/lost require Convert / Lose actions. */
const DROPPABLE_STAGES = new Set(['new', 'contacted', 'qualified', 'quoted']);

export interface LeadStageColumnProps {
  stage: string;
  label: string;
  leads: LeadCardData[];
  onCardClick?: (id: string) => void;
  onDropLead?: (leadId: string, toStage: string) => void;
  onDragStartLead?: (leadId: string) => void;
  onDragEndLead?: () => void;
  /** Lead currently being dragged — cards get pointer-events-none while set. */
  draggingLeadId?: string | null;
}

export function LeadStageColumn({
  stage,
  label,
  leads,
  onCardClick,
  onDropLead,
  onDragStartLead,
  onDragEndLead,
  draggingLeadId = null,
}: LeadStageColumnProps) {
  const [isOver, setIsOver] = React.useState(false);
  const isDroppable = DROPPABLE_STAGES.has(stage);
  const isDragging = draggingLeadId !== null;

  return (
    <div
      data-testid={`lead-column-${stage}`}
      data-droppable={isDroppable ? 'true' : 'false'}
      onDragOver={(e) => {
        if (!isDroppable) {
          e.dataTransfer.dropEffect = 'none';
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setIsOver(true);
      }}
      onDragLeave={(e) => {
        // Ignore leave events when the pointer moves into a child (cards / empty copy).
        if (
          e.currentTarget &&
          e.relatedTarget &&
          e.currentTarget.contains(e.relatedTarget as Node)
        ) {
          return;
        }
        setIsOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        if (!isDroppable) return;
        const leadId = e.dataTransfer.getData('text/plain');
        if (leadId) onDropLead?.(leadId, stage);
      }}
      className={`flex flex-col gap-2 rounded-xl border p-3 min-h-[120px] ${
        !isDroppable
          ? 'border-slate-200 bg-slate-100/60 opacity-80'
          : isOver
            ? 'border-blue-400 bg-blue-50/50'
            : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm text-slate-700">{label}</p>
        <span className="text-xs bg-white border border-slate-200 rounded-full px-2 py-0.5 text-slate-600">
          {leads.length}
        </span>
      </div>
      {!isDroppable && (
        <p className="text-xs text-slate-400 px-1">
          {stage === 'won'
            ? 'Use Convert on a lead to mark Won.'
            : 'Use Mark Lost on a lead with a reason.'}
        </p>
      )}
      <div className="flex flex-col gap-2 flex-1">
        {leads.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            onClick={onCardClick}
            onDragStart={onDragStartLead}
            onDragEnd={onDragEndLead}
            pointerEventsNone={isDragging}
          />
        ))}
        {leads.length === 0 && isDroppable && (
          <p className="text-xs text-slate-400 px-1">No leads in this stage.</p>
        )}
      </div>
    </div>
  );
}
