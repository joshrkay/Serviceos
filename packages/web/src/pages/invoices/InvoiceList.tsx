import React from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';

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

export function InvoiceList() {
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch } =
    useListQuery<Invoice>('/api/invoices');

  const columns: Column<Invoice>[] = [
    { key: 'number', header: 'Invoice #', render: (i) => i.invoiceNumber },
    { key: 'status', header: 'Status', render: (i) => i.status },
    { key: 'total', header: 'Total', render: (i) => formatCents(i.totalCents) },
    { key: 'due', header: 'Amount Due', render: (i) => formatCents(i.amountDueCents) },
  ];

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
      emptyTitle="No invoices yet"
      createLabel="New Invoice"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(i) => i.id}
    />
  );
}
