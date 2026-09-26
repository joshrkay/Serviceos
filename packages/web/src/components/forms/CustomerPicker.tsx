import { EntityPicker } from './EntityPicker';

export interface CustomerOption {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}

export interface CustomerPickerProps {
  value: CustomerOption | null;
  onChange: (customer: CustomerOption | null) => void;
  /** Test/perf override; defaults to 300ms per story spec. */
  debounceMs?: number;
  required?: boolean;
}

function displayName(c: CustomerOption): string {
  const human = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  if (human && c.companyName) return `${human} (${c.companyName})`;
  return human || c.companyName || c.id;
}

/**
 * Searchable customer typeahead (P11-006). Searches GET /api/customers?search=
 * and renders `First Last (Company)` options. Configures the shared
 * `EntityPicker` base (#908) — see that module for the debounce/abort/
 * empty-state behavior common to this and `JobPicker`.
 */
export function CustomerPicker({
  value,
  onChange,
  debounceMs = 300,
  required,
}: CustomerPickerProps) {
  return (
    <EntityPicker<CustomerOption>
      value={value}
      onChange={onChange}
      debounceMs={debounceMs}
      required={required}
      buildSearchUrl={(search) => `/api/customers?search=${encodeURIComponent(search)}&limit=10`}
      getId={(c) => c.id}
      displayLabel={displayName}
      placeholder="Search customer"
      requiredPlaceholder="Search customer (required)"
      ariaLabel="customer-search"
      testIdPrefix="customer-picker"
      optionTestIdPrefix="customer-option"
      emptyStateLabel="No matching customers"
    />
  );
}
