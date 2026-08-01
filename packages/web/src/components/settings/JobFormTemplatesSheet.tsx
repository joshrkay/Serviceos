/**
 * J-FORM (Jobber parity) — job form & checklist template builder.
 *
 * Lets a tenant create/edit/archive reusable job-form templates (the
 * "form builder" Jobber ships). Field types: text, textarea, number, date,
 * checkbox, select (with options). Talks to /api/job-forms/templates. API fns
 * are injectable so the sheet renders in jsdom without a network.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, ClipboardList, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Input, Select, Textarea } from '../ui';
import {
  type JobFormFieldInput,
  type JobFormFieldType,
  type JobFormTemplate,
  archiveJobFormTemplate as archiveApi,
  createJobFormTemplate as createApi,
  listJobFormTemplates as listApi,
  updateJobFormTemplate as updateApi,
} from '../../api/job-forms';

export interface JobFormTemplatesSheetApi {
  list: typeof listApi;
  create: typeof createApi;
  update: typeof updateApi;
  archive: typeof archiveApi;
}

const DEFAULT_API: JobFormTemplatesSheetApi = {
  list: listApi,
  create: createApi,
  update: updateApi,
  archive: archiveApi,
};

const FIELD_TYPES: { value: JobFormFieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'select', label: 'Dropdown' },
];

interface DraftField {
  id?: string;
  label: string;
  fieldType: JobFormFieldType;
  required: boolean;
  optionsText: string;
}

function emptyField(): DraftField {
  return { label: '', fieldType: 'text', required: false, optionsText: '' };
}

function toDraftFields(tpl: JobFormTemplate): DraftField[] {
  return tpl.fields.map((f) => ({
    id: f.id,
    label: f.label,
    fieldType: f.fieldType,
    required: f.required,
    optionsText: f.options.join(', '),
  }));
}

function toFieldInputs(fields: DraftField[]): JobFormFieldInput[] {
  return fields.map((f) => ({
    id: f.id,
    label: f.label.trim(),
    fieldType: f.fieldType,
    required: f.required,
    options:
      f.fieldType === 'select'
        ? f.optionsText.split(',').map((o) => o.trim()).filter(Boolean)
        : [],
  }));
}

export function JobFormTemplatesSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: JobFormTemplatesSheetApi;
}) {
  const [templates, setTemplates] = useState<JobFormTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null); // null = list, 'new' = create
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<DraftField[]>([emptyField()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTemplates(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const startNew = () => {
    setEditingId('new');
    setName('');
    setDescription('');
    setFields([emptyField()]);
    setError('');
  };

  const startEdit = (tpl: JobFormTemplate) => {
    setEditingId(tpl.id);
    setName(tpl.name);
    setDescription(tpl.description ?? '');
    setFields(toDraftFields(tpl));
    setError('');
  };

  const save = async () => {
    setError('');
    const cleanFields = toFieldInputs(fields).filter((f) => f.label.length > 0);
    if (!name.trim()) {
      setError('Give the form a name.');
      return;
    }
    if (cleanFields.length === 0) {
      setError('Add at least one field.');
      return;
    }
    setSaving(true);
    try {
      const input = { name: name.trim(), description: description.trim() || null, fields: cleanFields };
      if (editingId === 'new') {
        await api.create(input);
        toast.success('Form template created');
      } else if (editingId) {
        await api.update(editingId, input);
        toast.success('Form template updated');
      }
      await load();
      setEditingId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save template';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const archive = async (tpl: JobFormTemplate) => {
    try {
      await api.archive(tpl.id);
      toast.success(`${tpl.name} archived`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not archive');
    }
  };

  const updateField = (i: number, patch: Partial<DraftField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="job-forms-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <ClipboardList size={16} className="text-slate-700" />
          </span>
          <h2 id="job-forms-title" className="flex-1 text-base text-slate-900">
            Forms &amp; Checklists
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {error && (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {editingId === null ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-slate-500">
                Build reusable checklists and forms your team fills out on a job.
              </p>
              {templates.length === 0 && (
                <p className="text-sm text-slate-400 italic">No templates yet.</p>
              )}
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-slate-900 truncate">{tpl.name}</p>
                    <p className="text-xs text-slate-500">
                      {tpl.fields.length} field{tpl.fields.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEdit(tpl)}
                      className="min-h-11 px-3 rounded-lg border border-border text-xs text-slate-700"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Archive ${tpl.name}`}
                      onClick={() => archive(tpl)}
                      className="flex items-center justify-center min-h-11 px-2 rounded-lg text-slate-400 hover:text-destructive"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={startNew}
                className="flex items-center justify-center gap-1 min-h-11 rounded-lg bg-primary text-primary-foreground text-sm"
              >
                <Plus size={14} /> New template
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-500">Form name</span>
                <Input
                  aria-label="Form name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="min-h-11"
                  placeholder="e.g. Furnace Tune-Up Checklist"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-500">Description (optional)</span>
                <Textarea
                  aria-label="Description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              <div className="flex flex-col gap-3">
                <span className="text-xs font-medium text-slate-600">Fields</span>
                {fields.map((field, i) => (
                  <div key={i} className="rounded-lg border border-border p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Field ${i + 1} label`}
                        value={field.label}
                        onChange={(e) => updateField(i, { label: e.target.value })}
                        className="min-h-11 flex-1"
                        placeholder="Field label"
                      />
                      <button
                        type="button"
                        aria-label={`Remove field ${i + 1}`}
                        onClick={() => setFields((prev) => prev.filter((_, idx) => idx !== i))}
                        className="flex items-center justify-center min-h-11 px-2 rounded-lg text-slate-400 hover:text-destructive"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Select
                        aria-label={`Field ${i + 1} type`}
                        value={field.fieldType}
                        onChange={(e) =>
                          updateField(i, { fieldType: e.target.value as JobFormFieldType })
                        }
                        className="min-h-11"
                      >
                        {FIELD_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                      <label className="flex items-center gap-1.5 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          aria-label={`Field ${i + 1} required`}
                          checked={field.required}
                          onChange={(e) => updateField(i, { required: e.target.checked })}
                          className="h-4 w-4"
                        />
                        Required
                      </label>
                    </div>
                    {field.fieldType === 'select' && (
                      <Input
                        aria-label={`Field ${i + 1} options`}
                        value={field.optionsText}
                        onChange={(e) => updateField(i, { optionsText: e.target.value })}
                        className="min-h-11"
                        placeholder="Options, comma-separated (e.g. gold, silver, bronze)"
                      />
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setFields((prev) => [...prev, emptyField()])}
                  className="flex items-center gap-1 min-h-11 text-xs text-primary"
                >
                  <Plus size={12} /> Add field
                </button>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="min-h-11 px-4 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save template'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="min-h-11 px-4 rounded-lg border border-border text-sm text-slate-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
