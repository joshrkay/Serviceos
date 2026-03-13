import React from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';

interface Job {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  priority: string;
  customerId: string;
}

export function JobList() {
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch } =
    useListQuery<Job>('/api/jobs');

  const columns: Column<Job>[] = [
    { key: 'number', header: 'Job #', render: (j) => j.jobNumber },
    { key: 'summary', header: 'Summary', render: (j) => j.summary },
    { key: 'status', header: 'Status', render: (j) => j.status },
    { key: 'priority', header: 'Priority', render: (j) => j.priority },
  ];

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
      emptyTitle="No jobs yet"
      createLabel="New Job"
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(j) => j.id}
    />
  );
}
