/**
 * Dispatch FR-2 phase 2 — the skills a job needs. Assigning a technician who
 * lacks one is blocked by the dispatch skill check, so editing follows
 * `jobs:assign` (owners and dispatchers); everyone else sees the list.
 */
import { useState } from 'react';
import { Pencil, Wrench } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { SkillChips, SkillTagsEditor } from '../shared/SkillTagsEditor';

interface RequiredSkillsCardProps {
  jobId: string;
  requiredSkills: readonly string[];
  canEdit: boolean;
  onSaved: () => void;
}

export function RequiredSkillsCard({ jobId, requiredSkills, canEdit, onSaved }: RequiredSkillsCardProps) {
  const apiFetch = useApiClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(tags: string[]) {
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: 'PUT',
        body: JSON.stringify({ requiredSkills: tags }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON body */
        }
        throw new Error(detail || `Could not save required skills (HTTP ${res.status})`);
      }
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save required skills');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="job-required-skills" className="rounded-xl bg-card border border-border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Wrench size={14} className="text-muted-foreground" />
        <p className="flex-1 text-sm font-medium text-foreground">Required skills</p>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={() => {
              setError('');
              setEditing(true);
            }}
            aria-label="Edit required skills"
            data-testid="job-required-skills-edit"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil size={14} />
          </button>
        )}
      </div>
      {editing ? (
        <SkillTagsEditor
          idPrefix="job-required-skills"
          label="Required skills"
          initial={requiredSkills}
          saving={saving}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : requiredSkills.length > 0 ? (
        <SkillChips tags={requiredSkills} testId="job-required-skills-list" />
      ) : (
        <p className="text-xs text-muted-foreground">None. Any technician can take this job.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
