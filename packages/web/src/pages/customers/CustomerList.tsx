import React, { useState } from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';
import { FilterConfig } from '../../components/FilterBar';

interface Customer {
  id: string;
  displayName: string;
  companyName?: string;
  email?: string;
  primaryPhone?: string;
  isArchived: boolean;
}

const filters: FilterConfig[] = [
  {
    key: 'isArchived',
    label: 'Status',
    options: [
      { label: 'Active', value: 'false' },
      { label: 'Archived', value: 'true' },
    ],
  },
];

export function CustomerList() {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters } =
    useListQuery<Customer>('/api/customers');

  const columns: Column<Customer>[] = [
    { key: 'name', header: 'Name', render: (c) => c.displayName },
    { key: 'company', header: 'Company', render: (c) => c.companyName || '-' },
    { key: 'email', header: 'Email', render: (c) => c.email || '-' },
    { key: 'phone', header: 'Phone', render: (c) => c.primaryPhone || '-' },
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
      filters={filters}
      activeFilters={activeFilters}
      onFilterChange={handleFilterChange}
      onClearFilters={handleClearFilters}
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
