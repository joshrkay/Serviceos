import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobDetail } from './JobDetail';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: vi.fn(),
}));

vi.mock('../../components/jobs/JobPhotosSection', () => ({
  JobPhotosSection: ({ jobId }: { jobId: string }) => (
    <div data-testid="job-photos-section">photos-{jobId}</div>
  ),
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

describe('JobDetail', () => {
  beforeEach(() => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: { id: '1', jobNumber: 'JOB-001', summary: 'Fix leak', problemDescription: 'Pipe burst', status: 'open', priority: 'high' },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders job details', () => {
    render(<JobDetail jobId="1" />);
    expect(screen.getByText('JOB-001 — Fix leak')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
  });

  it('shows loading when no data', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: true, error: null, refetch: vi.fn(),
    });
    render(<JobDetail jobId="1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  describe('site media section', () => {
    it('renders Site Media heading', () => {
      render(<JobDetail jobId="1" />);
      expect(screen.getByText('Site Media')).toBeInTheDocument();
    });

    it('renders job photos section wired to job id', () => {
      render(<JobDetail jobId="1" />);
      expect(screen.getByTestId('job-photos-section')).toHaveTextContent('photos-1');
    });
  });
});
