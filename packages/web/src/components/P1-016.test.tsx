import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListPage } from './ListPage';
import { DetailPage } from './DetailPage';
import { useListQuery } from '../hooks/useListQuery';

describe('P1-016 — Operational list/detail views, filters, and search', () => {
  const columns = [
    { key: 'name', header: 'Name', render: (item: { id: string; name: string; status?: string }) => item.name },
    { key: 'status', header: 'Status', render: (item: { id: string; name: string; status?: string }) => item.status ?? '' },
  ];

  const sampleData = [
    { id: '1', name: 'Job #1 — Furnace Repair', status: 'new' },
    { id: '2', name: 'Job #2 — AC Tune-up', status: 'in_progress' },
    { id: '3', name: 'Job #3 — Drain Clog', status: 'completed' },
  ];

  const baseListProps = {
    title: 'Jobs',
    columns,
    data: sampleData,
    total: 3,
    page: 1,
    pageSize: 25,
    isLoading: false,
    error: null,
    onSearch: vi.fn(),
    onPageChange: vi.fn(),
    onRetry: vi.fn(),
    getRowKey: (item: { id: string }) => item.id,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── List view ─────────────────────────────────────────────────────────────

  it('happy path — list renders title, column headers, and all rows', () => {
    render(<ListPage {...baseListProps} />);
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Job #1 — Furnace Repair')).toBeInTheDocument();
    expect(screen.getByText('Job #2 — AC Tune-up')).toBeInTheDocument();
    expect(screen.getByText('Job #3 — Drain Clog')).toBeInTheDocument();
  });

  it('happy path — list row click triggers onRowClick handler', () => {
    const onRowClick = vi.fn();
    render(<ListPage {...baseListProps} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('Job #1 — Furnace Repair'));
    expect(onRowClick).toHaveBeenCalledWith(sampleData[0]);
  });

  it('happy path — create button calls onCreate when label and handler provided', () => {
    const onCreate = vi.fn();
    render(<ListPage {...baseListProps} createLabel="New Job" onCreate={onCreate} />);
    fireEvent.click(screen.getByText('New Job'));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('happy path — pagination shows page info and navigates', () => {
    const onPageChange = vi.fn();
    render(<ListPage {...baseListProps} total={75} pageSize={25} page={2} onPageChange={onPageChange} />);
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Previous'));
    expect(onPageChange).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByText('Next'));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('happy path — filter bar renders when filter config provided', () => {
    const filters = [
      {
        key: 'priority',
        label: 'Priority',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
        ],
      },
    ];
    render(
      <ListPage
        {...baseListProps}
        filters={filters}
        activeFilters={{}}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );
    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  // ── Empty / loading / error states ────────────────────────────────────────

  it('happy path — shows empty state when no data and custom title', () => {
    render(<ListPage {...baseListProps} data={[]} total={0} emptyTitle="No jobs yet" emptyDescription="Create your first job" />);
    expect(screen.getByText('No jobs yet')).toBeInTheDocument();
    expect(screen.getByText('Create your first job')).toBeInTheDocument();
  });

  it('happy path — shows default empty title when no data and no custom title', () => {
    render(<ListPage {...baseListProps} data={[]} total={0} />);
    expect(screen.getByText('No items found')).toBeInTheDocument();
  });

  it('happy path — shows loading state while fetching', () => {
    render(<ListPage {...baseListProps} isLoading={true} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Jobs')).not.toBeInTheDocument();
  });

  it('happy path — shows error state with retry on fetch failure', () => {
    const onRetry = vi.fn();
    render(<ListPage {...baseListProps} error="Failed to load jobs" onRetry={onRetry} />);
    expect(screen.getByText('Failed to load jobs')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  // ── Detail view ───────────────────────────────────────────────────────────

  it('happy path — detail page renders title, subtitle, and sections', () => {
    render(
      <DetailPage
        title="Job #1 — Furnace Repair"
        subtitle="New • Priority: Normal"
        sections={[
          { title: 'Problem Description', content: <p>Furnace not heating</p> },
          { title: 'Location', content: <p>123 Main St, Anytown</p> },
        ]}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText('Job #1 — Furnace Repair')).toBeInTheDocument();
    expect(screen.getByText('New • Priority: Normal')).toBeInTheDocument();
    expect(screen.getByText('Problem Description')).toBeInTheDocument();
    expect(screen.getByText('Furnace not heating')).toBeInTheDocument();
    expect(screen.getByText('Location')).toBeInTheDocument();
  });

  it('happy path — detail page back button calls onBack', () => {
    const onBack = vi.fn();
    render(
      <DetailPage
        title="Customer Detail"
        sections={[{ title: 'Info', content: <p>Test</p> }]}
        isLoading={false}
        error={null}
        onBack={onBack}
        onRetry={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('happy path — detail page action buttons fire handlers', () => {
    const onEdit = vi.fn();
    const onArchive = vi.fn();
    render(
      <DetailPage
        title="Customer"
        sections={[{ title: 'Info', content: <p>Test</p> }]}
        actions={[
          { label: 'Edit', onClick: onEdit, variant: 'primary' },
          { label: 'Archive', onClick: onArchive, variant: 'danger' },
        ]}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Archive'));
    expect(onArchive).toHaveBeenCalledOnce();
  });

  it('happy path — detail page loading state hides content', () => {
    render(
      <DetailPage
        title="Customer"
        sections={[{ title: 'Info', content: <p>Data</p> }]}
        isLoading={true}
        error={null}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Customer')).not.toBeInTheDocument();
  });

  it('happy path — detail page error state shows retry', () => {
    const onRetry = vi.fn();
    render(
      <DetailPage
        title="Customer"
        sections={[]}
        isLoading={false}
        error="Customer not found"
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Customer not found')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  // ── useListQuery hook ─────────────────────────────────────────────────────

  it('happy path — useListQuery fetches and returns list data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: sampleData, total: 3 }),
    } as Response);

    const { result } = renderHook(() => useListQuery<(typeof sampleData)[0]>('/api/jobs'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(3);
    expect(result.current.total).toBe(3);
    expect(result.current.error).toBeNull();
  });

  it('happy path — search param included in query URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.setSearch('furnace'));
    await waitFor(() => {
      const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
      expect(url).toContain('search=furnace');
    });
  });

  it('happy path — filter params included in query URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.setFilters({ status: 'new' }));
    await waitFor(() => {
      const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
      expect(url).toContain('status=new');
    });
  });

  it('validation test — list page shows empty state when data array is empty', () => {
    render(<ListPage {...baseListProps} data={[]} total={0} emptyTitle="No results match your filters" />);
    expect(screen.getByText('No results match your filters')).toBeInTheDocument();
    expect(screen.queryByText('Job #1 — Furnace Repair')).not.toBeInTheDocument();
  });

  it('validation test — pagination disabled at first page boundary', () => {
    render(<ListPage {...baseListProps} total={50} pageSize={25} page={1} />);
    expect(screen.getByText('Previous')).toBeDisabled();
    expect(screen.getByText('Next')).not.toBeDisabled();
  });

  it('validation test — pagination disabled at last page boundary', () => {
    render(<ListPage {...baseListProps} total={50} pageSize={25} page={2} />);
    expect(screen.getByText('Previous')).not.toBeDisabled();
    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('validation test — useListQuery surfaces error for non-200 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);

    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(result.current.error).toBe('HTTP 404'));
    expect(result.current.data).toHaveLength(0);
  });

  it('validation test — useListQuery surfaces network error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network unreachable'));

    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(result.current.error).toBe('Network unreachable'));
  });
});
