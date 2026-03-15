import React from 'react';

export interface SummaryStripProps {
  summary: {
    unassigned: number;
    scheduled: number;
    inProgress: number;
    completed: number;
    canceled: number;
  };
}

interface SummaryItem {
  label: string;
  value: number;
  className: string;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
  const items: SummaryItem[] = [
    { label: 'Unassigned', value: summary.unassigned, className: 'summary-strip__item--unassigned' },
    { label: 'Scheduled', value: summary.scheduled, className: 'summary-strip__item--scheduled' },
    { label: 'In Progress', value: summary.inProgress, className: 'summary-strip__item--in-progress' },
    { label: 'Completed', value: summary.completed, className: 'summary-strip__item--completed' },
    { label: 'Canceled', value: summary.canceled, className: 'summary-strip__item--canceled' },
  ];

  return (
    <div className="summary-strip" data-testid="summary-strip">
      {items.map((item) => (
        <div
          key={item.label}
          className={`summary-strip__item ${item.className}`}
          data-testid={`summary-${item.label.toLowerCase().replace(' ', '-')}`}
        >
          <span className="summary-strip__value">{item.value}</span>
          <span className="summary-strip__label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}
