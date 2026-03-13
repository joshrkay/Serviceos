import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ContextPanel } from './context-panel';
import { ContextEntity } from '../../types/conversation';

describe('P3-007 — Conversation-side context panel', () => {
  const entities: ContextEntity[] = [
    {
      type: 'customer',
      id: 'cust-1',
      label: 'John Smith',
      details: { phone: '555-1234', email: 'john@example.com' },
    },
    {
      type: 'job',
      id: 'job-1',
      label: 'HVAC Installation #456',
      details: { status: 'scheduled', address: '123 Main St' },
    },
    {
      type: 'appointment',
      id: 'apt-1',
      label: 'Jan 15, 2024 9:00 AM',
      details: { technician: 'Tech Mike', duration: '2 hours' },
    },
  ];

  it('happy path — renders context panel with linked entity data', () => {
    render(<ContextPanel entities={entities} conversationTitle="Job #456 Discussion" />);

    expect(screen.getByTestId('context-panel')).toBeInTheDocument();
    expect(screen.getByTestId('context-panel-title')).toHaveTextContent('Job #456 Discussion');

    expect(screen.getByTestId('context-entity-customer')).toBeInTheDocument();
    expect(screen.getByTestId('context-entity-job')).toBeInTheDocument();
    expect(screen.getByTestId('context-entity-appointment')).toBeInTheDocument();

    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByTestId('context-detail-value-phone')).toHaveTextContent('555-1234');
    expect(screen.getByTestId('context-detail-value-status')).toHaveTextContent('scheduled');
  });

  it('happy path — sections are collapsible', () => {
    render(<ContextPanel entities={entities} />);

    const toggles = screen.getAllByTestId('context-section-toggle');
    expect(toggles).toHaveLength(3);

    // All sections start open
    expect(screen.getAllByTestId('context-section-content')).toHaveLength(3);

    // Collapse first section
    fireEvent.click(toggles[0]);
    expect(screen.getAllByTestId('context-section-content')).toHaveLength(2);

    // Re-expand
    fireEvent.click(toggles[0]);
    expect(screen.getAllByTestId('context-section-content')).toHaveLength(3);
  });

  it('happy path — entity type labels are human-readable', () => {
    render(<ContextPanel entities={entities} />);

    const toggles = screen.getAllByTestId('context-section-toggle');
    expect(toggles[0]).toHaveTextContent('Customer');
    expect(toggles[1]).toHaveTextContent('Job');
    expect(toggles[2]).toHaveTextContent('Appointment');
  });

  it('validation — handles missing/null entity gracefully', () => {
    render(<ContextPanel entities={[]} />);
    expect(screen.getByTestId('context-panel-empty')).toHaveTextContent(
      'No linked context available'
    );
  });

  it('validation — handles unknown entity type', () => {
    const unknownEntity: ContextEntity = {
      type: 'custom_thing',
      id: 'ct-1',
      label: 'Custom',
      details: { key: 'value' },
    };
    render(<ContextPanel entities={[unknownEntity]} />);
    expect(screen.getByTestId('context-section-toggle')).toHaveTextContent('custom_thing');
  });
});
