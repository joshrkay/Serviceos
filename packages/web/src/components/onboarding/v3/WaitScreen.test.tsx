import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { WaitScreen } from './WaitScreen';
import { NUMBER_WAIT } from './wait-copy';

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('WaitScreen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens with Rivet\'s line and nothing about the clock', () => {
    render(<WaitScreen heading="Getting your shop ready." support="This takes a few seconds." onRetry={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Getting your shop ready.' })).toBeInTheDocument();
    expect(screen.getByText('This takes a few seconds.')).toBeInTheDocument();
    expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
    expect(screen.queryByText('This is taking longer than usual.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('adds "Still with you." after four seconds, and not a moment before', () => {
    render(<WaitScreen heading="Getting your shop ready." onRetry={vi.fn()} />);
    advance(3_999);
    expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
    advance(1);
    expect(screen.getByRole('status')).toHaveTextContent('Still with you.');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('admits it is slow after twenty seconds, replacing the earlier line, with a Try again that is a 44px target', () => {
    const onRetry = vi.fn();
    const { container } = render(<WaitScreen heading="Getting your shop ready." onRetry={onRetry} />);
    advance(19_999);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    advance(1);
    expect(screen.getByRole('status')).toHaveTextContent('This is taking longer than usual.');
    expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });
    expectAllTapTargets(container, 'wait screen');

    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('adds its slow note and way out only once it is clearly slow', () => {
    render(
      <WaitScreen
        heading="Getting your shop ready."
        onRetry={vi.fn()}
        slowNote="Some of your choices may not have saved."
        slowAction={<button type="button">Go through setup step by step</button>}
      />,
    );
    advance(19_999);
    expect(screen.queryByText('Some of your choices may not have saved.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go through setup step by step' })).not.toBeInTheDocument();
    advance(1);
    expect(screen.getByText('Some of your choices may not have saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go through setup step by step' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('offers no retry when there is nothing to retry, however long it takes', () => {
    render(<WaitScreen heading="Getting your number." />);
    advance(60_000);
    expect(screen.getByText('This is taking longer than usual.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('takes its own thresholds: a number is not slow until thirty seconds', () => {
    render(<WaitScreen heading="Getting your number." thresholds={NUMBER_WAIT} onRetry={vi.fn()} />);
    advance(25_000);
    expect(screen.getByText('Still with you.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    advance(5_000);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows why a retry did not work, and the extra controls its caller adds', () => {
    render(
      <WaitScreen heading="Getting my voice ready." onRetry={vi.fn()} retryError="That didn't go through. Try again.">
        <button type="button">Skip for now</button>
      </WaitScreen>,
    );
    advance(20_000);
    expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
  });

  it('disables Try again while it is working', () => {
    render(<WaitScreen heading="Getting your shop ready." onRetry={vi.fn()} retrying />);
    advance(20_000);
    // The button names itself "Loading Try again" while it works.
    expect(screen.getByRole('button', { name: /Try again/ })).toBeDisabled();
  });
});
