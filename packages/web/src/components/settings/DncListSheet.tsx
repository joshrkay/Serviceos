import { useEffect, useState, FormEvent } from 'react';
import { Trash2, AlertCircle, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useApiClient } from '../../lib/apiClient';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';

/**
 * Do-Not-Call list management — Settings sheet.
 *
 * Lists every number on the tenant's DNC registry (newest first) and
 * lets an operator add or remove entries. The DNC list overrides any
 * per-customer consent: a number on it is refused by the outbound
 * gate (`voice/outbound-consent.ts`) regardless of `consent_status`.
 *
 * Mirrors the rest of the Settings sheets — controlled `open` /
 * `onOpenChange`, optimistic local state, toast feedback.
 */

interface DncEntry {
  phone: string;
  source: string;
  createdAt: string; // ISO
}

interface DncListResponse {
  entries: DncEntry[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DncListSheet({ open, onOpenChange }: Props) {
  const apiFetch = useApiClient();
  const tz = useTenantTimezone();
  const [entries, setEntries] = useState<DncEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch('/api/dnc')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load DNC list (HTTP ${res.status})`);
        return (await res.json()) as DncListResponse;
      })
      .then((data) => {
        if (!cancelled) setEntries(data.entries);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    const phone = newPhone.trim();
    if (!phone) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/dnc', {
        method: 'POST',
        body: JSON.stringify({ phone, source: 'manual_settings' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `Add failed (HTTP ${res.status})`);
      }
      const added = (await res.json()) as { phone: string; source: string };
      // Optimistic prepend. Server-stamped createdAt isn't returned by
      // POST; use 'now' so the row sorts to the top until the next
      // open re-fetches.
      setEntries((prev) => [
        { phone: added.phone, source: added.source, createdAt: new Date().toISOString() },
        ...prev.filter((e) => e.phone !== added.phone),
      ]);
      setNewPhone('');
      toast.success(`Added ${added.phone} to DNC list`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Add failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(phone: string) {
    setRemoving(phone);
    setError(null);
    try {
      const res = await apiFetch(`/api/dnc/${encodeURIComponent(phone)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `Remove failed (HTTP ${res.status})`);
      }
      setEntries((prev) => prev.filter((e) => e.phone !== phone));
      toast.success(`Removed ${phone} from DNC list`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Remove failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setRemoving(null);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Do-Not-Call list"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 backdrop-blur-sm md:items-center"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-2xl bg-white rounded-t-2xl md:rounded-2xl shadow-xl border border-slate-200 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-slate-100 flex items-start gap-3">
          <div className="size-10 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
            <ShieldOff size={18} className="text-red-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-slate-900">Do-Not-Call list</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Numbers on this list will never receive outbound calls — overrides any granted consent.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-slate-400 hover:text-slate-600 text-sm"
          >
            Close
          </button>
        </div>

        <form onSubmit={handleAdd} className="px-6 py-4 border-b border-slate-100 flex gap-2">
          <input
            type="tel"
            placeholder="+1 555 123 4567"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            disabled={saving}
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            data-testid="dnc-phone-input"
          />
          <button
            type="submit"
            disabled={saving || !newPhone.trim()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
            data-testid="dnc-add-button"
          >
            {saving ? 'Adding…' : 'Add'}
          </button>
        </form>

        {error && (
          <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div className="px-6 py-4">
          {loading && <p className="text-sm text-slate-500">Loading…</p>}
          {!loading && entries.length === 0 && (
            <p className="text-sm text-slate-500" data-testid="dnc-empty">
              No numbers on the DNC list yet.
            </p>
          )}
          {!loading && entries.length > 0 && (
            <ul className="divide-y divide-slate-100" data-testid="dnc-entries">
              {entries.map((entry) => (
                <li key={entry.phone} className="py-3 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-800 font-mono">{entry.phone}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {entry.source} · added {formatDateTimeInTenantTz(entry.createdAt, tz)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(entry.phone)}
                    disabled={removing === entry.phone}
                    aria-label={`Remove ${entry.phone}`}
                    className="text-slate-400 hover:text-red-600 disabled:opacity-50"
                    data-testid={`dnc-remove-${entry.phone}`}
                  >
                    {removing === entry.phone ? <span className="text-xs">…</span> : <Trash2 size={16} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
