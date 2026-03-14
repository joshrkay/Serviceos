import React, { useState } from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';
import { FilterConfig } from '../../components/FilterBar';

interface Job {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  priority: string;
  customerId: string;
}

const filters: FilterConfig[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { label: 'New', value: 'new' },
      { label: 'Scheduled', value: 'scheduled' },
      { label: 'In Progress', value: 'in_progress' },
      { label: 'Completed', value: 'completed' },
      { label: 'Canceled', value: 'canceled' },
    ],
  },
  {
    key: 'priority',
    label: 'Priority',
    options: [
      { label: 'Low', value: 'low' },
      { label: 'Normal', value: 'normal' },
      { label: 'High', value: 'high' },
      { label: 'Emergency', value: 'emergency' },
    ],
  },
];

export function JobList() {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters } =
    useListQuery<Job>('/api/jobs');

  const columns: Column<Job>[] = [
    { key: 'number', header: 'Job #', render: (j) => j.jobNumber },
    { key: 'summary', header: 'Summary', render: (j) => j.summary },
    { key: 'status', header: 'Status', render: (j) => j.status },
    { key: 'priority', header: 'Priority', render: (j) => j.priority },
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
    <ListPage<Job>
      title="Jobs"
      columns={columns}
      data={data}
      total={total}
      page={page}
      pageSize={pageSize}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search jobs..."
      filters={filters}
      activeFilters={activeFilters}
      onFilterChange={handleFilterChange}
      onClearFilters={handleClearFilters}
      emptyTitle="No jobs yet"
      createLabel="New Job"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(j) => j.id}
    />
  );
}
