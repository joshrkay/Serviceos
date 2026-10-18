import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { plumbingCleDraft, withDraft } from './__fixtures__';
import { ReadyScreen } from './ReadyScreen';

function setup(draft = plumbingCleDraft) {
  const onMakeItMine = vi.fn();
  const onKeepAsIs = vi.fn();
  render(<ReadyScreen draft={draft} onMakeItMine={onMakeItMine} onKeepAsIs={onKeepAsIs} />);
  return { onMakeItMine, onKeepAsIs };
}

describe('ReadyScreen', () => {
  it('says the shop is already set up, in Rivet’s first person', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    expect(
      screen.getByText(/I built it the way most Cleveland plumbing shops run\. Seven quick choices make it yours\. Nothing to type\./),
    ).toBeInTheDocument();
  });

  it('shows the finished shop from the assembled draft, with Most shops marks', () => {
    setup();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('span')?.textContent)).toEqual([
      'Answering as',
      'To come out',
      'Booking',
      'Getting paid',
      'Emergencies',
    ]);
    expect(screen.getByText('“Walsh Plumbing, how can I help?”')).toBeInTheDocument();
    expect(screen.getByText('$89, then $150 an hour')).toBeInTheDocument();
    expect(screen.getByText('Monday to Saturday, 7 to 5. Book it on the call.')).toBeInTheDocument();
    expect(screen.getByText('Text them a pay link')).toBeInTheDocument();
    expect(screen.getByText('Your cell, every time')).toBeInTheDocument();
    const price = rows[1];
    expect(within(price).getByText('Most shops')).toBeInTheDocument();
  });

  it('drops the city and the Most shops mark when the row is not the typical answer', () => {
    setup(
      withDraft({
        assembled: { ...plumbingCleDraft.assembled, showsCity: false, priceSource: 'national' },
        choices: { payment_collection_mode: { option: 'b' } },
      }),
    );
    expect(screen.getByText(/the way most plumbing shops run/)).toBeInTheDocument();
    const paid = screen.getByText('Collect on the spot').closest('li') as HTMLElement;
    expect(within(paid).queryByText('Most shops')).not.toBeInTheDocument();
  });

  it('offers the two ways forward as buttons', async () => {
    const { onMakeItMine, onKeepAsIs } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Make it mine, 7 choices' }));
    expect(onMakeItMine).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Looks right as is, skip the choices' }));
    expect(onKeepAsIs).toHaveBeenCalledTimes(1);
  });
});
