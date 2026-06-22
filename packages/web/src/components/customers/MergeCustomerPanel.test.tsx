import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MergeCustomerPanel } from './MergeCustomerPanel';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiFetch } from '../../utils/api-fetch';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('MergeCustomerPanel (Story 4.6)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('searches for duplicates, excluding the survivor and archived rows', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse([
        { id: 'survivor', displayName: 'Keep Me' },
        { id: 'dupe', displayName: 'Drop Me', primaryPhone: '555-0000' },
        { id: 'archived', displayName: 'Old Me', isArchived: true },
      ]),
    );
    const onMerged = vi.fn();
    render(
      <MergeCustomerPanel survivingId="survivor" survivingName="Keep Me" onMerged={onMerged} />,
    );

    fireEvent.change(screen.getByLabelText('Search duplicates'), {
      target: { value: 'me' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));

    await waitFor(() => expect(screen.getByText('Drop Me')).toBeInTheDocument());
    // Survivor + archived are filtered out.
    expect(screen.queryByText('Old Me')).not.toBeInTheDocument();
    expect(screen.queryByTestId('merge-candidate-survivor')).not.toBeInTheDocument();
  });

  it('requires a confirmation step, then posts the merge', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse([{ id: 'dupe', displayName: 'Drop Me' }]))
      .mockResolvedValueOnce(jsonResponse({ survivingId: 'survivor', losingId: 'dupe' }));
    const onMerged = vi.fn();
    render(
      <MergeCustomerPanel survivingId="survivor" survivingName="Keep Me" onMerged={onMerged} />,
    );

    fireEvent.change(screen.getByLabelText('Search duplicates'), { target: { value: 'drop' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(screen.getByText('Drop Me')).toBeInTheDocument());

    // First click only reveals the confirmation — no POST yet.
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(screen.getByRole('button', { name: 'Confirm merge' })).toBeInTheDocument();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));

    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    const mergeCall = vi
      .mocked(apiFetch)
      .mock.calls.find((c) => String(c[0]).endsWith('/customers/survivor/merge'));
    expect(mergeCall).toBeDefined();
    expect(JSON.parse((mergeCall![1] as RequestInit).body as string)).toEqual({
      losingId: 'dupe',
    });
  });

  it('can cancel the confirmation without merging', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse([{ id: 'dupe', displayName: 'Drop Me' }]),
    );
    render(
      <MergeCustomerPanel survivingId="survivor" survivingName="Keep Me" onMerged={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Search duplicates'), { target: { value: 'drop' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(screen.getByText('Drop Me')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm merge' })).not.toBeInTheDocument();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1); // search only
  });
});
