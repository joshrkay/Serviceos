import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { BlockedTextsNotice } from './BlockedTextsNotice';
import { expectTapTarget } from '../../test-utils/tap-target';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../utils/api-fetch';
const mockApiFetch = vi.mocked(apiFetch);

function response(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function renderNotice() {
  return render(
    <MemoryRouter>
      <BlockedTextsNotice />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('BlockedTextsNotice', () => {
  it('counts blocked texts and links to the list of them', async () => {
    mockApiFetch.mockResolvedValue(response(200, { dispatches: [{}], total: 3 }));
    renderNotice();
    const notice = await screen.findByTestId('blocked-texts-notice');
    expect(notice).toHaveTextContent("3 customer texts didn't go out. See why");
    expect(notice.getAttribute('href')).toBe('/interactions/dispatch?status=blocked');
    expect(String(mockApiFetch.mock.calls[0][0])).toBe('/api/interactions/dispatches?status=blocked&limit=1');
    expectTapTarget(notice, 'blocked texts notice');
  });

  it('uses the singular for one text', async () => {
    mockApiFetch.mockResolvedValue(response(200, { dispatches: [{}], total: 1 }));
    renderNotice();
    expect(await screen.findByTestId('blocked-texts-notice')).toHaveTextContent("1 customer text didn't go out.");
  });

  it('shows nothing when every text went out, or to a viewer without access', async () => {
    mockApiFetch.mockResolvedValueOnce(response(200, { dispatches: [], total: 0 }));
    const first = renderNotice();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    expect(first.container).toBeEmptyDOMElement();

    mockApiFetch.mockResolvedValueOnce(response(403));
    const second = renderNotice();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('says it could not check rather than implying nothing is blocked', async () => {
    mockApiFetch.mockRejectedValue(new Error('network'));
    renderNotice();
    expect(await screen.findByTestId('blocked-texts-error')).toBeInTheDocument();
  });
});
