/**
 * J-CF (Jobber parity) — job custom field definition manager.
 *
 * Lets a tenant define/archive custom fields that appear on every job (PO #,
 * permit #, gate code). Field types: text, number, date, select (with options).
 * Talks to /api/job-custom-fields/defs. API fns are injectable for jsdom.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, SlidersHorizontal, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Input, Select } from '../ui';
import {
  type JobCustomFieldDef,
  type JobCustomFieldType,
  archiveJobCustomFieldDef as archiveApi,
  createJobCustomFieldDef as createApi,
  listJobCustomFieldDefs as listApi,
} from '../../api/job-custom-fields';

export interface JobCustomFieldsSheetApi {
  list: typeof listApi;
  create: typeof createApi;
  archive: typeof archiveApi;
}

const DEFAULT_API: JobCustomFieldsSheetApi = { list: listApi, create: createApi, archive: archiveApi };

const FIELD_TYPES: { value: JobCustomFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
];

/** Derive a valid field key from a label: lowercase, non-alnum → underscore. */
function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 50);
}

export function JobCustomFieldsSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: JobCustomFieldsSheetApi;
}) {
  const [defs, setDefs] = useState<JobCustomFieldDef[]>([]);
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState<JobCustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setDefs(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load custom fields');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setError('');
    if (!label.trim()) {
      setError('Give the field a label.');
      return;
    }
    const options =
      fieldType === 'select'
        ? optionsText.split(',').map((o) => o.trim()).filter(Boolean)
        : [];
    if (fieldType === 'select' && options.length === 0) {
      setError('Add at least one dropdown option.');
      return;
    }
    setSaving(true);
    try {
      await api.create({ key: keyFromLabel(label), label: label.trim(), fieldType, options });
      setLabel('');
      setFieldType('text');
      setOptionsText('');
      await load();
      toast.success('Custom field added');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not add field';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const archive = async (def: JobCustomFieldDef) => {
    try {
      await api.archive(def.id);
      await load();
      toast.success(`${def.label} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove field');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="job-cf-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <SlidersHorizontal size={16} className="text-slate-700" />
          </span>
          <h2 id="job-cf-title" className="flex-1 text-base text-slate-900">
            Job custom fields
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-3">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-sm text-slate-500">
            Extra fields shown on every job (e.g. PO number, permit #, gate code).
          </p>

          {defs.length === 0 && <p className="text-sm text-slate-400 italic">No custom fields yet.</p>}
          {defs.map((def) => (
            <div
              key={def.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-slate-900 truncate">{def.label}</p>
                <p className="text-xs text-slate-500">{def.fieldType}</p>
              </div>
              <button
                type="button"
                aria-label={`Remove ${def.label}`}
                onClick={() => archive(def)}
                className="flex items-center justify-center min-h-11 px-2 rounded-lg text-slate-400 hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
            <Input
              aria-label="New field label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="min-h-11"
              placeholder="Field label (e.g. PO Number)"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="New field type"
                value={fieldType}
                onChange={(e) => setFieldType(e.target.value as JobCustomFieldType)}
                className="min-h-11"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                onClick={add}
                disabled={saving}
                className="flex items-center gap-1 min-h-11 px-3 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
              >
                <Plus size={14} /> {saving ? 'Adding…' : 'Add'}
              </button>
            </div>
            {fieldType === 'select' && (
              <Input
                aria-label="New field options"
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                className="min-h-11"
                placeholder="Options, comma-separated"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
