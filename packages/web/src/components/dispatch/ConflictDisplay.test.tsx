import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConflictDisplay, ConflictInfo } from './ConflictDisplay';

describe('P6-018 — Conflict visibility in proposal review', () => {
  it('renders nothing when no conflicts', () => {
    const { container } = render(<ConflictDisplay conflicts={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders blocking conflicts with blocking banner', () => {
    const conflicts: ConflictInfo[] = [
      {
        type: 'overlapping_appointment',
        severity: 'blocking',
        message: 'Overlaps with appointment appt-2',
        conflictingEntityId: 'appt-2',
      },
    ];

    render(<ConflictDisplay conflicts={conflicts} />);
    expect(screen.getByTestId('conflict-display')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-display-blocking')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-blocking-message')).toHaveTextContent(
      'This proposal cannot be approved'
    );
    expect(screen.getByText('Overlaps with appointment appt-2')).toBeInTheDocument();
  });

  it('renders warning conflicts', () => {
    const conflicts: ConflictInfo[] = [
      {
        type: 'outside_working_hours',
        severity: 'warning',
        message: 'Appointment falls outside working hours',
      },
    ];

    render(<ConflictDisplay conflicts={conflicts} onAcknowledgeWarnings={vi.fn()} />);
    expect(screen.getByTestId('conflict-display-warning')).toBeInTheDocument();
    expect(screen.getByText('Appointment falls outside working hours')).toBeInTheDocument();
  });

  it('shows acknowledge button for warnings when no blocking', () => {
    const onAcknowledge = vi.fn();
    const conflicts: ConflictInfo[] = [
      { type: 'unavailable_block', severity: 'warning', message: 'Block conflict' },
    ];

    render(<ConflictDisplay conflicts={conflicts} onAcknowledgeWarnings={onAcknowledge} />);
    const btn = screen.getByTestId('conflict-acknowledge-btn');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('hides acknowledge button when blocking conflicts present', () => {
    const conflicts: ConflictInfo[] = [
      { type: 'overlapping_appointment', severity: 'blocking', message: 'Blocking overlap' },
      { type: 'outside_working_hours', severity: 'warning', message: 'Outside hours' },
    ];

    render(<ConflictDisplay conflicts={conflicts} onAcknowledgeWarnings={vi.fn()} />);
    expect(screen.queryByTestId('conflict-acknowledge-btn')).not.toBeInTheDocument();
  });

  it('shows correct counts for mixed conflicts', () => {
    const conflicts: ConflictInfo[] = [
      { type: 'overlapping_appointment', severity: 'blocking', message: 'Block 1' },
      { type: 'overlapping_appointment', severity: 'blocking', message: 'Block 2' },
      { type: 'outside_working_hours', severity: 'warning', message: 'Warning 1' },
    ];

    render(<ConflictDisplay conflicts={conflicts} />);
    expect(screen.getByText('Blocking Conflicts (2)')).toBeInTheDocument();
    expect(screen.getByText('Warnings (1)')).toBeInTheDocument();
  });
});
