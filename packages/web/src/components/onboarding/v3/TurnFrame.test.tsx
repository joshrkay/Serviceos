import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TurnFrame } from './TurnFrame';

describe('TurnFrame header', () => {
  it('shows the minutes and the status label, and no escape hatch, by default', () => {
    render(<TurnFrame minutesLeft={6} progress={0.15} statusLabel="Nothing saved yet">{null}</TurnFrame>);
    expect(screen.getByText('About 6 minutes left')).toBeInTheDocument();
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('puts the escape hatch in the header next to the minutes, without losing the status label', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TurnFrame minutesLeft={5} progress={0.2} statusLabel="Nothing saved yet" escape={{ label: 'Keep the rest as is', onSelect }}>
        {null}
      </TurnFrame>,
    );
    const header = container.querySelector('header')!;
    expect(header).toContainElement(screen.getByText('About 5 minutes left'));
    expect(header).toContainElement(screen.getByText('Nothing saved yet'));
    const escape = screen.getByRole('button', { name: 'Keep the rest as is' });
    expect(header).toContainElement(escape);
    await userEvent.click(escape);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('works without a status label', () => {
    render(<TurnFrame minutesLeft={1} progress={0.5} escape={{ label: 'Back', onSelect: vi.fn() }}>{null}</TurnFrame>);
    expect(screen.getByText('About 1 minute left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });
});
