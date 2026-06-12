/**
 * One-tap disambiguation for voice_clarification proposals (ambiguous_entity)
 * and catalog ambiguity markers on draft payloads.
 */
import { useState } from 'react';

export interface EntityCandidate {
  id: string;
  label: string;
  hint?: string;
  score: number;
}

export interface ClarificationPickerProps {
  proposalId: string;
  candidates: EntityCandidate[];
  entityKind?: string;
  onResolved: () => void;
  onPatch: (
    proposalId: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
}

export function ClarificationPicker({
  proposalId,
  candidates,
  entityKind = 'customer',
  onResolved,
  onPatch,
}: ClarificationPickerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(candidate: EntityCandidate) {
    setBusyId(candidate.id);
    setError(null);
    try {
      await onPatch(proposalId, {
        resolvedEntityId: candidate.id,
        resolvedEntityKind: entityKind,
        entityCandidates: [],
      });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply choice');
    } finally {
      setBusyId(null);
    }
  }

  if (candidates.length === 0) return null;

  return (
    <div
      data-testid="clarification-picker"
      className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
    >
      <p className="text-xs font-medium text-amber-900 mb-2">Which one did you mean?</p>
      <ul className="flex flex-col gap-1.5">
        {candidates.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void pick(c)}
              className="w-full min-h-11 text-left rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm hover:bg-amber-100/50 disabled:opacity-50"
            >
              <span className="font-medium text-slate-900">{c.label}</span>
              {c.hint ? (
                <span className="block text-xs text-slate-500">{c.hint}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-red-600 mt-1">
          {error}
        </p>
      ) : null}
    </div>
  );
}
