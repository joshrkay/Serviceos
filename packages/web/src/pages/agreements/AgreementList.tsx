/**
 * P9-003 — AgreementList page.
 *
 * Filterable table of service agreements (filter by customer + status).
 */
import React, { useState } from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';
import { FilterConfig } from '../../components/FilterBar';
import type { Agreement } from '../../api/agreements';
import { formatCurrency } from '../../utils/currency';

const filters: FilterConfig[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { label: 'Active', value: 'active' },
      { label: 'Paused', value: 'paused' },
      { label: 'Cancelled', value: 'cancelled' },
    ],
  },
];

export function AgreementList(): JSX.Element {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const {
    data,
    total,
    page,
    pageSize,
    isLoading,
    error,
    refetch,
    setPage,
    setSearch,
    setFilters,
  } = useListQuery<Agreement>('/api/agreements');

  const columns: Column<Agreement>[] = [
    { key: 'name', header: 'Name', render: (a) => a.name },
    { key: 'status', header: 'Status', render: (a) => a.status },
    {
      key: 'price',
      header: 'Price',
      render: (a) => formatCurrency(a.priceCents),
    },
    { key: 'cadence', header: 'Cadence', render: (a) => a.recurrenceRule },
    {
      key: 'next',
      header: 'Next run',
      render: (a) => (a.nextRunAt ? a.nextRunAt.slice(0, 10) : '-'),
    },
  ];

  const handleFilterChange = (key: string, value: string) => {
    const updated = { ...activeFilters };
    if (value) updated[key] = value;
    else delete updated[key];
    setActiveFilters(updated);
    setFilters(updated);
  };

  return (
    <ListPage<Agreement>
      title="Service Agreements"
      columns={columns}
      data={data}
      total={total}
      page={page}
      pageSize={pageSize}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search agreements..."
      filters={filters}
      activeFilters={activeFilters}
      onFilterChange={handleFilterChange}
      onClearFilters={() => {
        setActiveFilters({});
        setFilters({});
      }}
      emptyTitle="No service agreements yet"
      emptyDescription="Sign customers up for recurring tune-ups and maintenance plans."
      createLabel="New Agreement"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(a) => a.id}
    />
  );
}
