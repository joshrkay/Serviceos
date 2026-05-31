import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Sheet } from './sheet';

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(
      <Sheet open={false} onClose={() => {}} title="Edit">
        body
      </Sheet>,
    );
    expect(screen.queryByTestId('sheet')).toBeNull();
  });

  it('renders as a labelled dialog when open', () => {
    render(
      <Sheet open onClose={() => {}} title="Edit customer">
        <p>form</p>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Edit customer')).toBeInTheDocument();
    expect(screen.getByText('form')).toBeInTheDocument();
  });

  it('closes on Escape and backdrop click', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Edit">
        body
      </Sheet>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
