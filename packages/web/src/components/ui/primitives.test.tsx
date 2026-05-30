import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Progress } from './progress';
import { Avatar } from './avatar';
import { Tooltip } from './tooltip';
import { StatCard } from './stat-card';
import { Stepper } from './stepper';

describe('Progress', () => {
  it('reports value via aria and clamps width', () => {
    render(<Progress value={150} max={100} label="loading" />);
    const bar = screen.getByRole('progressbar', { name: 'loading' });
    expect(bar).toHaveAttribute('aria-valuenow', '150');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect((bar.firstChild as HTMLElement).style.width).toBe('100%');
  });
});

describe('Avatar', () => {
  it('derives initials from a full name', () => {
    render(<Avatar name="Alice Smith" />);
    expect(screen.getByText('AS')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Alice Smith' })).toBeInTheDocument();
  });

  it('renders an image when src is provided', () => {
    render(<Avatar name="Bob Jones" src="/bob.png" />);
    const img = screen.getByAltText('Bob Jones') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
  });
});

describe('Tooltip', () => {
  it('shows content on hover and hides on leave', () => {
    render(
      <Tooltip content="Help text">
        <button>?</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text');
    fireEvent.mouseLeave(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('StatCard', () => {
  it('renders label, value and hint', () => {
    render(<StatCard label="Active today" value="7" hint="2 in progress" />);
    expect(screen.getByText('Active today')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('2 in progress')).toBeInTheDocument();
  });
});

describe('Stepper', () => {
  const steps = [
    { value: 'draft', label: 'Draft' },
    { value: 'sent', label: 'Sent' },
    { value: 'paid', label: 'Paid' },
  ];

  it('marks the current step with aria-current', () => {
    render(<Stepper steps={steps} current="sent" />);
    const current = screen.getByText('Sent').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
  });
});
