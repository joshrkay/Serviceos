import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DateNavigation } from './DateNavigation';

describe('P6-005 — Date navigation for day view', () => {
  const baseDate = new Date(2026, 2, 14); // March 14, 2026

  it('renders date navigation with current date displayed', () => {
    render(<DateNavigation selectedDate={baseDate} onDateChange={vi.fn()} />);
    expect(screen.getByTestId('date-navigation')).toBeInTheDocument();
    expect(screen.getByTestId('date-nav-display')).toHaveTextContent('March 14, 2026');
  });

  it('navigates to previous day', () => {
    const onDateChange = vi.fn();
    render(<DateNavigation selectedDate={baseDate} onDateChange={onDateChange} />);
    fireEvent.click(screen.getByTestId('date-nav-prev'));
    expect(onDateChange).toHaveBeenCalledTimes(1);
    const newDate = onDateChange.mock.calls[0][0] as Date;
    expect(newDate.getDate()).toBe(13);
  });

  it('navigates to next day', () => {
    const onDateChange = vi.fn();
    render(<DateNavigation selectedDate={baseDate} onDateChange={onDateChange} />);
    fireEvent.click(screen.getByTestId('date-nav-next'));
    expect(onDateChange).toHaveBeenCalledTimes(1);
    const newDate = onDateChange.mock.calls[0][0] as Date;
    expect(newDate.getDate()).toBe(15);
  });

  it('navigates to today', () => {
    const onDateChange = vi.fn();
    const pastDate = new Date(2026, 0, 1);
    render(<DateNavigation selectedDate={pastDate} onDateChange={onDateChange} />);
    fireEvent.click(screen.getByTestId('date-nav-today'));
    expect(onDateChange).toHaveBeenCalledTimes(1);
    const newDate = onDateChange.mock.calls[0][0] as Date;
    const today = new Date();
    expect(newDate.getDate()).toBe(today.getDate());
  });

  it('renders date picker input with correct value', () => {
    render(<DateNavigation selectedDate={baseDate} onDateChange={vi.fn()} />);
    const picker = screen.getByTestId('date-nav-picker') as HTMLInputElement;
    expect(picker.value).toBe('2026-03-14');
  });

  it('handles date picker change', () => {
    const onDateChange = vi.fn();
    render(<DateNavigation selectedDate={baseDate} onDateChange={onDateChange} />);
    const picker = screen.getByTestId('date-nav-picker');
    fireEvent.change(picker, { target: { value: '2026-03-20' } });
    expect(onDateChange).toHaveBeenCalledTimes(1);
    const newDate = onDateChange.mock.calls[0][0] as Date;
    expect(newDate.getDate()).toBe(20);
    expect(newDate.getMonth()).toBe(2); // March
  });

  it('handles day boundary crossing (month boundary)', () => {
    const endOfMonth = new Date(2026, 2, 31);
    const onDateChange = vi.fn();
    render(<DateNavigation selectedDate={endOfMonth} onDateChange={onDateChange} />);
    fireEvent.click(screen.getByTestId('date-nav-next'));
    const newDate = onDateChange.mock.calls[0][0] as Date;
    expect(newDate.getMonth()).toBe(3); // April
    expect(newDate.getDate()).toBe(1);
  });
});
