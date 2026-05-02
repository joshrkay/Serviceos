import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  RecurrenceBuilder,
  RecurrenceBuilderValue,
  buildRule,
} from '../RecurrenceBuilder';

function Harness({ initial }: { initial: RecurrenceBuilderValue }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <RecurrenceBuilder value={value} onChange={setValue} />
      <pre data-testid="rule">{buildRule(value)}</pre>
    </div>
  );
}

describe('P9-003 RecurrenceBuilder', () => {
  it('renders three dropdowns', () => {
    render(
      <Harness initial={{ frequency: 'monthly', interval: 1, dayOfMonth: 1 }} />,
    );
    expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    expect(screen.getByLabelText('Interval')).toBeInTheDocument();
    expect(screen.getByLabelText('Day of month')).toBeInTheDocument();
  });

  it('builds a quarterly rule when frequency changes', () => {
    render(
      <Harness initial={{ frequency: 'monthly', interval: 3, dayOfMonth: 15 }} />,
    );
    fireEvent.change(screen.getByLabelText('Frequency'), {
      target: { value: 'quarterly' },
    });
    expect(screen.getByTestId('rule').textContent).toBe(
      'FREQ=QUARTERLY;INTERVAL=3;BYMONTHDAY=15',
    );
  });

  it('updates day-of-month', () => {
    render(
      <Harness initial={{ frequency: 'monthly', interval: 1, dayOfMonth: 1 }} />,
    );
    fireEvent.change(screen.getByLabelText('Day of month'), {
      target: { value: '20' },
    });
    expect(screen.getByTestId('rule').textContent).toContain('BYMONTHDAY=20');
  });
});
