import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LeadStageColumn } from '../../components/leads/LeadStageColumn';
import { LeadCardData } from '../../components/leads/LeadCard';
import { apiFetch } from '../../utils/api-fetch';

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
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (sourceFilter) params.set('source', sourceFilter);
      if (assigneeFilter) params.set('assignedUserId', assigneeFilter);
      params.set('limit', '200');
      const res = await apiFetch(`/api/leads?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setLeads(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leads');
    } finally {
      setLoading(false);
    }
  }, [sourceFilter, assigneeFilter]);

  useEffect(() => {
    void refetch();
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
        // Roll back optimistic update by refetching
        await refetch();
      }
    },
    [leads, refetch]
  );

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg text-slate-900">Lead Pipeline</h1>
        <button
          type="button"
          onClick={onNewLead}
          className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 hover:bg-slate-800"
        >
          New Lead
        </button>
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
        <input
          type="text"
          value={assigneeFilter ?? ''}
          onChange={(e) => setAssigneeFilter(e.target.value || null)}
          placeholder="user id"
          className="text-xs rounded-lg border border-slate-200 px-2 py-1 w-40"
        />
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {isLoading && <p className="text-sm text-slate-500 mb-3">Loading...</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {STAGES.map((stage) => (
          <LeadStageColumn
            key={stage.key}
            stage={stage.key}
            label={stage.label}
            leads={byStage[stage.key] ?? []}
            onCardClick={onSelectLead}
            onDropLead={handleDropLead}
          />
        ))}
      </div>
    </div>
  );
}
