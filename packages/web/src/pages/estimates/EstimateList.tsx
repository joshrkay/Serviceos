import React, { useState } from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';
import { FilterConfig } from '../../components/FilterBar';

interface Estimate {
  id: string;
  estimateNumber: string;
  status: string;
  totalCents: number;
  jobId: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const filters: FilterConfig[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { label: 'Draft', value: 'draft' },
      { label: 'Ready for Review', value: 'ready_for_review' },
      { label: 'Sent', value: 'sent' },
      { label: 'Accepted', value: 'accepted' },
      { label: 'Rejected', value: 'rejected' },
      { label: 'Expired', value: 'expired' },
    ],
  },
];

export function EstimateList() {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters } =
    useListQuery<Estimate>('/api/estimates');

  const columns: Column<Estimate>[] = [
    { key: 'number', header: 'Estimate #', render: (e) => e.estimateNumber },
    { key: 'status', header: 'Status', render: (e) => e.status },
    { key: 'total', header: 'Total', render: (e) => formatCents(e.totalCents) },
  ];

  const handleFilterChange = (key: string, value: string) => {
    const updated = { ...activeFilters };
    if (value) {
      updated[key] = value;
    } else {
      delete updated[key];
    }
    setActiveFilters(updated);
    setFilters(updated);
  };

  const handleClearFilters = () => {
    setActiveFilters({});
    setFilters({});
  };

  return (
    <ListPage<Estimate>
      title="Estimates"
      columns={columns}
      data={data}
      total={total}
      page={page}
      pageSize={pageSize}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search estimates..."
      filters={filters}
      activeFilters={activeFilters}
      onFilterChange={handleFilterChange}
      onClearFilters={handleClearFilters}
      emptyTitle="No estimates yet"
      createLabel="New Estimate"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(e) => e.id}
    />
  );
}
