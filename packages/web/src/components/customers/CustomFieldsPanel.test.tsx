import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomFieldsPanel } from './CustomFieldsPanel';

vi.mock('../../api/customers', () => ({
  listCustomFields: vi.fn(),
  setCustomFieldValue: vi.fn(),
}));

import { listCustomFields, setCustomFieldValue } from '../../api/customers';

const field = (over: Partial<Record<string, unknown>> = {}) => ({
  fieldDefId: 'f1',
  key: 'gate_code',
  label: 'Gate Code',
  fieldType: 'text',
  options: [],
  value: null,
  ...over,
});

describe('CustomFieldsPanel (U2)', () => {
  beforeEach(() => {
    vi.mocked(listCustomFields).mockReset().mockResolvedValue([]);
    vi.mocked(setCustomFieldValue).mockReset().mockResolvedValue([]);
  });

  it('shows an empty hint when no fields are defined', async () => {
    render(<CustomFieldsPanel customerId="1" />);
    expect(await screen.findByText(/No custom fields defined/)).toBeInTheDocument();
  });

  it('renders a typed control per field with its current value', async () => {
    vi.mocked(listCustomFields).mockResolvedValue([
      field({ fieldDefId: 'f1', key: 'gate_code', label: 'Gate Code', value: '1234' }),
      field({
        fieldDefId: 'f2',
        key: 'membership',
        label: 'Membership',
        fieldType: 'select',
        options: ['gold', 'silver'],
        value: 'gold',
      }),
    ] as never);

    render(<CustomFieldsPanel customerId="1" />);

    const gate = (await screen.findByLabelText('Gate Code')) as HTMLInputElement;
    expect(gate.value).toBe('1234');
    const membership = screen.getByLabelText('Membership') as HTMLSelectElement;
    expect(membership.value).toBe('gold');
  });

  it('saves a text field on blur', async () => {
    vi.mocked(listCustomFields).mockResolvedValue([field({ value: null })] as never);
    vi.mocked(setCustomFieldValue).mockResolvedValue([field({ value: '9999' })] as never);

    render(<CustomFieldsPanel customerId="1" />);
    const input = await screen.findByLabelText('Gate Code');
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(vi.mocked(setCustomFieldValue)).toHaveBeenCalledWith('1', 'f1', '9999'),
    );
  });

  it('saves a select field on change', async () => {
    vi.mocked(listCustomFields).mockResolvedValue([
      field({
        fieldDefId: 'f2',
        label: 'Membership',
        fieldType: 'select',
        options: ['gold', 'silver'],
        value: null,
      }),
    ] as never);

    render(<CustomFieldsPanel customerId="1" />);
    fireEvent.change(await screen.findByLabelText('Membership'), { target: { value: 'silver' } });

    await waitFor(() =>
      expect(vi.mocked(setCustomFieldValue)).toHaveBeenCalledWith('1', 'f2', 'silver'),
    );
  });

  it('sends null when clearing a field', async () => {
    vi.mocked(listCustomFields).mockResolvedValue([field({ value: '1234' })] as never);
    render(<CustomFieldsPanel customerId="1" />);
    const input = await screen.findByLabelText('Gate Code');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(vi.mocked(setCustomFieldValue)).toHaveBeenCalledWith('1', 'f1', null),
    );
  });
});
