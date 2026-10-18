import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { plumbingCleDraft, withDraft } from './__fixtures__';
import { ReadbackCard, type ReadbackCardProps } from './ReadbackCard';

function setup(props: Partial<ReadbackCardProps> = {}) {
  const onApprove = vi.fn();
  const onEdit = vi.fn();
  const utils = render(
    <ReadbackCard
      draft={plumbingCleDraft}
      approving={false}
      error={null}
      notice={null}
      onApprove={onApprove}
      onEdit={onEdit}
      {...props}
    />,
  );
  return { onApprove, onEdit, ...utils };
}

describe('ReadbackCard', () => {
  it('lists one row per core choice with what will be saved', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: "Here's what I've got. Tap anything to change it." })).toBeInTheDocument();
    const rows = screen.getAllByRole('button').filter((b) => b.closest('li'));
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent('Answering as');
    expect(rows[0]).toHaveTextContent('Walsh Plumbing, how can I help?');
    expect(screen.getByText('$89 to come out, $150 an hour after')).toBeInTheDocument();
    expect(screen.getByText('Typical for Cleveland plumbers. Most new owners start here and adjust after a few jobs.')).toBeInTheDocument();
    expect(screen.getByText('Answer and book, any hour')).toBeInTheDocument();
  });

  it('shows the owner’s pick or override in place of the default', () => {
    setup({
      draft: withDraft({
        choices: {
          booking_posture: { option: 'b' },
          greeting: { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } },
        },
      }),
    });
    expect(screen.getByText('Hold it for me')).toBeInTheDocument();
    expect(screen.getByText('Walsh, go ahead')).toBeInTheDocument();
    expect(screen.queryByText('Book it on the call')).not.toBeInTheDocument();
  });

  it('calls onEdit with the choice key when a row is tapped', async () => {
    const { onEdit } = setup();
    await userEvent.click(screen.getByRole('button', { name: /Booking.*Book it on the call/ }));
    expect(onEdit).toHaveBeenCalledWith('booking_posture');
    await userEvent.click(screen.getByRole('button', { name: /Prices/ }));
    expect(onEdit).toHaveBeenLastCalledWith('trip_fee_and_rate');
  });

  it('renders plain rows, and does not promise a tap, when nothing handles edits yet', () => {
    setup({ onEdit: undefined });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("Here's what I've got.");
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('Tap anything');
    const list = screen.getByRole('list');
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
  });

  it('saves only when the owner taps "That\'s right", and says so', async () => {
    const { onApprove } = setup();
    expect(screen.getByText("Nothing's saved until you say so.")).toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: "That's right" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('disables the button while saving, and shows a one-line error or notice', () => {
    setup({ approving: true, error: "That didn't go through. Try again.", notice: 'I refreshed your answers.' });
    expect(screen.getByRole('button', { name: /That's right/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
    expect(screen.getByText('I refreshed your answers.')).toHaveAttribute('role', 'status');
  });
});
