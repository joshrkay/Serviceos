import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { VoiceConfigPanel } from './VoiceConfigPanel';

describe('VoiceConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes('/voice/presets')) {
        return {
          ok: true,
          json: async () => ({
            presets: [
              { id: 'rachel', label: 'Rachel', description: 'Warm' },
              { id: 'adam', label: 'Adam', description: 'Calm' },
              { id: 'bella', label: 'Bella', description: 'Upbeat' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ voiceId: 'adam', greeting: 'hi', assistantUpdated: false }) };
    });
  });

  it('loads presets and saves the selected voice via PUT /api/onboarding/voice', async () => {
    render(<VoiceConfigPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Adam/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Adam/ }));
    fireEvent.click(screen.getByRole('button', { name: /save voice/i }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/onboarding/voice',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const putCall = apiFetchMock.mock.calls.find((c) => c[0] === '/api/onboarding/voice');
    expect(JSON.parse(putCall![1].body as string)).toMatchObject({ voiceId: 'adam' });
  });
});
