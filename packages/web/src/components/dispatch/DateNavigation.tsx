import React from 'react';

export interface DateNavigationProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
}

function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function DateNavigation({ selectedDate, onDateChange }: DateNavigationProps) {
  const handlePreviousDay = () => {
    onDateChange(addDays(selectedDate, -1));
  };

  const handleNextDay = () => {
    onDateChange(addDays(selectedDate, 1));
  };

  const handleDateInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value) {
      const [year, month, day] = value.split('-').map(Number);
      const newDate = new Date(year, month - 1, day);
      if (!isNaN(newDate.getTime())) {
        onDateChange(newDate);
      }
    }
  };

  const handleToday = () => {
    onDateChange(new Date());
  };

  return (
    <div className="date-navigation" data-testid="date-navigation">
      <button
        className="date-navigation__btn"
        data-testid="date-nav-prev"
        onClick={handlePreviousDay}
        aria-label="Previous day"
      >
        &larr;
      </button>

      <span className="date-navigation__display" data-testid="date-nav-display">
        {formatDisplayDate(selectedDate)}
      </span>

      <button
        className="date-navigation__btn"
        data-testid="date-nav-next"
        onClick={handleNextDay}
        aria-label="Next day"
      >
        &rarr;
      </button>

      <button
        className="date-navigation__today-btn"
        data-testid="date-nav-today"
        onClick={handleToday}
      >
        Today
      </button>

      <input
        type="date"
        className="date-navigation__picker"
        data-testid="date-nav-picker"
        value={toDateInputValue(selectedDate)}
        onChange={handleDateInput}
        aria-label="Jump to date"
      />
    </div>
  );
}
