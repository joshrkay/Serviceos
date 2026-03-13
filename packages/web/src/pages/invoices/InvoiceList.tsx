import React, { useState } from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';
import { FilterConfig } from '../../components/FilterBar';

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  totalCents: number;
  amountDueCents: number;
  dueDate?: string;
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
      { label: 'Open', value: 'open' },
      { label: 'Partially Paid', value: 'partially_paid' },
      { label: 'Paid', value: 'paid' },
      { label: 'Void', value: 'void' },
      { label: 'Canceled', value: 'canceled' },
    ],
  },
];

export function InvoiceList() {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters } =
    useListQuery<Invoice>('/api/invoices');

  const columns: Column<Invoice>[] = [
    { key: 'number', header: 'Invoice #', render: (i) => i.invoiceNumber },
    { key: 'status', header: 'Status', render: (i) => i.status },
    { key: 'total', header: 'Total', render: (i) => formatCents(i.totalCents) },
    { key: 'due', header: 'Amount Due', render: (i) => formatCents(i.amountDueCents) },
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
    <ListPage<Invoice>
      title="Invoices"
      columns={columns}
      data={data}
      total={total}
      page={page}
      pageSize={pageSize}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search invoices..."
      filters={filters}
      activeFilters={activeFilters}
      onFilterChange={handleFilterChange}
      onClearFilters={handleClearFilters}
      emptyTitle="No invoices yet"
      createLabel="New Invoice"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(i) => i.id}
    />
  );
}
