import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceRoiCard } from './VoiceRoiCard';

const mockApiFetch = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => mockApiFetch,
}));

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}));

function resolveWith(data: Record<string, unknown>) {
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ data }) });
}

const FULL = {
  windowStart: '2026-05-22T00:00:00.000Z',
  windowEnd: '2026-06-21T00:00:00.000Z',
  inboundCalls: 20,
  answeredCalls: 18,
  bookedByAgent: 6,
  afterHoursCaptures: 5,
  wouldHaveHitVoicemail: 9,
  answerRate: 0.9,
};

describe('VoiceRoiCard', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockNavigate.mockReset();
  });

  it('renders the would-have-hit-voicemail headline and the breakdown tiles', async () => {
    resolveWith(FULL);

    render(<VoiceRoiCard />);

    const headline = await screen.findByTestId('voice-roi-headline');
    expect(headline).toHaveTextContent('9');
    // Mobile class-contract: the headline wraps rather than overflowing 320px.
    expect(headline.className).toContain('break-words');
    expect(headline.className).toContain('tabular-nums');

    expect(screen.getByText(/5 after hours/i)).toBeInTheDocument();
    expect(screen.getByText('Inbound calls')).toBeInTheDocument();
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByText('Booked by agent')).toBeInTheDocument();
    expect(screen.getByText(/90% answer rate/)).toBeInTheDocument();
  });

  it('deep-links to the call log with a 44px tap target', async () => {
    resolveWith(FULL);

    render(<VoiceRoiCard />);

    const link = await screen.findByRole('button', { name: /view call log/i });
    // Mobile tap-target contract: ≥44px (min-h-11).
    expect(link.className).toContain('min-h-11');
    link.click();
    expect(mockNavigate).toHaveBeenCalledWith('/interactions');
  });

  it('shows the onboarding payoff (no zeros) until the first inbound call', async () => {
    resolveWith({ ...FULL, inboundCalls: 0, answeredCalls: 0, bookedByAgent: 0, afterHoursCaptures: 0, wouldHaveHitVoicemail: 0 });

    render(<VoiceRoiCard />);

    await screen.findByTestId('voice-roi');
    expect(screen.getByText(/will show up here/i)).toBeInTheDocument();
    expect(screen.queryByTestId('voice-roi-headline')).not.toBeInTheDocument();
  });

  it('renders nothing on error (never flashes a broken band)', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 503 });

    const { container } = render(<VoiceRoiCard />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('voice-roi')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
