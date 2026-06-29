import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobFormsPanel, type JobFormsPanelApi } from './JobFormsPanel';
import type { JobFormSubmission, JobFormTemplate } from '../../api/job-forms';

const template = (over: Partial<JobFormTemplate> = {}): JobFormTemplate => ({
  id: 't1',
  tenantId: 'tn',
  name: 'Furnace Tune-Up',
  description: null,
  fields: [
    { id: 'f1', label: 'Filter replaced', fieldType: 'checkbox', options: [], required: true, sortOrder: 0 },
    { id: 'f2', label: 'Notes', fieldType: 'text', options: [], required: false, sortOrder: 1 },
  ],
  sortOrder: 0,
  isArchived: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const submission = (over: Partial<JobFormSubmission> = {}): JobFormSubmission => ({
  id: 's1',
  tenantId: 'tn',
  jobId: 'job-1',
  templateId: 't1',
  templateName: 'Furnace Tune-Up',
  fields: template().fields,
  answers: [],
  status: 'draft',
  completedBy: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<JobFormsPanelApi> = {}): JobFormsPanelApi {
  return {
    listTemplates: vi.fn().mockResolvedValue([]),
    listSubmissions: vi.fn().mockResolvedValue([]),
    createSubmission: vi.fn(),
    updateSubmission: vi.fn(),
    ...over,
  };
}

describe('JobFormsPanel (J-FORM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hints to create templates when none exist', async () => {
    render(<JobFormsPanel jobId="job-1" api={mockApi()} />);
    expect(await screen.findByText(/No form templates yet/)).toBeInTheDocument();
  });

  it('hints to add a form when templates exist but the job has none', async () => {
    const api = mockApi({ listTemplates: vi.fn().mockResolvedValue([template()]) });
    render(<JobFormsPanel jobId="job-1" api={api} />);
    expect(await screen.findByText(/No forms on this job yet/)).toBeInTheDocument();
    expect(screen.getByLabelText('Choose a form template')).toBeInTheDocument();
  });

  it('adds a form from a template', async () => {
    const created = submission();
    const api = mockApi({
      listTemplates: vi.fn().mockResolvedValue([template()]),
      createSubmission: vi.fn().mockResolvedValue(created),
    });
    render(<JobFormsPanel jobId="job-1" api={api} />);

    fireEvent.change(await screen.findByLabelText('Choose a form template'), {
      target: { value: 't1' },
    });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() =>
      expect(api.createSubmission).toHaveBeenCalledWith('job-1', { templateId: 't1' }),
    );
    // The new (expanded) submission renders its fields.
    expect(await screen.findByLabelText('Filter replaced')).toBeInTheDocument();
  });

  it('renders a status badge and expands to show fields', async () => {
    const api = mockApi({
      listTemplates: vi.fn().mockResolvedValue([template()]),
      listSubmissions: vi.fn().mockResolvedValue([submission()]),
    });
    render(<JobFormsPanel jobId="job-1" api={api} />);

    expect(await screen.findByText('Draft')).toBeInTheDocument();
    // Collapsed by default — expand by clicking the header.
    fireEvent.click(screen.getByRole('button', { name: /Furnace Tune-Up/ }));
    expect(screen.getByLabelText('Filter replaced')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
  });

  it('fills answers and marks the form complete', async () => {
    const sub = submission();
    const api = mockApi({
      listTemplates: vi.fn().mockResolvedValue([template()]),
      listSubmissions: vi.fn().mockResolvedValue([sub]),
      updateSubmission: vi.fn().mockResolvedValue({ ...sub, status: 'completed' }),
    });
    render(<JobFormsPanel jobId="job-1" api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: /Furnace Tune-Up/ }));
    fireEvent.click(screen.getByLabelText('Filter replaced')); // check the checkbox
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'all good' } });
    fireEvent.click(screen.getByText('Mark complete'));

    await waitFor(() =>
      expect(api.updateSubmission).toHaveBeenCalledWith('s1', {
        answers: [
          { fieldId: 'f1', value: 'true' },
          { fieldId: 'f2', value: 'all good' },
        ],
        complete: true,
      }),
    );
  });

  it('locks a completed submission (read-only, no complete button)', async () => {
    const api = mockApi({
      listTemplates: vi.fn().mockResolvedValue([template()]),
      listSubmissions: vi.fn().mockResolvedValue([
        submission({ status: 'completed', completedAt: '2026-02-02T00:00:00Z' }),
      ]),
    });
    render(<JobFormsPanel jobId="job-1" api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: /Furnace Tune-Up/ }));
    expect((screen.getByLabelText('Notes') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText('Mark complete')).not.toBeInTheDocument();
    expect(screen.getByText(/this record is locked/)).toBeInTheDocument();
  });

  it('gives interactive controls a ≥44px tap target (min-h-11)', async () => {
    const api = mockApi({
      listTemplates: vi.fn().mockResolvedValue([template()]),
      listSubmissions: vi.fn().mockResolvedValue([submission()]),
    });
    render(<JobFormsPanel jobId="job-1" api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: /Furnace Tune-Up/ }));
    expect(screen.getByLabelText('Notes').className).toContain('min-h-11');
    expect(screen.getByText('Mark complete').className).toContain('min-h-11');
    expect(screen.getByLabelText('Choose a form template').className).toContain('min-h-11');
  });
});
