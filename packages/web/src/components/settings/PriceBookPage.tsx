import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Archive, Pencil, Upload, X } from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { formatCurrency } from '../../utils/currency';
import { useApiClient } from '../../lib/apiClient';

interface PriceBookItem {
  id: string;
  name: string;
  description?: string;
  unitPriceCents: number;
  unit?: string;
  category?: string;
}

interface CatalogImportPayload {
  rowNumber: number;
  name: string;
  description: string;
  unitPriceCents: number;
  unit: string;
  category: string;
}

interface InvalidRow {
  rowNumber: number;
  reason: string;
}

const EXPECTED_COLUMNS = ['name', 'description', 'unit_price', 'unit', 'category'] as const;
const MAX_IMPORT_ROWS = 500;
const CATEGORY_OPTIONS = ['Labor', 'Parts', 'Materials'] as const;
const UNIT_OPTIONS = ['each', 'hour', 'sq ft', 'per lb', 'per gal'] as const;

interface PriceBookFormState {
  name: string;
  description: string;
  unitPrice: string;
  unit: string;
  category: string;
}

const DEFAULT_FORM_STATE: PriceBookFormState = {
  name: '',
  description: '',
  unitPrice: '',
  unit: 'each',
  category: 'Labor',
};


function formatPriceFromCents(value: number | undefined): string {
  if (!Number.isFinite(value)) return '$0.00';
  return formatCurrency(value ?? 0);
}

function parseCsvRecords(csvText: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '""';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      if (current.trim().length > 0) records.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) records.push(current);
  return records;
}

function parseCsvRow(line: string): { tokens: string[]; malformed: boolean } {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      tokens.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  tokens.push(current.trim());
  return { tokens, malformed: inQuotes };
}

function normalizePrice(rawValue: string): string {
  return rawValue.replace(/[$,\s]/g, '');
}

const EMPTY_RESULT = {
  data: [] as PriceBookItem[],
  isLoading: false,
  error: null as string | null,
  refetch: () => undefined,
};

export function PriceBookPage() {
  const apiFetch = useApiClient();
  const listQuery = useListQuery<PriceBookItem>('/api/catalog/items', { pageSize: 200 });
  const {
    data = [],
    isLoading = false,
    error = null,
    refetch = () => undefined,
  } = listQuery ?? {};
  const [invalidRows, setInvalidRows] = useState<InvalidRow[]>([]);
  const [progressText, setProgressText] = useState<string>('');
  const [isImporting, setIsImporting] = useState(false);
  const [category, setCategory] = useState('All');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [archiveItemId, setArchiveItemId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [formState, setFormState] = useState<PriceBookFormState>(DEFAULT_FORM_STATE);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sortedItems = useMemo(() => [...data].sort((a, b) => a.name.localeCompare(b.name)), [data]);
  const categoryChips = useMemo(() => {
    const cats = Array.from(
      new Set(
        data
          .map(item => item.category)
          .filter((c): c is string => !!c)
          .map(c => c.charAt(0).toUpperCase() + c.slice(1))
      )
    ).sort();
    return ['All', ...cats];
  }, [data]);
  const filteredItems = useMemo(
    () =>
      category === 'All'
        ? sortedItems
        : sortedItems.filter(item => (item.category ?? '').toLowerCase() === category.toLowerCase()),
    [category, sortedItems]
  );

  const openCreateForm = () => {
    setEditingItemId(null);
    setFormState(DEFAULT_FORM_STATE);
    setFormError(null);
    setActionError(null);
    setIsFormOpen(true);
  };

  const openEditForm = (item: PriceBookItem) => {
    setEditingItemId(item.id);
    setFormState({
      name: item.name ?? '',
      description: item.description ?? '',
      unitPrice: ((item.unitPriceCents ?? 0) / 100).toFixed(2),
      unit: item.unit ?? '',
      category: item.category ?? '',
    });
    setFormError(null);
    setActionError(null);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setFormError(null);
    setIsSaving(false);
  };

  const updateFormField = <K extends keyof PriceBookFormState>(
    field: K,
    value: PriceBookFormState[K]
  ) => {
    setFormState(prev => ({ ...prev, [field]: value }));
  };

  const handleArchive = async (itemId: string) => {
    setActionError(null);
    setArchiveItemId(itemId);
    try {
      const response = await apiFetch(`/api/catalog/items/${itemId}`, { method: 'DELETE' });
      if (!response.ok) {
        setActionError(`Archive failed (HTTP ${response.status}).`);
        return;
      }
      refetch();
    } catch (archiveError) {
      setActionError(archiveError instanceof Error ? archiveError.message : 'Archive failed.');
    } finally {
      setArchiveItemId(null);
    }
  };

  const handleSaveItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setActionError(null);

    const unitPriceValue = Number(formState.unitPrice.replace(/[$,\s]/g, ''));
    const unitPriceCents = Number.isFinite(unitPriceValue) ? Math.round(unitPriceValue * 100) : NaN;
    if (!formState.name.trim()) {
      setFormError('Name is required.');
      return;
    }
    if (!Number.isFinite(unitPriceValue) || unitPriceCents < 0) {
      setFormError('Unit price must be a non-negative number.');
      return;
    }

    setIsSaving(true);
    const payload = {
      name: formState.name.trim(),
      description: formState.description.trim(),
      unitPriceCents,
      unit: formState.unit,
      category: formState.category,
    };

    try {
      const endpoint = editingItemId ? `/api/catalog/items/${editingItemId}` : '/api/catalog/items';
      const method = editingItemId ? 'PUT' : 'POST';
      const response = await apiFetch(endpoint, {
        method,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        setFormError(`${editingItemId ? 'Update' : 'Create'} failed (HTTP ${response.status}).`);
        return;
      }

      closeForm();
      refetch();
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'Unable to save item.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCsvImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setInvalidRows([]);
    setProgressText('');
    setIsImporting(true);

    try {
      const rawCsv = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('Unable to read CSV file.'));

        reader.readAsText(file);
      });

      const lines = parseCsvRecords(rawCsv);

      if (lines.length === 0) {
        setInvalidRows([{ rowNumber: 0, reason: 'CSV is empty.' }]);
        return;
      }

      const headerParse = parseCsvRow(lines[0]);
      if (headerParse.malformed) {
        setInvalidRows([{ rowNumber: 1, reason: 'Header row has mismatched quotes.' }]);
        return;
      }

      const headerTokens = headerParse.tokens.map(token => token.toLowerCase());
      const headerIndex: Record<string, number> = {};
      const duplicateHeaders = new Set<string>();
      headerTokens.forEach((header, index) => {
        if (headerIndex[header] !== undefined) {
          duplicateHeaders.add(header);
        }
        headerIndex[header] = index;
      });

      if (duplicateHeaders.size > 0) {
        setInvalidRows([{ rowNumber: 1, reason: `Duplicate columns: ${Array.from(duplicateHeaders).join(', ')}` }]);
        return;
      }

      const missingColumns = EXPECTED_COLUMNS.filter(column => headerIndex[column] === undefined);
      if (missingColumns.length > 0) {
        setInvalidRows([{ rowNumber: 1, reason: `CSV is missing required columns: ${missingColumns.join(', ')}.` }]);
        return;
      }

      const dataRows = lines.length - 1;
      if (dataRows > MAX_IMPORT_ROWS) {
        setInvalidRows([{ rowNumber: 0, reason: `CSV has ${dataRows} rows. Maximum allowed is 500 rows per import.` }]);
        setProgressText('');
        return;
      }

      const validRows: CatalogImportPayload[] = [];
      const rowErrors: InvalidRow[] = [];

      for (let i = 1; i < lines.length; i += 1) {
        const rowNumber = i + 1;
        const parsedRow = parseCsvRow(lines[i]);
        if (parsedRow.malformed) {
          rowErrors.push({ rowNumber, reason: 'Row has mismatched quotes.' });
          continue;
        }

        const tokens = parsedRow.tokens;

        const name = (tokens[headerIndex.name] ?? '').trim();
        const description = (tokens[headerIndex.description] ?? '').trim();
        const unitPriceRaw = (tokens[headerIndex.unit_price] ?? '').trim();
        const unit = (tokens[headerIndex.unit] ?? '').trim();
        const category = (tokens[headerIndex.category] ?? '').trim();

        const normalizedUnitPrice = normalizePrice(unitPriceRaw);
        const unitPriceCents = Math.round(parseFloat(normalizedUnitPrice) * 100);

        if (!name) {
          rowErrors.push({ rowNumber, reason: 'name is required.' });
          continue;
        }

        if (normalizedUnitPrice.length === 0) {
          rowErrors.push({ rowNumber, reason: 'unit_price is required.' });
          continue;
        }

        if (!Number.isFinite(unitPriceCents) || !Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
          rowErrors.push({ rowNumber, reason: 'unit_price must be a non-negative number.' });
          continue;
        }

        validRows.push({ rowNumber, name, description, unitPriceCents, unit, category });
      }

      setInvalidRows(rowErrors);

      let importedCount = 0;
      const totalValidRows = validRows.length;

      if (totalValidRows === 0) {
        setProgressText('Imported 0 of 0');
        return;
      }

      setProgressText(`Imported ${importedCount} of ${totalValidRows}`);

      for (let i = 0; i < validRows.length; i += 1) {
        const row = validRows[i];
        const { rowNumber, ...payload } = row;
        const response = await apiFetch('/api/catalog/items', {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          importedCount += 1;
        } else {
          rowErrors.push({
            rowNumber,
            reason: `Import failed (${response.status}).`,
          });
          setInvalidRows([...rowErrors]);
        }

        setProgressText(`Imported ${importedCount} of ${totalValidRows}`);
      }

      refetch();
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : 'CSV import failed.';
      setInvalidRows([{ rowNumber: 0, reason: message }]);
    } finally {
      event.target.value = '';
      setIsImporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="p-4 md:p-6 max-w-4xl mx-auto">
        <div className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-slate-900">Price book</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              onClick={openCreateForm}
            >
              Add item
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
            >
              <Upload size={14} />
              Import CSV
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".csv"
              data-testid="csv-file-input"
              onChange={handleCsvImport}
            />
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {categoryChips.map(chip => {
            const isActive = chip === category;
            return (
              <button
                key={chip}
                type="button"
                onClick={() => setCategory(chip)}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  isActive
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {chip}
              </button>
            );
          })}
        </div>

        {progressText && (
          <p data-testid="csv-import-progress" className="mb-3 text-sm text-slate-600">{progressText}</p>
        )}

        {invalidRows.length > 0 && (
          <div data-testid="csv-import-errors" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="mb-2 text-sm text-red-700">Some rows could not be imported:</p>
            <ul className="list-disc pl-5 text-sm text-red-700">
              {invalidRows.map(row => (
                <li key={`${row.rowNumber}-${row.reason}`}>
                  Row {row.rowNumber}: {row.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="mb-3 text-sm text-red-600">Failed to load price book: {error}</p>}
        {actionError && <p className="mb-3 text-sm text-red-600">{actionError}</p>}

        {isLoading ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2 text-right">Unit price</th>
                  <th className="w-10 px-3 py-2 text-right">Edit</th>
                  <th className="w-10 px-3 py-2 text-right">Archive</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map(item => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-800">{item.name}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        {item.category || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{item.unit || '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-800">
                      {formatPriceFromCents(item.unitPriceCents)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="inline-flex text-slate-500 hover:text-indigo-600"
                        aria-label={`Edit ${item.name}`}
                        onClick={() => openEditForm(item)}
                        disabled={archiveItemId === item.id || isSaving}
                      >
                        <Pencil size={14} />
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="inline-flex text-slate-500 hover:text-red-600"
                        aria-label={`Archive ${item.name}`}
                        onClick={() => handleArchive(item.id)}
                        disabled={archiveItemId === item.id}
                      >
                        <Archive size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredItems.length === 0 && (
                  <tr className="border-t border-slate-100">
                    <td className="px-3 py-6 text-center text-slate-500" colSpan={6}>
                      No price book items found for this category.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isFormOpen && (
        <div className="fixed inset-0 z-50 bg-black/30" onClick={closeForm}>
          <aside
            className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                {editingItemId ? 'Edit price book item' : 'Add price book item'}
              </h2>
              <button
                type="button"
                onClick={closeForm}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close form"
              >
                <X size={18} />
              </button>
            </div>

            <form className="space-y-4" onSubmit={handleSaveItem}>
              <label className="block text-sm text-slate-700">
                <span className="mb-1 block">Item name</span>
                <input
                  type="text"
                  value={formState.name}
                  onChange={event => updateFormField('name', event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>

              <label className="block text-sm text-slate-700">
                <span className="mb-1 block">Description</span>
                <textarea
                  value={formState.description}
                  onChange={event => updateFormField('description', event.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>

              <label className="block text-sm text-slate-700">
                <span className="mb-1 block">Unit price</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formState.unitPrice}
                  onChange={event => updateFormField('unitPrice', event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>

              <label className="block text-sm text-slate-700">
                <span className="mb-1 block">Unit</span>
                <select
                  value={formState.unit}
                  onChange={event => updateFormField('unit', event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  {(UNIT_OPTIONS.some(o => o === formState.unit) ? [...UNIT_OPTIONS] : [formState.unit, ...UNIT_OPTIONS]).map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm text-slate-700">
                <span className="mb-1 block">Category</span>
                <select
                  value={formState.category}
                  onChange={event => updateFormField('category', event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  {(CATEGORY_OPTIONS.some(o => o === formState.category) ? [...CATEGORY_OPTIONS] : [formState.category, ...CATEGORY_OPTIONS]).map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              {formError && <p className="text-sm text-red-600">{formError}</p>}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? 'Saving...' : editingItemId ? 'Save changes' : 'Create item'}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
