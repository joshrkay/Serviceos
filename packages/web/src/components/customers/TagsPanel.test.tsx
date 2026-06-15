import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TagsPanel } from './TagsPanel';

vi.mock('../../api/customers', () => ({
  listTags: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
}));

import { listTags, addTag, removeTag } from '../../api/customers';

describe('TagsPanel (U2)', () => {
  beforeEach(() => {
    vi.mocked(listTags).mockReset().mockResolvedValue([]);
    vi.mocked(addTag).mockReset().mockResolvedValue([]);
    vi.mocked(removeTag).mockReset().mockResolvedValue([]);
  });

  it('renders tag chips', async () => {
    vi.mocked(listTags).mockResolvedValue(['vip', 'net-30']);
    render(<TagsPanel customerId="1" />);
    expect(await screen.findByText('vip')).toBeInTheDocument();
    expect(screen.getByText('net-30')).toBeInTheDocument();
  });

  it('shows an empty state with no tags', async () => {
    render(<TagsPanel customerId="1" />);
    expect(await screen.findByText('No tags yet.')).toBeInTheDocument();
  });

  it('adds a tag and renders the server-returned list', async () => {
    vi.mocked(addTag).mockResolvedValue(['vip']);
    render(<TagsPanel customerId="1" />);
    await screen.findByText('No tags yet.');

    fireEvent.change(screen.getByLabelText('Add a tag'), { target: { value: 'vip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));

    await waitFor(() => expect(vi.mocked(addTag)).toHaveBeenCalledWith('1', 'vip'));
    expect(await screen.findByText('vip')).toBeInTheDocument();
  });

  it('removes a tag', async () => {
    vi.mocked(listTags).mockResolvedValue(['vip']);
    vi.mocked(removeTag).mockResolvedValue([]);
    render(<TagsPanel customerId="1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag vip' }));
    await waitFor(() => expect(vi.mocked(removeTag)).toHaveBeenCalledWith('1', 'vip'));
  });

  it('does not submit an empty tag', async () => {
    render(<TagsPanel customerId="1" />);
    await screen.findByText('No tags yet.');
    fireEvent.submit(screen.getByLabelText('Add a tag').closest('form')!);
    expect(vi.mocked(addTag)).not.toHaveBeenCalled();
  });
});
