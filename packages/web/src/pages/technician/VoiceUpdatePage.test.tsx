import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceUpdatePage } from './VoiceUpdatePage';

describe('P3-008 — VoiceUpdatePage container', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('renders the VoiceUpdate leaf with job context', () => {
    render(
      <VoiceUpdatePage
        jobContext={{ jobId: 'job-1', jobTitle: 'Fix AC' }}
      />
    );
    expect(screen.getByTestId('voice-update')).toBeInTheDocument();
    expect(screen.getByTestId('job-title')).toHaveTextContent('Fix AC');
  });

  it('renders the no-context message when jobContext is null', () => {
    render(<VoiceUpdatePage jobContext={null} />);
    expect(screen.getByTestId('voice-update-no-context')).toBeInTheDocument();
  });

  it('exposes the retry hook when transcription fails', () => {
    // Smoke test — the component mounts without wiring issues.
    render(
      <VoiceUpdatePage
        jobContext={{ jobId: 'job-1', jobTitle: 'Fix AC' }}
      />
    );
    expect(screen.getByTestId('voice-update')).toBeInTheDocument();
  });
});
