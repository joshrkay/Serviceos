import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bell } from 'lucide-react';
import * as analytics from '../../lib/analytics';
import { Walkthrough, type WalkStep } from './Walkthrough';

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

const STEPS: WalkStep[] = [
  { id: 'one', icon: <Bell size={16} />, title: 'Step One', body: 'First body' },
  { id: 'two', icon: <Bell size={16} />, title: 'Step Two', body: 'Second body' },
];

describe('Walkthrough engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('advances through steps and completes on the last one', () => {
    const onComplete = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Walkthrough open steps={STEPS} tourId="t" onComplete={onComplete} onDismiss={onDismiss} />,
    );

    expect(screen.getByText('Step One')).toBeInTheDocument();
    expect(analytics.track).toHaveBeenCalledWith('tour_started', { tourId: 't', steps: 2 });

    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('Step Two')).toBeInTheDocument();
    expect(analytics.track).toHaveBeenCalledWith('tour_step_viewed', {
      tourId: 't',
      stepId: 'two',
      stepIndex: 1,
    });

    fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(analytics.track).toHaveBeenCalledWith('tour_completed', { tourId: 't', steps: 2 });
  });

  it('Back returns to the previous step', () => {
    render(<Walkthrough open steps={STEPS} tourId="t" onComplete={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText('Step One')).toBeInTheDocument();
  });

  it('Skip on the first step dismisses and reports it', () => {
    const onDismiss = vi.fn();
    render(<Walkthrough open steps={STEPS} tourId="t" onComplete={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith('tour_dismissed', { tourId: 't', stepIndex: 0 });
  });

  it('renders nothing when closed', () => {
    render(<Walkthrough open={false} steps={STEPS} tourId="t" onComplete={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByText('Step One')).not.toBeInTheDocument();
  });

  it('uses ≥44px (lg, h-12) primary CTA — glove-friendly', () => {
    render(<Walkthrough open steps={STEPS} tourId="t" onComplete={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('button', { name: /next/i }).className).toContain('h-12');
  });
});
