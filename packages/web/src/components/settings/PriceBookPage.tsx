import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { apiFetch } from '../../utils/api-fetch';

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
  const queryResult = useListQuery<PriceBookItem>('/api/catalog/items');
  const { data, isLoading, error, refetch } = queryResult ?? EMPTY_RESULT;
  const [invalidRows, setInvalidRows] = useState<InvalidRow[]>([]);
  const [progressText, setProgressText] = useState<string>('');
  const [isImporting, setIsImporting] = useState(false);
  const [showAddItemForm, setShowAddItemForm] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [editingItem, setEditingItem] = useState<PriceBookItem | null>(null);
  const [editFormState, setEditFormState] = useState({
    name: '',
    description: '',
    unitPrice: '',
    unit: '',
    category: '',
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sortedItems = useMemo(
    () => [...data].sort((a, b) => a.name.localeCompare(b.name)),
    [data]
  );

  const categoryOptions = useMemo(() => {
    const options = sortedItems
      .map(item => item.category?.trim())
      .filter((category): category is string => Boolean(category));

    return ['All', ...Array.from(new Set(options))];
  }, [sortedItems]);

  const visibleItems = useMemo(() => {
    if (selectedCategory === 'All') return sortedItems;
    return sortedItems.filter(item => (item.category ?? '') === selectedCategory);
  }, [selectedCategory, sortedItems]);

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

  const beginEdit = (item: PriceBookItem) => {
    setEditingItem(item);
    setEditFormState({
      name: item.name,
      description: item.description ?? '',
      unitPrice: (item.unitPriceCents / 100).toFixed(2),
      unit: item.unit ?? '',
      category: item.category ?? '',
    });
  };

  const handleEditSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingItem) return;

    const unitPriceCents = Math.round(Number(editFormState.unitPrice) * 100);
    const response = await apiFetch(`/api/catalog/items/${editingItem.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editFormState.name,
        description: editFormState.description,
        unitPriceCents,
        unit: editFormState.unit,
        category: editFormState.category,
      }),
    });

    if (response.ok) {
      setEditingItem(null);
      refetch();
    }
  };

  const handleArchive = async (item: PriceBookItem) => {
    const response = await apiFetch(`/api/catalog/items/${item.id}`, { method: 'DELETE' });
    if (response.ok) refetch();
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
              onClick={() => setShowAddItemForm(prev => !prev)}
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

        <div className="mb-4 flex flex-wrap gap-2">
          {categoryOptions.map(category => (
            <button
              key={category}
              type="button"
              onClick={() => setSelectedCategory(category)}
              className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700"
            >
              {category}
            </button>
          ))}
        </div>

        {showAddItemForm && (
          <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
            <p className="mb-3 text-sm text-slate-700">Add price book item</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Item name</span>
                <input type="text" className="rounded border border-slate-300 px-2 py-1 text-sm" />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Unit price</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
            </div>
          </div>
        )}

        {editingItem && (
          <form className="mb-4 rounded-lg border border-slate-200 bg-white p-3" onSubmit={handleEditSubmit}>
            <p className="mb-3 text-sm text-slate-700">Edit price book item</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Item name</span>
                <input
                  type="text"
                  value={editFormState.name}
                  onChange={event => setEditFormState(prev => ({ ...prev, name: event.target.value }))}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Description</span>
                <input
                  type="text"
                  value={editFormState.description}
                  onChange={event => setEditFormState(prev => ({ ...prev, description: event.target.value }))}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Unit price</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editFormState.unitPrice}
                  onChange={event => setEditFormState(prev => ({ ...prev, unitPrice: event.target.value }))}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Unit</span>
                <input
                  type="text"
                  value={editFormState.unit}
                  onChange={event => setEditFormState(prev => ({ ...prev, unit: event.target.value }))}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Category</span>
                <input
                  type="text"
                  value={editFormState.category}
                  onChange={event => setEditFormState(prev => ({ ...prev, category: event.target.value }))}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
            </div>
            <button
              type="submit"
              className="mt-3 inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Save
            </button>
          </form>
        )}

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

        {isLoading ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2 text-right">Unit price</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map(item => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-800">{item.name}</td>
                    <td className="px-3 py-2 text-slate-600">{item.description || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{item.unit || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{item.category || '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-800">
                      ${(item.unitPriceCents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => beginEdit(item)} className="text-xs text-slate-700">
                          Edit
                        </button>
                        <button type="button" onClick={() => handleArchive(item)} className="text-xs text-slate-700">
                          Archive
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
