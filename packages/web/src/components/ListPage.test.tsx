import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ListPage } from './ListPage';

describe('ListPage', () => {
  const columns = [
    { key: 'name', header: 'Name', render: (item: { id: string; name: string }) => item.name },
  ];

  const baseProps = {
    title: 'Items',
    columns,
    data: [{ id: '1', name: 'Item 1' }, { id: '2', name: 'Item 2' }],
    total: 2,
    page: 1,
    pageSize: 25,
    isLoading: false,
    error: null,
    onSearch: vi.fn(),
    onPageChange: vi.fn(),
    onRetry: vi.fn(),
    getRowKey: (item: { id: string }) => item.id,
  };

  it('renders title and data rows', () => {
    render(<ListPage {...baseProps} />);
    expect(screen.getByText('Items')).toBeInTheDocument();
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<ListPage {...baseProps} isLoading={true} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    render(<ListPage {...baseProps} error="Failed to load" />);
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(<ListPage {...baseProps} data={[]} total={0} emptyTitle="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows default empty title', () => {
    render(<ListPage {...baseProps} data={[]} total={0} />);
    expect(screen.getByText('No items found')).toBeInTheDocument();
  });

  it('renders create button when onCreate and createLabel provided', () => {
    const onCreate = vi.fn();
    render(<ListPage {...baseProps} createLabel="New Item" onCreate={onCreate} />);
    fireEvent.click(screen.getByText('New Item'));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('handles row clicks', () => {
    const onRowClick = vi.fn();
    render(<ListPage {...baseProps} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('Item 1'));
    expect(onRowClick).toHaveBeenCalledWith({ id: '1', name: 'Item 1' });
  });

  it('renders pagination when multiple pages', () => {
    render(<ListPage {...baseProps} total={50} pageSize={25} page={1} />);
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('navigates pages', () => {
    const onPageChange = vi.fn();
    render(<ListPage {...baseProps} total={75} pageSize={25} page={2} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByText('Previous'));
    expect(onPageChange).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByText('Next'));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('disables pagination buttons at boundaries', () => {
    render(<ListPage {...baseProps} total={50} pageSize={25} page={1} />);
    expect(screen.getByText('Previous')).toBeDisabled();
    expect(screen.getByText('Next')).not.toBeDisabled();
  });

  it('renders filter bar when filter props provided', () => {
    const filters = [{ key: 'status', label: 'Status', options: [{ label: 'Open', value: 'open' }] }];
    render(
      <ListPage
        {...baseProps}
        filters={filters}
        activeFilters={{}}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
      />
    );
    expect(screen.getByText('Status')).toBeInTheDocument();
  });
});
