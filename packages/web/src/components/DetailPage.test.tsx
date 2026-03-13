import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DetailPage } from './DetailPage';

describe('DetailPage', () => {
  const baseProps = {
    title: 'Test Item',
    sections: [{ title: 'Info', content: <p>Details here</p> }],
    isLoading: false,
    error: null,
    onRetry: vi.fn(),
  };

  it('renders title and sections', () => {
    render(<DetailPage {...baseProps} />);
    expect(screen.getByText('Test Item')).toBeInTheDocument();
    expect(screen.getByText('Info')).toBeInTheDocument();
    expect(screen.getByText('Details here')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<DetailPage {...baseProps} subtitle="Sub info" />);
    expect(screen.getByText('Sub info')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<DetailPage {...baseProps} isLoading={true} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    render(<DetailPage {...baseProps} error="Something failed" />);
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });

  it('renders back button when onBack provided', () => {
    const onBack = vi.fn();
    render(<DetailPage {...baseProps} onBack={onBack} />);
    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders action buttons', () => {
    const onClick = vi.fn();
    render(<DetailPage {...baseProps} actions={[{ label: 'Edit', onClick, variant: 'primary' }]} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
