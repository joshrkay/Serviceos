import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Search } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { Button, Input } from '../ui';

/**
 * Story 4.6 — merge a duplicate into this customer.
 *
 * The current customer is the survivor (chosen explicitly by being on this
 * page); the operator searches for the duplicate (the loser), confirms, and
 * the server re-parents the loser's history onto the survivor and archives
 * it. Mirrors the deterministic POST /api/customers/:id/merge contract.
 */
interface CandidateCustomer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
  isArchived?: boolean;
}

interface MergeCustomerPanelProps {
  survivingId: string;
  survivingName: string;
  onMerged: () => void;
}

function candidateName(c: CandidateCustomer): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown';
}

export function MergeCustomerPanel({
  survivingId,
  survivingName,
  onMerged,
}: MergeCustomerPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CandidateCustomer[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const q = query.trim();
      if (q.length < 2) return;
      setSearching(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/customers?search=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const rows: CandidateCustomer[] = Array.isArray(json) ? json : json.data ?? [];
        // The survivor can never be its own duplicate, and archived rows are
        // already out of play.
        setResults(rows.filter((c) => c.id !== survivingId && !c.isArchived));
        setSearched(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setSearching(false);
      }
    },
    [query, survivingId],
  );

  const handleMerge = useCallback(
    async (losingId: string) => {
      setMerging(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/customers/${survivingId}/merge`, {
          method: 'POST',
          body: JSON.stringify({ losingId }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        toast.success('Customers merged');
        setResults([]);
        setQuery('');
        setSearched(false);
        setConfirmId(null);
        onMerged();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Merge failed';
        setError(message);
        toast.error(message);
      } finally {
        setMerging(false);
      }
    },
    [survivingId, onMerged],
  );

  return (
    <div className="flex flex-col gap-3" data-testid="merge-customer-panel">
      <p className="text-sm text-slate-500">
        Find a duplicate to fold into <span className="text-slate-700">{survivingName}</span>.
        Their jobs, invoices and conversations move here, and the duplicate is
        archived.
      </p>

      <form onSubmit={handleSearch} className="flex gap-2">
        <Input
          aria-label="Search duplicates"
          placeholder="Search name, phone, or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" loading={searching}>
          <Search size={14} className="mr-1.5" />
          Search
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {searched && results.length === 0 && !searching && (
        <p className="text-sm text-slate-400">No other matching customers.</p>
      )}

      <div className="flex flex-col gap-2">
        {results.map((c) => (
          <div
            key={c.id}
            className="rounded-xl border border-slate-200 p-3"
            data-testid={`merge-candidate-${c.id}`}
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-900">{candidateName(c)}</p>
                <p className="text-xs text-slate-400 truncate">
                  {c.primaryPhone || c.email || '—'}
                </p>
              </div>
              {confirmId === c.id ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmId(c.id)}
                >
                  Merge
                </Button>
              )}
            </div>

            {confirmId === c.id && (
              <div className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                  <p className="text-xs text-amber-800">
                    Move all history from <strong>{candidateName(c)}</strong> into{' '}
                    <strong>{survivingName}</strong> and archive {candidateName(c)}? The
                    duplicate is archived, not deleted.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={merging}
                    onClick={() => handleMerge(c.id)}
                  >
                    Confirm merge
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={merging}
                    onClick={() => setConfirmId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
