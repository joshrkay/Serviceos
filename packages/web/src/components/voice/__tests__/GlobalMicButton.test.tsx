import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GlobalMicButton } from '../GlobalMicButton';

describe('P22-003 — GlobalMicButton', () => {
  it('renders a 56px touch-target FAB', () => {
    render(<GlobalMicButton onClick={vi.fn()} />);
    const button = screen.getByTestId('global-mic-button');
    expect(button.className).toContain('size-14');
    expect(button.className).toContain('min-h-11');
  });

  it('invokes onClick when tapped', () => {
    const onClick = vi.fn();
    render(<GlobalMicButton onClick={onClick} />);
    fireEvent.click(screen.getByTestId('global-mic-button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
