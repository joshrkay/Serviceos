import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JobCustomFieldsSheet,
  type JobCustomFieldsSheetApi,
} from './JobCustomFieldsSheet';
import type { JobCustomFieldDef } from '../../api/job-custom-fields';

const def = (over: Partial<JobCustomFieldDef> = {}): JobCustomFieldDef => ({
  id: 'd1',
  tenantId: 'tn',
  key: 'po_number',
  label: 'PO Number',
  fieldType: 'text',
  options: [],
  sortOrder: 0,
  isArchived: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<JobCustomFieldsSheetApi> = {}): JobCustomFieldsSheetApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(def()),
    archive: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('JobCustomFieldsSheet (J-CF)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists existing defs', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([def()]) });
    render(<JobCustomFieldsSheet onClose={() => {}} api={api} />);
    expect(await screen.findByText('PO Number')).toBeInTheDocument();
  });

  it('creates a field, deriving a valid key from the label', async () => {
    const api = mockApi();
    render(<JobCustomFieldsSheet onClose={() => {}} api={api} />);
    fireEvent.change(await screen.findByLabelText('New field label'), {
      target: { value: 'Permit #' },
    });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        key: 'permit',
        label: 'Permit #',
        fieldType: 'text',
        options: [],
      }),
    );
  });

  it('parses dropdown options for a select field', async () => {
    const api = mockApi();
    render(<JobCustomFieldsSheet onClose={() => {}} api={api} />);
    fireEvent.change(await screen.findByLabelText('New field label'), {
      target: { value: 'Tier' },
    });
    fireEvent.change(screen.getByLabelText('New field type'), { target: { value: 'select' } });
    fireEvent.change(screen.getByLabelText('New field options'), {
      target: { value: 'gold, silver' },
    });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        key: 'tier',
        label: 'Tier',
        fieldType: 'select',
        options: ['gold', 'silver'],
      }),
    );
  });

  it('blocks adding without a label', async () => {
    const api = mockApi();
    render(<JobCustomFieldsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByText('Add'));
    expect(await screen.findByText(/Give the field a label/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('archives a field', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([def()]) });
    render(<JobCustomFieldsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByLabelText('Remove PO Number'));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith('d1'));
  });
});
