import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Field, Input, Select } from '../ui';
import {
  type ResolvedCustomField,
  listCustomFields,
  setCustomFieldValue,
} from '../../api/customers';

/**
 * U2 (CRM Jobber parity) — tenant-defined custom fields (per-customer values).
 *
 * Renders one typed control per active field definition and persists the
 * value on blur (text/number/date) or change (select). Field definitions
 * are managed elsewhere (tenant settings); this panel only edits values.
 * Talks to /api/customers/:id/custom-fields.
 */
export function CustomFieldsPanel({ customerId }: { customerId: string }) {
  const [fields, setFields] = useState<ResolvedCustomField[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback((rows: ResolvedCustomField[]) => {
    setFields(rows);
    setDrafts(Object.fromEntries(rows.map((f) => [f.fieldDefId, f.value ?? ''])));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      hydrate(await listCustomFields(customerId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load custom fields');
    }
  }, [customerId, hydrate]);

  useEffect(() => {
    // Clear the prior customer's fields/drafts so a customerId change doesn't
    // flash stale data while the new fetch is in flight.
    setFields([]);
    setDrafts({});
    void load();
  }, [load]);

  const save = useCallback(
    async (field: ResolvedCustomField, raw: string) => {
      const next = raw.trim() === '' ? null : raw;
      if ((field.value ?? '') === (next ?? '')) return; // no-op, avoid churn
      try {
        // Refresh field values from the server, but reset only the *saved*
        // field's draft — rehydrating every draft here would clobber unsaved
        // edits the user is mid-typing in another field.
        const updated = await setCustomFieldValue(customerId, field.fieldDefId, next);
        setFields(updated);
        const saved = updated.find((f) => f.fieldDefId === field.fieldDefId);
        setDrafts((prev) => ({ ...prev, [field.fieldDefId]: saved?.value ?? '' }));
        toast.success(`${field.label} saved`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save custom field');
      }
    },
    [customerId],
  );

  if (fields.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        {error ?? 'No custom fields defined. Add them in settings to track extra details.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {fields.map((field) => {
        const draft = drafts[field.fieldDefId] ?? '';
        const onDraft = (v: string) =>
          setDrafts((p) => ({ ...p, [field.fieldDefId]: v }));
        return (
          <Field key={field.fieldDefId} label={field.label}>
            {field.fieldType === 'select' ? (
              <Select
                aria-label={field.label}
                value={draft}
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
                  field.fieldType === 'number'
                    ? 'number'
                    : field.fieldType === 'date'
                      ? 'date'
                      : 'text'
                }
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                onBlur={(e) => save(field, e.target.value)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
