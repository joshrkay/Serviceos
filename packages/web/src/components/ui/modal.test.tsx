import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Modal } from './modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hi">
        body
      </Modal>,
    );
    expect(screen.queryByTestId('modal')).toBeNull();
  });

  it('renders title, description and children when open', () => {
    render(
      <Modal open onClose={() => {}} title="Confirm" description="Are you sure?">
        <p>content</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Hi">
        body
      </Modal>,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Hi">
        body
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders footer actions', () => {
    render(
      <Modal open onClose={() => {}} title="Hi" footer={<button>Save</button>}>
        body
      </Modal>,
    );
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('renders the description when there is no title and no close button', () => {
    // Non-dismissible dialog: description must still render (and remain the
    // target of aria-describedby) even though the header has no title/close.
    render(
      <Modal open onClose={() => {}} description="Processing payment…" showClose={false}>
        body
      </Modal>,
    );
    const desc = screen.getByText('Processing payment…');
    expect(desc).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-describedby', desc.id);
  });
});
