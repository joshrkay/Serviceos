/**
 * #1386 / O-2 — the owner's persistent warning while AI answering runs on the
 * UNREVIEWED placeholder E1 life-safety script. Reads GET /api/settings/e1-script.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => (...args: unknown[]) => apiFetchMock(...args),
}));

import { E1ScriptPlaceholderBanner } from './E1ScriptPlaceholderBanner';

function status(body: Record<string, unknown>, ok = true, code = 200) {
  return { ok, status: code, json: async () => body } as unknown as Response;
}

const renderBanner = () =>
  render(
    <MemoryRouter>
      <E1ScriptPlaceholderBanner />
    </MemoryRouter>,
  );

describe('E1ScriptPlaceholderBanner', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('warns the owner while the placeholder E1 script is live', async () => {
    apiFetchMock.mockResolvedValue(status({ status: 'placeholder', reviewedScript: null }));
    renderBanner();
    expect(
      await screen.findByText(
        'Emergency (E1) calls use a placeholder safety script that no licensed professional or counsel has reviewed yet.',
      ),
    ).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/settings/e1-script');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('stays hidden once a reviewed script is saved', async () => {
    apiFetchMock.mockResolvedValue(status({ status: 'reviewed', reviewedScript: 'Reviewed.' }));
    const { container } = renderBanner();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden when the status cannot be read', async () => {
    apiFetchMock.mockResolvedValue(status({}, false, 403));
    const { container } = renderBanner();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
