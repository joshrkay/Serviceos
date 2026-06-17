import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AmbiguityPicker, type AmbiguityCandidate } from './AmbiguityPicker';

const candidates: AmbiguityCandidate[] = [
  { id: 'cat-a', name: 'Flush valve (standard)', unitPriceCents: 4500, score: 0.7 },
  { id: 'cat-b', name: 'Flush valve (premium)', unitPriceCents: 8200, score: 0.6 },
];

describe('AmbiguityPicker (U2)', () => {
  it('renders each candidate as a one-tap chip with its formatted price', () => {
    render(
      <AmbiguityPicker lineDescription="flush valve" candidates={candidates} onPick={vi.fn()} />,
    );
    expect(screen.getByText(/Which item for/)).toHaveTextContent('flush valve');
    const options = screen.getAllByTestId('ambiguity-option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Flush valve (standard)');
    expect(options[0]).toHaveTextContent('$45.00');
    expect(options[1]).toHaveTextContent('$82.00');
  });

  it('class contract — each option is a ≥44px tap target that cannot overflow at 320px', () => {
    render(
      <AmbiguityPicker lineDescription="flush valve" candidates={candidates} onPick={vi.fn()} />,
    );
    for (const option of screen.getAllByTestId('ambiguity-option')) {
      // 44px minimum height (min-h-11) is the mobile tap-target floor.
      expect(option.className).toContain('min-h-11');
      // w-full + a truncating label keep the row inside a 320px viewport.
      expect(option.className).toContain('w-full');
    }
    expect(screen.getByText('Flush valve (standard)').className).toContain('truncate');
  });

  it('invokes onPick with the chosen catalog item id', async () => {
    const onPick = vi.fn().mockResolvedValue(undefined);
    render(
      <AmbiguityPicker lineDescription="flush valve" candidates={candidates} onPick={onPick} />,
    );
    fireEvent.click(screen.getByText('Flush valve (premium)'));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('cat-b'));
  });

  it('disables every option while a pick is in flight, then re-enables on failure', async () => {
    let reject!: (e: Error) => void;
    const onPick = vi.fn().mockReturnValue(new Promise((_res, rej) => { reject = rej; }));
    render(
      <AmbiguityPicker lineDescription="flush valve" candidates={candidates} onPick={onPick} />,
    );
    fireEvent.click(screen.getByText('Flush valve (standard)'));
    await waitFor(() => {
      for (const o of screen.getAllByTestId('ambiguity-option')) {
        expect(o).toBeDisabled();
      }
    });
    reject(new Error('boom'));
    await waitFor(() => {
      for (const o of screen.getAllByTestId('ambiguity-option')) {
        expect(o).not.toBeDisabled();
      }
    });
  });
});
