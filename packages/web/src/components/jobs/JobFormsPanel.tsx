import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Input, Select, Textarea } from '../ui';
import {
  type JobFormField,
  type JobFormSubmission,
  type JobFormTemplate,
  createJobFormSubmission as createSubmissionApi,
  listJobFormSubmissions as listSubmissionsApi,
  listJobFormTemplates as listTemplatesApi,
  updateJobFormSubmission as updateSubmissionApi,
} from '../../api/job-forms';

/**
 * J-FORM (Jobber parity) — fill & complete job forms/checklists on a job.
 *
 * Lists the job's form submissions, lets a tech add one from a tenant
 * template, fill typed answers, and mark it complete (a completed form is
 * read-only history). Talks to /api/job-forms. API fns are injectable so the
 * panel renders in jsdom without a network (mirrors PhotoBucket's fetchPhotos).
 */
export interface JobFormsPanelApi {
  listTemplates: typeof listTemplatesApi;
  listSubmissions: typeof listSubmissionsApi;
  createSubmission: typeof createSubmissionApi;
  updateSubmission: typeof updateSubmissionApi;
}

const DEFAULT_API: JobFormsPanelApi = {
  listTemplates: listTemplatesApi,
  listSubmissions: listSubmissionsApi,
  createSubmission: createSubmissionApi,
  updateSubmission: updateSubmissionApi,
};

type DraftMap = Record<string, string>;

export function JobFormsPanel({
  jobId,
  api = DEFAULT_API,
}: {
  jobId: string;
  api?: JobFormsPanelApi;
}) {
  const [templates, setTemplates] = useState<JobFormTemplate[]>([]);
  const [submissions, setSubmissions] = useState<JobFormSubmission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftMap>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [tpls, subs] = await Promise.all([
        api.listTemplates(),
        api.listSubmissions(jobId),
      ]);
      setTemplates(tpls);
      setSubmissions(subs);
      setDrafts(Object.fromEntries(subs.map((s) => [s.id, answersToDraft(s)])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load forms');
    }
  }, [api, jobId]);

  useEffect(() => {
    setTemplates([]);
    setSubmissions([]);
    void load();
  }, [load]);

  const addForm = useCallback(async () => {
    if (!selectedTemplate) return;
    setAdding(true);
    try {
      const created = await api.createSubmission(jobId, { templateId: selectedTemplate });
      setSubmissions((prev) => [...prev, created]);
      setDrafts((prev) => ({ ...prev, [created.id]: answersToDraft(created) }));
      setExpandedId(created.id);
      setSelectedTemplate('');
      toast.success(`${created.templateName} added`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add form');
    } finally {
      setAdding(false);
    }
  }, [api, jobId, selectedTemplate]);

  const save = useCallback(
    async (sub: JobFormSubmission, complete: boolean) => {
      setSavingId(sub.id);
      try {
        const answers = draftToAnswers(sub.fields, drafts[sub.id] ?? {});
        const updated = await api.updateSubmission(sub.id, { answers, complete });
        setSubmissions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        setDrafts((prev) => ({ ...prev, [updated.id]: answersToDraft(updated) }));
        if (complete) setExpandedId(null);
        toast.success(complete ? `${updated.templateName} completed` : 'Saved');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save form');
      } finally {
        setSavingId(null);
      }
    },
    [api, drafts],
  );

  const activeTemplates = useMemo(() => templates.filter((t) => !t.isArchived), [templates]);

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5 border-b border-border">
        <div className="flex items-center gap-2">
          <ClipboardList size={14} className="text-muted-foreground" />
          <h4 className="text-foreground">Forms &amp; Checklists</h4>
          {submissions.length > 0 && (
            <span className="text-xs bg-secondary text-muted-foreground rounded-full px-2 py-0.5">
              {submissions.length}
            </span>
          )}
        </div>
        {activeTemplates.length > 0 && (
          <div className="flex items-center gap-2">
            <Select
              aria-label="Choose a form template"
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              className="min-h-11 text-xs"
            >
              <option value="">Add a form…</option>
              {activeTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={addForm}
              disabled={!selectedTemplate || adding}
              className="flex items-center gap-1 min-h-11 px-3 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50"
            >
              <Plus size={12} /> {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
        )}
      </div>

      <div className="p-3 flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!error && submissions.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            {activeTemplates.length === 0
              ? 'No form templates yet. Create them in settings to use checklists on jobs.'
              : 'No forms on this job yet. Add one above.'}
          </p>
        )}

        {submissions.map((sub) => {
          const isExpanded = expandedId === sub.id;
          const isCompleted = sub.status === 'completed';
          const draft = drafts[sub.id] ?? {};
          return (
            <div key={sub.id} className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : sub.id)}
                className="w-full flex items-center justify-between gap-2 min-h-11 px-3 py-2 text-left"
              >
                <span className="text-sm text-foreground font-medium truncate">
                  {sub.templateName}
                </span>
                <StatusBadge status={sub.status} />
              </button>

              {isExpanded && (
                <div className="px-3 pb-3 flex flex-col gap-3 border-t border-border pt-3">
                  {sub.fields.map((field) => (
                    <FieldControl
                      key={field.id}
                      field={field}
                      value={draft[field.id] ?? ''}
                      disabled={isCompleted || savingId === sub.id}
                      onChange={(v) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [sub.id]: { ...(prev[sub.id] ?? {}), [field.id]: v },
                        }))
                      }
                    />
                  ))}

                  {isCompleted ? (
                    <p className="text-xs text-muted-foreground">
                      Completed{sub.completedAt ? ` ${new Date(sub.completedAt).toLocaleDateString()}` : ''} —
                      this record is locked.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => save(sub, false)}
                        disabled={savingId === sub.id}
                        className="min-h-11 px-3 rounded-lg border border-border text-xs text-foreground disabled:opacity-50"
                      >
                        {savingId === sub.id ? 'Saving…' : 'Save draft'}
                      </button>
                      <button
                        type="button"
                        onClick={() => save(sub, true)}
                        disabled={savingId === sub.id}
                        className="min-h-11 px-3 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50"
                      >
                        Mark complete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: JobFormSubmission['status'] }) {
  const completed = status === 'completed';
  return (
    <span
      className={`shrink-0 text-xs rounded-full px-2 py-0.5 ${
        completed ? 'bg-success/15 text-success' : 'bg-secondary text-muted-foreground'
      }`}
    >
      {completed ? 'Completed' : 'Draft'}
    </span>
  );
}

function FieldControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: JobFormField;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const label = (
    <span className="text-xs text-muted-foreground">
      {field.label}
      {field.required && <span className="text-destructive"> *</span>}
    </span>
  );

  if (field.fieldType === 'checkbox') {
    return (
      <label className="flex items-center gap-2 min-h-11">
        <input
          type="checkbox"
          aria-label={field.label}
          checked={value === 'true'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          className="h-5 w-5"
        />
        {label}
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      {label}
      {field.fieldType === 'select' ? (
        <Select
          aria-label={field.label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-11"
        >
          <option value="">—</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      ) : field.fieldType === 'textarea' ? (
        <Textarea
          aria-label={field.label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          aria-label={field.label}
          type={field.fieldType === 'number' ? 'number' : field.fieldType === 'date' ? 'date' : 'text'}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-11"
        />
      )}
    </label>
  );
}

function answersToDraft(sub: JobFormSubmission): DraftMap {
  const out: DraftMap = {};
  for (const field of sub.fields) {
    out[field.id] = field.fieldType === 'checkbox' ? 'false' : '';
  }
  for (const ans of sub.answers) {
    if (ans.value !== null) out[ans.fieldId] = ans.value;
  }
  return out;
}

function draftToAnswers(
  fields: JobFormField[],
  draft: DraftMap,
): { fieldId: string; value: string | null }[] {
  return fields.map((field) => {
    const raw = draft[field.id] ?? '';
    const value = raw.trim() === '' ? null : raw;
    return { fieldId: field.id, value };
  });
}
