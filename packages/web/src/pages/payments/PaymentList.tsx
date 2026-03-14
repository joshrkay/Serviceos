import React, { useState } from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';
import { FilterConfig } from '../../components/FilterBar';

interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: string;
  status: string;
  providerReference?: string;
  createdAt: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const filters: FilterConfig[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { label: 'Pending', value: 'pending' },
      { label: 'Completed', value: 'completed' },
      { label: 'Failed', value: 'failed' },
      { label: 'Refunded', value: 'refunded' },
    ],
  },
  {
    key: 'method',
    label: 'Method',
    options: [
      { label: 'Cash', value: 'cash' },
      { label: 'Check', value: 'check' },
      { label: 'Credit Card', value: 'credit_card' },
      { label: 'Bank Transfer', value: 'bank_transfer' },
    ],
  },
];

export function PaymentList() {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters } =
    useListQuery<Payment>('/api/payments');

  const columns: Column<Payment>[] = [
    { key: 'date', header: 'Date', render: (p) => new Date(p.createdAt).toLocaleDateString() },
    { key: 'invoice', header: 'Invoice', render: (p) => p.invoiceId },
    { key: 'amount', header: 'Amount', render: (p) => formatCents(p.amountCents) },
    { key: 'method', header: 'Method', render: (p) => p.method },
    { key: 'status', header: 'Status', render: (p) => p.status },
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
    <ListPage<Payment>
      title="Payments"
      columns={columns}
      data={data}
      total={total}
      page={page}
      pageSize={pageSize}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search payments..."
      filters={filters}
      activeFilters={activeFilters}
      onFilterChange={handleFilterChange}
      onClearFilters={handleClearFilters}
      emptyTitle="No payments yet"
      emptyDescription="Payments will appear here when recorded against invoices."
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(p) => p.id}
    />
  );
}
