import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerticalPacksSheet } from './VerticalPacksSheet';
import { apiFetch } from '../../utils/api-fetch';
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const fetchMock = vi.mocked(apiFetch);
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
describe('canonical vertical pack IDs', () => {
  it.each(['hvac-v1', 'plumbing-v1'])('recognizes and deactivates %s returned by the API', async (packId) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ packId, status: 'active' }])));
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    render(<VerticalPacksSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/settings/packs/${packId}`, { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument());
  });
  it.each([{ index: 0, id: 'hvac-v1' }, { index: 1, id: 'plumbing-v1' }])('activates $id using the registry identifier', async ({ index, id }) => {
    fetchMock.mockResolvedValueOnce(new Response('[]'));
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    render(<VerticalPacksSheet onClose={() => {}} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Activate' }))[index]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/settings/packs/${id}/activate`, { method: 'PUT' }));
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });
});
