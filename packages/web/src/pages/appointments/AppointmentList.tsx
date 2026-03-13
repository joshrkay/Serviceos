import React, { useState } from 'react';
import { ListPage, Column } from '../../components/ListPage';
import { useListQuery } from '../../hooks/useListQuery';
import { FilterConfig } from '../../components/FilterBar';

interface Appointment {
  id: string;
  jobId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  arrivalWindowStart?: string;
  arrivalWindowEnd?: string;
  technicianName?: string;
}

const filters: FilterConfig[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { label: 'Scheduled', value: 'scheduled' },
      { label: 'Confirmed', value: 'confirmed' },
      { label: 'In Progress', value: 'in_progress' },
      { label: 'Completed', value: 'completed' },
      { label: 'Canceled', value: 'canceled' },
    ],
  },
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatArrivalWindow(start?: string, end?: string): string {
  if (!start || !end) return '-';
  return `${new Date(start).toLocaleTimeString()} - ${new Date(end).toLocaleTimeString()}`;
}

export function AppointmentList() {
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters } =
    useListQuery<Appointment>('/api/appointments');

  const columns: Column<Appointment>[] = [
    { key: 'date', header: 'Scheduled', render: (a) => formatDateTime(a.scheduledStart) },
    { key: 'job', header: 'Job', render: (a) => a.jobId },
    { key: 'technician', header: 'Technician', render: (a) => a.technicianName || '-' },
    { key: 'status', header: 'Status', render: (a) => a.status },
    { key: 'arrival', header: 'Arrival Window', render: (a) => formatArrivalWindow(a.arrivalWindowStart, a.arrivalWindowEnd) },
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
    <ListPage<Appointment>
      title="Appointments"
      columns={columns}
      data={data}
      total={total}
      page={page}
      pageSize={pageSize}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search appointments..."
      filters={filters}
      activeFilters={activeFilters}
      onFilterChange={handleFilterChange}
      onClearFilters={handleClearFilters}
      emptyTitle="No appointments yet"
      emptyDescription="Schedule an appointment from a job to get started."
      onSearch={setSearch}
      onPageChange={setPage}
      onRetry={refetch}
      getRowKey={(a) => a.id}
    />
  );
}
