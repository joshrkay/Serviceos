import { EntityPicker } from './EntityPicker';

export interface JobOption {
  id: string;
  jobNumber?: string;
  summary?: string;
  customer?: { displayName?: string };
}

export interface JobPickerProps {
  value: JobOption | null;
  onChange: (job: JobOption | null) => void;
  /** Test/perf override; defaults to 300ms to match CustomerPicker. */
  debounceMs?: number;
  required?: boolean;
}

function displayLabel(j: JobOption): string {
  const head = [j.jobNumber, j.summary].filter(Boolean).join(' — ');
  const customer = j.customer?.displayName;
  if (head && customer) return `${head} (${customer})`;
  return head || customer || j.id;
}

/**
 * Searchable job typeahead (#879). Searches GET /api/jobs?search= (matches
 * summary OR jobNumber server-side) and renders `JOB-#### — summary
 * (customer)` options. Configures the shared `EntityPicker` base (#908) —
 * see that module for the debounce/abort/empty-state behavior common to
 * this and `CustomerPicker` (this file used to carry its own ~85% clone of
 * CustomerPicker's implementation).
 */
export function JobPicker({
  value,
  onChange,
  debounceMs = 300,
  required,
}: JobPickerProps) {
  return (
    <EntityPicker<JobOption>
      value={value}
      onChange={onChange}
      debounceMs={debounceMs}
      required={required}
      buildSearchUrl={(search) => `/api/jobs?search=${encodeURIComponent(search)}&limit=10`}
      getId={(j) => j.id}
      displayLabel={displayLabel}
      placeholder="Search jobs"
      requiredPlaceholder="Search jobs (required)"
      ariaLabel="job-search"
      testIdPrefix="job-picker"
      optionTestIdPrefix="job-option"
      emptyStateLabel="No matching jobs"
    />
  );
}
