/**
 * IdentityStep — business-hours helper copy (#1595 / D-039).
 *
 * AI answering is the after-hours default, so the onboarding copy must not
 * tell a new owner that off-hours calls go to voicemail.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { IdentityStep } from './IdentityStep';

describe('IdentityStep — after-hours copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({}) }));
  });

  it('says the AI still answers after hours and never mentions voicemail', async () => {
    render(<IdentityStep onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText('M&R Mechanical')).toBeInTheDocument());

    expect(screen.getByText(/after hours the AI still answers/i)).toBeInTheDocument();
    expect(screen.queryByText(/voicemail/i)).not.toBeInTheDocument();
  });
});
