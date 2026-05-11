/**
 * P9-003 — RecurrenceBuilder.
 *
 * Three dropdowns (frequency, interval, day-of-month) that compose the
 * RRULE-subset string the API expects. Pure controlled component — owners
 * pass `value` + `onChange`.
 */
import React from 'react';

export type RecurrenceFrequency = 'monthly' | 'quarterly' | 'yearly';

export interface RecurrenceBuilderValue {
  frequency: RecurrenceFrequency;
  interval: number;
  dayOfMonth: number;
}

export interface RecurrenceBuilderProps {
  value: RecurrenceBuilderValue;
  onChange: (value: RecurrenceBuilderValue) => void;
}

export function buildRule(value: RecurrenceBuilderValue): string {
  const freq = value.frequency.toUpperCase();
  return `FREQ=${freq};INTERVAL=${value.interval};BYMONTHDAY=${value.dayOfMonth}`;
}

const FREQUENCIES: RecurrenceFrequency[] = ['monthly', 'quarterly', 'yearly'];
const INTERVALS = [1, 2, 3, 4, 6, 12];
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

export function RecurrenceBuilder({ value, onChange }: RecurrenceBuilderProps): JSX.Element {
  return (
    <div className="flex gap-2 items-end" data-testid="recurrence-builder">
      <label className="flex flex-col text-sm">
        Frequency
        <select
          aria-label="Frequency"
          className="border rounded px-2 py-1"
          value={value.frequency}
          onChange={(e) =>
            onChange({ ...value, frequency: e.target.value as RecurrenceFrequency })
          }
        >
          {FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-sm">
        Every
        <select
          aria-label="Interval"
          className="border rounded px-2 py-1"
          value={value.interval}
          onChange={(e) => onChange({ ...value, interval: Number(e.target.value) })}
        >
          {INTERVALS.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-sm">
        Day of month
        <select
          aria-label="Day of month"
          className="border rounded px-2 py-1"
          value={value.dayOfMonth}
          onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.target.value) })}
        >
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
