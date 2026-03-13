import React from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';

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

export function EstimateList() {
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch } =
    useListQuery<Estimate>('/api/estimates');

  const columns: Column<Estimate>[] = [
    { key: 'number', header: 'Estimate #', render: (e) => e.estimateNumber },
    { key: 'status', header: 'Status', render: (e) => e.status },
    { key: 'total', header: 'Total', render: (e) => formatCents(e.totalCents) },
  ];

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
      emptyTitle="No estimates yet"
      createLabel="New Estimate"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(e) => e.id}
    />
  );
}
