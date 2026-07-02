/**
 * U7 — VoiceBar "you can say…" idle hint: rotation with fade, tap starts
 * listening (hint lives inside the single ≥44px idle button), and
 * prefers-reduced-motion renders one static example with no rotation.
 */
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceBar } from './VoiceBar';

// Deterministic example set — the component draws via pickExamples on mount.
vi.mock('./voice-examples', () => ({
  pickExamples: () => [
    { intent: 'create_invoice', example: 'Invoice the Martins for the water heater' },
    { intent: 'respond_to_review', example: 'Respond to that 1-star review' },
    { intent: 'reassign_appointment', example: 'Assign Carlos to the 2pm' },
  ],
}));

// useTTS touches speechSynthesis, which jsdom doesn't provide.
vi.mock('../../hooks/useTTS', () => ({
  useTTS: () => ({ speak: vi.fn(), stop: vi.fn() }),
}));

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

function renderBar(variant: 'mobile' | 'desktop' = 'mobile') {
  return render(
    <MemoryRouter>
      <VoiceBar variant={variant} />
    </MemoryRouter>,
  );
}

describe('VoiceBar idle "Try:" hint (U7)', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders a rotating example inside the idle button on both variants', () => {
    for (const variant of ['mobile', 'desktop'] as const) {
      const { unmount } = renderBar(variant);
      const hint = screen.getByTestId('voice-example-hint');
      expect(hint.textContent).toContain('Invoice the Martins for the water heater');
      // The hint is INSIDE the single idle tap target.
      expect(hint.closest('button')).not.toBeNull();
      unmount();
    }
  });

  it('keeps ONE ≥44px tap target — the idle button carries min-h-11', () => {
    renderBar();
    const button = screen.getByTestId('voice-example-hint').closest('button')!;
    expect(button.className).toContain('min-h-11');
    // The hint is not its own interactive element.
    expect(screen.getByTestId('voice-example-hint').tagName).toBe('SPAN');
  });

  it('rotates to the next example after ~5s with a fade', () => {
    vi.useFakeTimers();
    renderBar();
    expect(screen.getByTestId('voice-example-hint').textContent).toContain(
      'Invoice the Martins',
    );

    // Rotation tick: fade out…
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('voice-example-hint').className).toContain('opacity-0');
    // …then swap + fade back in.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const hint = screen.getByTestId('voice-example-hint');
    expect(hint.textContent).toContain('Respond to that 1-star review');
    expect(hint.className).toContain('opacity-100');
  });

  it('tapping the hint starts listening', async () => {
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    expect(await screen.findByText('Listening…')).toBeTruthy();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('prefers-reduced-motion → static single example, no rotation', () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    renderBar();
    const before = screen.getByTestId('voice-example-hint').textContent;
    act(() => {
      vi.advanceTimersByTime(16000);
    });
    const after = screen.getByTestId('voice-example-hint');
    expect(after.textContent).toBe(before);
    expect(after.className).toContain('opacity-100');
  });
});
