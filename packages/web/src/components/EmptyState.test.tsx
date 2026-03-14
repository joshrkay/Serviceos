import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState title="No items" />);
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="No items" description="Try adding one" />);
    expect(screen.getByText('Try adding one')).toBeInTheDocument();
  });

  it('does not render description when omitted', () => {
    const { container } = render(<EmptyState title="No items" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders action button when both label and handler provided', () => {
    const onAction = vi.fn();
    render(<EmptyState title="No items" actionLabel="Add" onAction={onAction} />);
    fireEvent.click(screen.getByText('Add'));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('does not render button when actionLabel is missing', () => {
    render(<EmptyState title="No items" onAction={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
