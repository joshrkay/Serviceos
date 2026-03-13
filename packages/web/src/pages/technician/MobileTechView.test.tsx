import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileTechView, AssignedJob } from './MobileTechView';

describe('P3-013 — Mobile-friendly technician interactions', () => {
  const jobs: AssignedJob[] = [
    {
      id: 'job-1',
      title: 'HVAC Repair',
      address: '123 Main St',
      appointmentId: 'apt-1',
      appointmentTime: '9:00 AM',
    },
    {
      id: 'job-2',
      title: 'Plumbing Fix',
      address: '456 Oak Ave',
      appointmentTime: '2:00 PM',
    },
  ];

  it('happy path — renders correctly at mobile viewport', () => {
    render(
      <MobileTechView
        assignedJobs={jobs}
        onSelectJob={vi.fn()}
        onUploadRecording={vi.fn()}
      />
    );

    expect(screen.getByTestId('mobile-tech-view')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-nav')).toBeInTheDocument();
    const jobItems = screen.getAllByTestId('mobile-job-item');
    expect(jobItems).toHaveLength(2);
    expect(jobItems[0]).toHaveTextContent('HVAC Repair');
    expect(jobItems[0]).toHaveTextContent('123 Main St');
  });

  it('happy path — selecting a job shows detail view with voice capture', () => {
    const onSelect = vi.fn();
    render(
      <MobileTechView
        assignedJobs={jobs}
        selectedJobId="job-1"
        onSelectJob={onSelect}
        onUploadRecording={vi.fn()}
      />
    );

    expect(screen.getByTestId('mobile-job-detail')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-job-detail-title')).toHaveTextContent('HVAC Repair');
    expect(screen.getByTestId('mobile-voice-section')).toBeInTheDocument();
    expect(screen.getByTestId('voice-recorder')).toBeInTheDocument();
  });

  it('happy path — clicking job triggers onSelectJob', () => {
    const onSelect = vi.fn();
    render(
      <MobileTechView
        assignedJobs={jobs}
        onSelectJob={onSelect}
        onUploadRecording={vi.fn()}
      />
    );

    fireEvent.click(screen.getAllByTestId('mobile-job-item')[1]);
    expect(onSelect).toHaveBeenCalledWith('job-2');
  });

  it('happy path — shows recent messages in condensed view', () => {
    const messages = [
      {
        id: 'msg-1',
        tenantId: 't1',
        conversationId: 'c1',
        messageType: 'text' as const,
        content: 'Unit checked',
        senderId: 'tech-1',
        senderRole: 'technician',
        createdAt: '2024-01-01T10:00:00Z',
      },
    ];

    render(
      <MobileTechView
        assignedJobs={jobs}
        selectedJobId="job-1"
        onSelectJob={vi.fn()}
        onUploadRecording={vi.fn()}
        messages={messages}
      />
    );

    expect(screen.getByTestId('mobile-messages')).toBeInTheDocument();
    expect(screen.getByText('Unit checked')).toBeInTheDocument();
  });

  it('validation — all interactive elements meet minimum touch target size', () => {
    render(
      <MobileTechView
        assignedJobs={jobs}
        onSelectJob={vi.fn()}
        onUploadRecording={vi.fn()}
      />
    );

    const jobItems = screen.getAllByTestId('mobile-job-item');
    jobItems.forEach((item) => {
      const style = item.style;
      expect(parseInt(style.minHeight)).toBeGreaterThanOrEqual(44);
      expect(parseInt(style.minWidth)).toBeGreaterThanOrEqual(44);
    });
  });

  it('happy path — shows transcript after voice capture', () => {
    render(
      <MobileTechView
        assignedJobs={jobs}
        selectedJobId="job-1"
        onSelectJob={vi.fn()}
        onUploadRecording={vi.fn()}
        transcriptionStatus="completed"
        transcript="Customer reports AC not cooling."
      />
    );

    expect(screen.getByTestId('transcript-message')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-content')).toHaveTextContent(
      'Customer reports AC not cooling.'
    );
  });
});
