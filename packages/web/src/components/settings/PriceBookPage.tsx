import { ChangeEvent, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { apiFetch } from '../../utils/api-fetch';

interface CatalogItem {
  id: string;
  name: string;
  description?: string;
  unit_price: number;
  unit?: string;
  category?: string;
}

interface ImportRow {
  name: string;
  description: string;
  unit_price: number;
  unit: string;
  category: string;
}

const MAX_IMPORT_ROWS = 500;
const REQUIRED_COLUMNS = ['name', 'unit_price'];

function parseCsvText(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }
      row.push(cell.trim());
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (inQuotes) {
    throw new Error('CSV contains an unclosed quoted field.');
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((value) => value.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

export function PriceBookPage() {
  const { data, isLoading, error, refetch } = useListQuery<CatalogItem>('/api/catalog/items');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [progressText, setProgressText] = useState<string>('');
  const [isImporting, setIsImporting] = useState(false);

  const handleCsvImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportErrors([]);
    setProgressText('');

    try {
      const csvText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read CSV file.'));
        reader.readAsText(file);
      });

      const parsedRows = parseCsvText(csvText);
      if (parsedRows.length === 0) {
        setImportErrors(['CSV file is empty.']);
        return;
      }

      const [headerRow, ...dataRows] = parsedRows;
      if (dataRows.length > MAX_IMPORT_ROWS) {
        setImportErrors([`CSV has ${dataRows.length} rows. Maximum allowed is ${MAX_IMPORT_ROWS} rows per import.`]);
        return;
      }

      const normalizedHeaders = headerRow.map((header) => header.trim().toLowerCase());
      const missingColumns = REQUIRED_COLUMNS.filter((column) => !normalizedHeaders.includes(column));
      if (missingColumns.length > 0) {
        setImportErrors([`CSV is missing required columns: ${missingColumns.join(', ')}.`]);
        return;
      }

      const validRows: ImportRow[] = [];
      const rowErrors: string[] = [];

      dataRows.forEach((values, idx) => {
        const rowNumber = idx + 2;
        const record = {
          name: values[normalizedHeaders.indexOf('name')]?.trim() ?? '',
          description: values[normalizedHeaders.indexOf('description')]?.trim() ?? '',
          unit_price: values[normalizedHeaders.indexOf('unit_price')]?.trim() ?? '',
          unit: values[normalizedHeaders.indexOf('unit')]?.trim() ?? '',
          category: values[normalizedHeaders.indexOf('category')]?.trim() ?? '',
        };

        if (!record.name) {
          rowErrors.push(`Row ${rowNumber}: name is required.`);
          return;
        }

        const parsedPrice = Number(record.unit_price);
        if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
          rowErrors.push(`Row ${rowNumber}: unit_price must be a non-negative number.`);
          return;
        }

        validRows.push({
          name: record.name,
          description: record.description,
          unit_price: parsedPrice,
          unit: record.unit,
          category: record.category,
        });
      });

      const allErrors = [...rowErrors];
      setImportErrors(allErrors);

      let importedCount = 0;
      for (let i = 0; i < validRows.length; i += 1) {
        const row = validRows[i];
        const response = await apiFetch('/api/catalog/items', {
          method: 'POST',
          body: JSON.stringify(row),
        });

        if (!response.ok) {
          allErrors.push(`Row ${i + 2}: failed to import (HTTP ${response.status}).`);
          setImportErrors([...allErrors]);
          setProgressText(`Imported ${importedCount} of ${validRows.length}`);
          continue;
        }

        importedCount += 1;
        setProgressText(`Imported ${importedCount} of ${validRows.length}`);
      }

      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse CSV file.';
      setImportErrors([message]);
    } finally {
      setIsImporting(false);
      event.target.value = '';
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="text-xl text-slate-900">Price book</h1>
        <>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            <Upload size={16} />
            Import CSV
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            data-testid="csv-file-input"
            className="hidden"
            onChange={(event) => {
              void handleCsvImport(event);
            }}
          />
        </>
      </div>

      {isImporting || progressText ? (
        <p className="text-sm text-slate-600 mb-3" data-testid="csv-import-progress">{progressText || 'Importing...'}</p>
      ) : null}

      {importErrors.length > 0 ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3" data-testid="csv-import-errors">
          <p className="text-sm text-red-700 mb-2">Some rows could not be imported:</p>
          <ul className="list-disc pl-5 text-sm text-red-700 space-y-1">
            {importErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {isLoading ? <p className="text-slate-500">Loading items...</p> : null}
      {error ? <p className="text-red-600">Failed to load price book.</p> : null}

      <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
        {data.map((item) => (
          <div key={item.id} className="px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-900">{item.name}</p>
              {item.description ? <p className="text-xs text-slate-500">{item.description}</p> : null}
            </div>
            <p className="text-sm text-slate-700">${item.unit_price.toFixed(2)}</p>
          </div>
        ))}
        {data.length === 0 && !isLoading ? <p className="px-4 py-3 text-sm text-slate-500">No items yet.</p> : null}
      </div>
    </div>
  );
}
