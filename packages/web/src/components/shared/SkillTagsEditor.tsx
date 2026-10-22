/**
 * Dispatch FR-2 phase 2 — skill tags. A technician's skills (team sheet) and a
 * job's required skills (job detail) use the same chips and editor. Tags are
 * shown in the canonical form the API stores (`normalizeSkillTag`), so what
 * the owner sees here is exactly what the feasibility skill check compares.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { MAX_SKILL_TAGS, normalizeSkillTag } from '@ai-service-os/shared';

export function SkillChips({ tags, testId }: { tags: readonly string[]; testId?: string }) {
  if (tags.length === 0) return null;
  return (
    <ul data-testid={testId} className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <li key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
          {t}
        </li>
      ))}
    </ul>
  );
}

interface SkillTagsEditorProps {
  /** Unique per instance; prefixes element ids and test ids. */
  idPrefix: string;
  label: string;
  initial: readonly string[];
  saving?: boolean;
  onSave: (tags: string[]) => void | Promise<void>;
  onCancel: () => void;
}

export function SkillTagsEditor({ idPrefix, label, initial, saving, onSave, onCancel }: SkillTagsEditorProps) {
  const [tags, setTags] = useState<string[]>([...initial]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  /** `tags` with the typed draft applied, or null (and an error shown) when the draft is unusable. */
  function withDraft(): string[] | null {
    if (draft.trim() === '') return tags;
    const tag = normalizeSkillTag(draft);
    if (tag === null) {
      setError('Use letters, numbers, spaces, - or _ (up to 40 characters).');
      return null;
    }
    if (tags.includes(tag)) return tags;
    if (tags.length >= MAX_SKILL_TAGS) {
      setError(`At most ${MAX_SKILL_TAGS} skills.`);
      return null;
    }
    return [...tags, tag];
  }

  function add(): string[] | null {
    const next = withDraft();
    if (next === null) return null;
    setTags(next);
    setDraft('');
    setError('');
    return next;
  }

  function save() {
    // A typed-but-not-added tag is saved too, rather than silently lost.
    const next = add();
    if (next !== null) void onSave(next);
  }

  return (
    <div data-testid={`${idPrefix}-editor`} className="w-full space-y-2">
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <li key={t} className="flex items-center rounded-full bg-muted pl-2.5 text-xs text-foreground">
              {t}
              <button
                type="button"
                onClick={() => setTags(tags.filter((x) => x !== t))}
                disabled={saving}
                aria-label={`Remove ${t}`}
                className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No skills yet.</p>
      )}
      <div className="flex min-w-0 gap-2">
        <label htmlFor={`${idPrefix}-input`} className="sr-only">
          {label}
        </label>
        <input
          id={`${idPrefix}-input`}
          data-testid={`${idPrefix}-input`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          disabled={saving}
          placeholder="e.g. gas certified"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm"
        />
        <button
          type="button"
          onClick={add}
          disabled={saving}
          className="min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          Add
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-11 min-w-11 rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid={`${idPrefix}-save`}
          onClick={save}
          disabled={saving}
          className="min-h-11 min-w-11 rounded-lg bg-primary px-3 text-sm text-primary-foreground disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
