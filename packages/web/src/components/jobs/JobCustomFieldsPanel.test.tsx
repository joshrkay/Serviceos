import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JobCustomFieldsPanel,
  type JobCustomFieldsPanelApi,
} from './JobCustomFieldsPanel';
import type { ResolvedJobCustomField } from '../../api/job-custom-fields';

const field = (over: Partial<ResolvedJobCustomField> = {}): ResolvedJobCustomField => ({
  fieldDefId: 'f1',
  key: 'po_number',
  label: 'PO Number',
  fieldType: 'text',
  options: [],
  value: null,
  ...over,
});

function mockApi(over: Partial<JobCustomFieldsPanelApi> = {}): JobCustomFieldsPanelApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    setValue: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe('JobCustomFieldsPanel (J-CF)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when no custom fields are defined', async () => {
    const api = mockApi();
    const { container } = render(<JobCustomFieldsPanel jobId="j1" api={api} />);
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container.querySelector('h4')).toBeNull();
  });

  it('renders a typed control per field with its value', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([
        field({ fieldDefId: 'f1', label: 'PO Number', value: 'PO-9' }),
        field({ fieldDefId: 'f2', label: 'Tier', fieldType: 'select', options: ['gold', 'silver'], value: 'gold' }),
      ]),
    });
    render(<JobCustomFieldsPanel jobId="j1" api={api} />);
    const po = (await screen.findByLabelText('PO Number')) as HTMLInputElement;
    expect(po.value).toBe('PO-9');
    expect((screen.getByLabelText('Tier') as HTMLSelectElement).value).toBe('gold');
  });

  it('saves a text field on blur', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([field({ value: null })]),
      setValue: vi.fn().mockResolvedValue([field({ value: 'PO-42' })]),
    });
    render(<JobCustomFieldsPanel jobId="j1" api={api} />);
    const input = await screen.findByLabelText('PO Number');
    fireEvent.change(input, { target: { value: 'PO-42' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.setValue).toHaveBeenCalledWith('j1', 'f1', 'PO-42'));
  });

  it('sends null when clearing a field', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([field({ value: 'PO-9' })]),
    });
    render(<JobCustomFieldsPanel jobId="j1" api={api} />);
    const input = await screen.findByLabelText('PO Number');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.setValue).toHaveBeenCalledWith('j1', 'f1', null));
  });
});
