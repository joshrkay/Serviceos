import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AmbiguityPicker, AmbiguityCandidate } from './AmbiguityPicker';

const candidates: AmbiguityCandidate[] = [
  { id: 'item-1', name: '50-gal Water Heater', unitPriceCents: 120000, score: 0.74 },
  { id: 'item-2', name: '40-gal Water Heater', unitPriceCents: 95000, score: 0.71 },
];

function renderPicker(onResolve: AmbiguityPickerProps['onResolve']) {
  return render(
    <AmbiguityPicker
      lineIndex={0}
      description="water heater"
      candidates={candidates}
      onResolve={onResolve}
    />,
  );
}
type AmbiguityPickerProps = Parameters<typeof AmbiguityPicker>[0];

describe('P2-035 (U2) AmbiguityPicker', () => {
  it('renders one chip per candidate with its catalog price', () => {
    renderPicker(vi.fn().mockResolvedValue(undefined));
    expect(screen.getByTestId('ambiguity-candidate-item-1')).toHaveTextContent('50-gal Water Heater');
    expect(screen.getByTestId('ambiguity-candidate-item-1')).toHaveTextContent('$1,200.00');
    expect(screen.getByTestId('ambiguity-candidate-item-2')).toHaveTextContent('$950.00');
  });

  it('fires onResolve with the line index + chosen catalogItemId on pick', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderPicker(onResolve);
    fireEvent.click(screen.getByTestId('ambiguity-candidate-item-2'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(0, 'item-2'));
  });

  it('reverts (no stuck state, shows error) when the resolve fails', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    renderPicker(onResolve);
    fireEvent.click(screen.getByTestId('ambiguity-candidate-item-1'));

    // Error surfaces and the chips are interactive again (not disabled),
    // so the operator can retry — the optimistic pick was reverted.
    await waitFor(() => expect(screen.getByTestId('ambiguity-picker-error')).toBeInTheDocument());
    expect(screen.getByTestId('ambiguity-candidate-item-1')).not.toBeDisabled();
    expect(screen.getByTestId('ambiguity-candidate-item-2')).not.toBeDisabled();

    // A retry can fire again.
    fireEvent.click(screen.getByTestId('ambiguity-candidate-item-2'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
  });

  it('uses ≥44px (min-h-11) tap targets on the candidate chips', () => {
    renderPicker(vi.fn().mockResolvedValue(undefined));
    expect(screen.getByTestId('ambiguity-candidate-item-1').className).toContain('min-h-11');
    expect(screen.getByTestId('ambiguity-candidate-item-2').className).toContain('min-h-11');
  });
});
