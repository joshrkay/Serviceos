import React from 'react';
import { SearchBar } from './SearchBar';
import { FilterBar, FilterConfig } from './FilterBar';
import { EmptyState } from './EmptyState';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

export interface Column<T> {
  key: string;
  header: string;
  render: (item: T) => React.ReactNode;
  sortable?: boolean;
}

export interface ListPageProps<T> {
  title: string;
  columns: Column<T>[];
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  isLoading: boolean;
  error: string | null;
  searchPlaceholder?: string;
  filters?: FilterConfig[];
  activeFilters?: Record<string, string>;
  emptyTitle?: string;
  emptyDescription?: string;
  createLabel?: string;
  onSearch: (query: string) => void;
  onFilterChange?: (key: string, value: string) => void;
  onClearFilters?: () => void;
  onPageChange: (page: number) => void;
  onRowClick?: (item: T) => void;
  onCreate?: () => void;
  onRetry: () => void;
  getRowKey: (item: T) => string;
}

export function ListPage<T>({
  title,
  columns,
  data,
  total,
  page,
  pageSize,
  isLoading,
  error,
  searchPlaceholder,
  filters,
  activeFilters,
  emptyTitle,
  emptyDescription,
  createLabel,
  onSearch,
  onFilterChange,
  onClearFilters,
  onPageChange,
  onRowClick,
  onCreate,
  onRetry,
  getRowKey,
}: ListPageProps<T>) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (isLoading) return <LoadingState />;

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="list-page">
      <div className="list-page-header">
        <h1>{title}</h1>
        {onCreate && createLabel && (
          <button onClick={onCreate}>{createLabel}</button>
        )}
      </div>

      <div className="list-page-toolbar">
        <SearchBar placeholder={searchPlaceholder} onSearch={onSearch} />
        {filters && activeFilters && onFilterChange && onClearFilters && (
          <FilterBar
            filters={filters}
            activeFilters={activeFilters}
            onFilterChange={onFilterChange}
            onClearFilters={onClearFilters}
          />
        )}
      </div>

      {data.length === 0 ? (
        <EmptyState
          title={emptyTitle || 'No items found'}
          description={emptyDescription}
          actionLabel={createLabel}
          onAction={onCreate}
        />
      ) : (
        <>
          <table className="list-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.key}>{col.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((item) => (
                <tr
                  key={getRowKey(item)}
                  onClick={() => onRowClick?.(item)}
                  style={{ cursor: onRowClick ? 'pointer' : 'default' }}
                >
                  {columns.map((col) => (
                    <td key={col.key}>{col.render(item)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="pagination">
              <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</button>
              <span>Page {page} of {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
