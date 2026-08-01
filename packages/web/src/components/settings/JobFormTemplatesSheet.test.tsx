import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JobFormTemplatesSheet,
  type JobFormTemplatesSheetApi,
} from './JobFormTemplatesSheet';
import type { JobFormTemplate } from '../../api/job-forms';

const template = (over: Partial<JobFormTemplate> = {}): JobFormTemplate => ({
  id: 't1',
  tenantId: 'tn',
  name: 'Furnace Tune-Up',
  description: null,
  fields: [
    { id: 'f1', label: 'Filter replaced', fieldType: 'checkbox', options: [], required: true, sortOrder: 0 },
  ],
  sortOrder: 0,
  isArchived: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<JobFormTemplatesSheetApi> = {}): JobFormTemplatesSheetApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(template()),
    update: vi.fn().mockResolvedValue(template()),
    archive: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('JobFormTemplatesSheet (J-FORM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists existing templates with field counts', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([template()]) });
    render(<JobFormTemplatesSheet onClose={() => {}} api={api} />);
    expect(await screen.findByText('Furnace Tune-Up')).toBeInTheDocument();
    expect(screen.getByText('1 field')).toBeInTheDocument();
  });

  it('creates a template with a select field carrying parsed options', async () => {
    const api = mockApi();
    render(<JobFormTemplatesSheet onClose={() => {}} api={api} />);

    fireEvent.click(await screen.findByText('New template'));
    fireEvent.change(screen.getByLabelText('Form name'), {
      target: { value: 'Inspection' },
    });
    fireEvent.change(screen.getByLabelText('Field 1 label'), {
      target: { value: 'Tier' },
    });
    fireEvent.change(screen.getByLabelText('Field 1 type'), {
      target: { value: 'select' },
    });
    fireEvent.change(screen.getByLabelText('Field 1 options'), {
      target: { value: 'gold, silver , bronze' },
    });
    fireEvent.click(screen.getByText('Save template'));

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        name: 'Inspection',
        description: null,
        fields: [
          { id: undefined, label: 'Tier', fieldType: 'select', required: false, options: ['gold', 'silver', 'bronze'] },
        ],
      }),
    );
  });

  it('blocks saving a template with no name', async () => {
    const api = mockApi();
    render(<JobFormTemplatesSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByText('New template'));
    fireEvent.change(screen.getByLabelText('Field 1 label'), { target: { value: 'X' } });
    fireEvent.click(screen.getByText('Save template'));
    expect(await screen.findByText(/Give the form a name/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('archives a template', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([template()]) });
    render(<JobFormTemplatesSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByLabelText('Archive Furnace Tune-Up'));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith('t1'));
  });

  it('edits an existing template (preserves field ids)', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([template()]) });
    render(<JobFormTemplatesSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.change(screen.getByLabelText('Form name'), {
      target: { value: 'Furnace Tune-Up v2' },
    });
    fireEvent.click(screen.getByText('Save template'));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          name: 'Furnace Tune-Up v2',
          fields: [expect.objectContaining({ id: 'f1', label: 'Filter replaced' })],
        }),
      ),
    );
  });
});
