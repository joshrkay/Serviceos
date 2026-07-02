/**
 * UB-A4 (agent wave) — standing instructions settings sheet.
 *
 * Owner-managed directives the AI applies when drafting (estimates, invoices,
 * replies): list active ones, add new ones, deactivate stale ones. Mirrors
 * CustomerGroupsSheet's structure. Instructions created here are source
 * 'settings'; ones minted by voice ("from now on, always…") arrive with
 * source 'proposal' and show a Voice badge.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, ScrollText, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '../ui';
import {
  type StandingInstruction,
  type StandingInstructionScope,
  createStandingInstruction as createApi,
  deactivateStandingInstruction as deactivateApi,
  listStandingInstructions as listApi,
} from '../../api/standing-instructions';

export interface StandingInstructionsSheetApi {
  list: typeof listApi;
  create: typeof createApi;
  deactivate: typeof deactivateApi;
}

const DEFAULT_API: StandingInstructionsSheetApi = {
  list: listApi,
  create: createApi,
  deactivate: deactivateApi,
};

/** Succinct one-line scope summary: intents / trades / segment, or "everywhere". */
export function scopeSummary(scope: StandingInstructionScope | undefined): string {
  const parts: string[] = [];
  if (scope?.intents && scope.intents.length > 0) {
    parts.push(scope.intents.map((i) => i.replace(/_/g, ' ')).join(', '));
  }
  if (scope?.tradeCategories && scope.tradeCategories.length > 0) {
    parts.push(scope.tradeCategories.join(', '));
  }
  if (scope?.customerSegment && scope.customerSegment !== 'all') {
    parts.push(`${scope.customerSegment} customers`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Applies to all drafts';
}

export function StandingInstructionsSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: StandingInstructionsSheetApi;
}) {
  const [instructions, setInstructions] = useState<StandingInstruction[]>([]);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setInstructions(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load standing instructions');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setError('');
    const instruction = text.trim();
    if (!instruction) {
      setError('Write the instruction first.');
      return;
    }
    setSaving(true);
    try {
      await api.create({ instruction });
      setText('');
      await load();
      toast.success('Standing instruction added');
    } catch (err) {
      // Includes the 422 active-cap error ("deactivate one before adding
      // another") — surfaced verbatim from the server.
      const message = err instanceof Error ? err.message : 'Could not add the instruction';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (si: StandingInstruction) => {
    try {
      await api.deactivate(si.id);
      await load();
      toast.success('Instruction deactivated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not deactivate the instruction');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="standing-instructions-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
              <ScrollText size={16} />
            </span>
            <h2 id="standing-instructions-title" className="text-base font-semibold">
              Standing instructions
            </h2>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex items-center justify-center min-h-11 min-w-11 rounded-lg text-slate-400 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Rules the AI follows every time it drafts — like “always add a trip fee” or “mention
            the referral discount”. They shape draft content only; you still approve everything.
          </p>

          {instructions.length === 0 && (
            <p className="text-sm text-slate-400 italic">No standing instructions yet.</p>
          )}
          {instructions.map((si) => (
            <div
              key={si.id}
              className="flex items-start justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm">{si.instruction}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span
                    data-testid="instruction-source-badge"
                    className="inline-flex items-center rounded-full border border-border bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {si.source === 'proposal' ? 'Voice' : 'Settings'}
                  </span>
                  <span data-testid="instruction-scope" className="text-xs text-slate-400">
                    {scopeSummary(si.scope)}
                  </span>
                </div>
              </div>
              <button
                aria-label={`Deactivate ${si.instruction}`}
                onClick={() => deactivate(si)}
                className="flex items-center justify-center min-h-11 px-2 rounded-lg text-slate-400 hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          <div className="rounded-lg border border-border p-3 flex items-center gap-2">
            <Input
              aria-label="New standing instruction"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-11 flex-1"
              placeholder="e.g. Always add a $50 trip fee to estimates"
            />
            <button
              onClick={add}
              disabled={saving}
              className="flex items-center gap-1 min-h-11 px-3 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              <Plus size={14} /> {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
