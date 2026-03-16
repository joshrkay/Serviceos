import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SummaryStrip } from './SummaryStrip';

describe('P6-024 — Day-of operational summary strip', () => {
  const summary = {
    unassigned: 3,
    scheduled: 8,
    inProgress: 2,
    completed: 5,
    canceled: 1,
  };

  it('renders the summary strip', () => {
    render(<SummaryStrip summary={summary} />);
    expect(screen.getByTestId('summary-strip')).toBeInTheDocument();
  });

  it('displays all counts with labels', () => {
    render(<SummaryStrip summary={summary} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Canceled')).toBeInTheDocument();
  });

  it('renders zero counts correctly', () => {
    const emptySummary = {
      unassigned: 0,
      scheduled: 0,
      inProgress: 0,
      completed: 0,
      canceled: 0,
    };
    render(<SummaryStrip summary={emptySummary} />);
    const zeros = screen.getAllByText('0');
    expect(zeros).toHaveLength(5);
  });
});
