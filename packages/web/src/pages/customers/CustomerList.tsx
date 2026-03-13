import React from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';

interface Customer {
  id: string;
  displayName: string;
  companyName?: string;
  email?: string;
  primaryPhone?: string;
  isArchived: boolean;
}

export function CustomerList() {
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters } =
    useListQuery<Customer>('/api/customers');

  const columns: Column<Customer>[] = [
    { key: 'name', header: 'Name', render: (c) => c.displayName },
    { key: 'company', header: 'Company', render: (c) => c.companyName || '-' },
    { key: 'email', header: 'Email', render: (c) => c.email || '-' },
    { key: 'phone', header: 'Phone', render: (c) => c.primaryPhone || '-' },
  ];

  return (
    <ListPage<Customer>
      title="Customers"
      columns={columns}
      data={data}
      total={total}
      page={page}
      pageSize={pageSize}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search customers..."
      emptyTitle="No customers yet"
      emptyDescription="Create your first customer to get started."
      createLabel="New Customer"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(c) => c.id}
    />
  );
}
