import { useMemo, useRef, useState, type ChangeEvent } from 'react';
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

interface CatalogImportRow {
  rowNumber: number;
  name: string;
  description: string;
  unit_price: number;
  unit: string;
  category: string;
}

interface InvalidRow {
  rowNumber: number;
  reason: string;
}

const EXPECTED_COLUMNS = ['name', 'description', 'unit_price', 'unit', 'category'] as const;

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

export function PriceBookPage() {
  const { data, isLoading, error, refetch } = useListQuery<PriceBookItem>('/api/catalog/items');
  const [invalidRows, setInvalidRows] = useState<InvalidRow[]>([]);
  const [progressText, setProgressText] = useState<string>('');
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sortedItems = useMemo(
    () => [...data].sort((a, b) => a.name.localeCompare(b.name)),
    [data]
  );

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

      const validRows: CatalogImportRow[] = [];
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
        const unitPrice = Number(normalizedUnitPrice);
        const unitPriceCents = Number.isFinite(unitPrice) ? Math.round(unitPrice * 100) : NaN;

        if (!name) {
          rowErrors.push({ rowNumber, reason: 'name is required.' });
          continue;
        }

        if (normalizedUnitPrice.length === 0) {
          rowErrors.push({ rowNumber, reason: 'unit_price is required.' });
          continue;
        }

        if (!Number.isFinite(unitPrice) || unitPriceCents < 0) {
          rowErrors.push({ rowNumber, reason: 'unit_price must be a non-negative number.' });
          continue;
        }

        validRows.push({ rowNumber, name, description, unit_price: unitPrice, unit, category });
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

        {progressText && (
          <p className="mb-3 text-sm text-slate-600">{progressText}</p>
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
                </tr>
              </thead>
              <tbody>
                {sortedItems.map(item => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-800">{item.name}</td>
                    <td className="px-3 py-2 text-slate-600">{item.description || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{item.unit || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{item.category || '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-800">
                      ${(item.unitPriceCents / 100).toFixed(2)}
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
