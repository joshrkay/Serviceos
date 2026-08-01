import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { LeadStageColumn } from '../../components/leads/LeadStageColumn';
import { LeadCardData } from '../../components/leads/LeadCard';
import { apiFetch } from '../../utils/api-fetch';
import { Button, Input, Spinner } from '../../components/ui';

const STAGES: { key: string; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'quoted', label: 'Quoted' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];

const SOURCES = [
  'web_form',
  'phone_call',
  'referral',
  'walk_in',
  'marketplace',
  'other',
];

interface LeadResponse extends LeadCardData {
  stage: string;
}

interface ListResponse {
  data: LeadResponse[];
  total: number;
}

export interface LeadListProps {
  /** Called when a lead card is clicked. Routes to LeadDetail. */
  onSelectLead?: (id: string) => void;
  /** Called when "New Lead" is clicked. */
  onNewLead?: () => void;
}

export function LeadList({ onSelectLead, onNewLead }: LeadListProps) {
  const [leads, setLeads] = useState<LeadResponse[]>([]);
  // Start true so the first paint doesn't flash empty columns before fetch.
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  const [draggingLeadId, setDraggingLeadId] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const refetch = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true && hasLoadedRef.current;
    if (!background) setLoading(true);
    if (!background) setError(null);
    try {
      const params = new URLSearchParams();
      if (sourceFilter) params.set('source', sourceFilter);
      if (assigneeFilter) params.set('assignedUserId', assigneeFilter);
      params.set('limit', '200');
      const res = await apiFetch(`/api/leads?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ListResponse;
      hasLoadedRef.current = true;
      setLeads(json.data);
      setError(null);
    } catch (err) {
      if (background) return;
      setError(err instanceof Error ? err.message : 'Failed to load leads');
    } finally {
      if (!background) setLoading(false);
    }
  }, [sourceFilter, assigneeFilter]);

  useEffect(() => {
    // Filter changes are cold (new result set); keep hasLoaded so a failed
    // optimistic rollback can still background-refresh.
    void refetch({ background: false });
  }, [refetch]);

  const byStage = useMemo(() => {
    const buckets: Record<string, LeadResponse[]> = {};
    for (const stage of STAGES) buckets[stage.key] = [];
    for (const lead of leads) {
      const bucket = buckets[lead.stage];
      if (bucket) bucket.push(lead);
    }
    return buckets;
  }, [leads]);

  const handleDropLead = useCallback(
    async (leadId: string, toStage: string) => {
      const lead = leads.find((l) => l.id === leadId);
      if (!lead || lead.stage === toStage) return;

      // Block direct drag → won / lost. Won = explicit convert action;
      // lost = lose endpoint with a reason.
      if (toStage === 'won') {
        setError('Use the Convert action on a lead to mark it Won.');
        return;
      }
      if (toStage === 'lost') {
        setError('Use the Lose action on a lead to mark it Lost.');
        return;
      }

      // Optimistic update
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, stage: toStage } : l))
      );
      try {
        const res = await apiFetch(`/api/leads/${leadId}`, {
          method: 'PATCH',
          body: JSON.stringify({ stage: toStage }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update stage');
        // Roll back optimistic update by refetching (background — keep columns)
        await refetch({ background: true });
      }
    },
    [leads, refetch]
  );

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-slate-900">Lead Pipeline</h1>
        <Button size="sm" onClick={onNewLead} leftIcon={<Plus size={14} />}>
          New Lead
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-slate-500">Source:</span>
        <button
          type="button"
          onClick={() => setSourceFilter(null)}
          className={`text-xs rounded-full px-3 py-1 border ${
            sourceFilter === null
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
          }`}
        >
          All
        </button>
        {SOURCES.map((src) => (
          <button
            key={src}
            type="button"
            onClick={() => setSourceFilter(src)}
            className={`text-xs rounded-full px-3 py-1 border ${
              sourceFilter === src
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
            }`}
          >
            {src}
          </button>
        ))}
        <span className="text-xs text-slate-500 ml-3">Assignee:</span>
        <Input
          type="text"
          value={assigneeFilter ?? ''}
          onChange={(e) => setAssigneeFilter(e.target.value || null)}
          placeholder="user id"
          className="w-40 px-2.5 py-1.5 text-xs"
        />
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {isLoading && leads.length === 0 && (
        <p className="mb-3 flex items-center gap-2 text-sm text-slate-500">
          <Spinner size="sm" className="text-slate-400" /> Loading…
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {STAGES.map((stage) => (
          <LeadStageColumn
            key={stage.key}
            stage={stage.key}
            label={stage.label}
            leads={byStage[stage.key] ?? []}
            onCardClick={onSelectLead}
            onDropLead={handleDropLead}
            onDragStartLead={setDraggingLeadId}
            onDragEndLead={() => setDraggingLeadId(null)}
            draggingLeadId={draggingLeadId}
          />
        ))}
      </div>
    </div>
  );
}
