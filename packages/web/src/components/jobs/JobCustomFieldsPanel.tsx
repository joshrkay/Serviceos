import React, { useCallback, useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { Input, Select } from '../ui';
import {
  type ResolvedJobCustomField,
  listJobCustomFields as listApi,
  setJobCustomFieldValue as setApi,
} from '../../api/job-custom-fields';

/**
 * J-CF (Jobber parity) — per-job custom field values.
 *
 * Renders one typed control per active job custom field and persists on blur
 * (text/number/date) or change (select). Definitions are managed in settings;
 * this panel only edits values. API fns are injectable for jsdom. Mirrors the
 * customer CustomFieldsPanel.
 */
export interface JobCustomFieldsPanelApi {
  list: typeof listApi;
  setValue: typeof setApi;
}

const DEFAULT_API: JobCustomFieldsPanelApi = { list: listApi, setValue: setApi };

export function JobCustomFieldsPanel({
  jobId,
  api = DEFAULT_API,
}: {
  jobId: string;
  api?: JobCustomFieldsPanelApi;
}) {
  const [fields, setFields] = useState<ResolvedJobCustomField[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback((rows: ResolvedJobCustomField[]) => {
    setFields(rows);
    setDrafts(Object.fromEntries(rows.map((f) => [f.fieldDefId, f.value ?? ''])));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      hydrate(await api.list(jobId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load custom fields');
    }
  }, [api, jobId, hydrate]);

  useEffect(() => {
    setFields([]);
    setDrafts({});
    void load();
  }, [load]);

  const save = useCallback(
    async (field: ResolvedJobCustomField, raw: string) => {
      const next = raw.trim() === '' ? null : raw;
      if ((field.value ?? '') === (next ?? '')) return;
      try {
        const updated = await api.setValue(jobId, field.fieldDefId, next);
        setFields(updated);
        const saved = updated.find((f) => f.fieldDefId === field.fieldDefId);
        setDrafts((prev) => ({ ...prev, [field.fieldDefId]: saved?.value ?? '' }));
        toast.success(`${field.label} saved`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save custom field');
      }
    },
    [api, jobId],
  );

  if (fields.length === 0 && !error) return null; // nothing to show until defs exist

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-border">
        <SlidersHorizontal size={14} className="text-muted-foreground" />
        <h4 className="text-foreground">Custom Fields</h4>
      </div>
      <div className="p-3 flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {fields.map((field) => {
          const draft = drafts[field.fieldDefId] ?? '';
          const onDraft = (v: string) => setDrafts((p) => ({ ...p, [field.fieldDefId]: v }));
          return (
            <label key={field.fieldDefId} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{field.label}</span>
              {field.fieldType === 'select' ? (
                <Select
                  aria-label={field.label}
                  value={draft}
                  className="min-h-11"
                  onChange={(e) => {
                    onDraft(e.target.value);
                    void save(field, e.target.value);
                  }}
                >
                  <option value="">—</option>
                  {field.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  aria-label={field.label}
                  type={
                    field.fieldType === 'number' ? 'number' : field.fieldType === 'date' ? 'date' : 'text'
                  }
                  value={draft}
                  className="min-h-11"
                  onChange={(e) => onDraft(e.target.value)}
                  onBlur={(e) => save(field, e.target.value)}
                />
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
