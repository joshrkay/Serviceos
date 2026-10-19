import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { RivetVoiceContext, useRivetVoice } from '../../../hooks/useRivetVoice';
import { ONBOARDING_METROS } from '@ai-service-os/shared';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { plumbingCleDraft, withDraft } from './__fixtures__';
import { ReadyScreen, type ReadyScreenProps } from './ReadyScreen';

function setup(draft = plumbingCleDraft, over: Partial<ReadyScreenProps> = {}) {
  const onMakeItMine = vi.fn();
  const onKeepAsIs = vi.fn();
  const onChangeMetro = vi.fn();
  const view = render(
    <ReadyScreen draft={draft} onMakeItMine={onMakeItMine} onKeepAsIs={onKeepAsIs} onChangeMetro={onChangeMetro} changingMetro={false} notice={null} error={null} {...over} />,
  );
  return { onMakeItMine, onKeepAsIs, onChangeMetro, container: view.container };
}

/** A browser that can listen: a microphone, a recorder and a socket exist. */
function withMicrophone() {
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal('MediaRecorder', class {});
  vi.stubGlobal('WebSocket', class {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 501 })));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ReadyScreen', () => {
  it('says the shop is already set up, in Rivet’s first person', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    expect(
      screen.getByText(/I built it the way most Cleveland plumbing shops run\. Seven quick choices make it yours\. Nothing to type\./),
    ).toBeInTheDocument();
  });

  it('in the shell, on a browser that can listen, says the owner can tap or say "first" or "second"', () => {
    withMicrophone();
    setup(plumbingCleDraft, { inShell: true });
    expect(
      screen.getByText('Each choice is two options. Tap the one that sounds right, or say "first" or "second". Nothing is saved until you say so.'),
    ).toBeInTheDocument();
  });

  it('promises only the tap where nothing can listen: outside the shell, or a browser with no microphone', () => {
    setup();
    expect(screen.getByText('Each choice is two options. Tap the one that sounds right. Nothing is saved until you say so.')).toBeInTheDocument();
    expect(screen.queryByText(/say .?first|say .?second|say .?neither/i)).not.toBeInTheDocument();
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

  describe('"Not Cleveland?"', () => {
    it('names the city it priced for and offers to change it, in plain words', async () => {
      const { onChangeMetro, container } = setup();
      const change = screen.getByRole('button', { name: 'Not Cleveland?' });
      expectAllTapTargets(container, 'Ready');
      await userEvent.click(change);

      // The list of cities Rivet has prices for, searchable, with the current one left out.
      const search = screen.getByRole('searchbox', { name: 'Your city' });
      const cities = screen.getByRole('list', { name: 'Cities' });
      const names = within(cities).getAllByRole('button').map((b) => b.textContent);
      expect(names).toHaveLength(ONBOARDING_METROS.length - 1);
      expect(names).not.toContain('Cleveland');
      expect(names).toContain('Columbus');
      expectAllTapTargets(container, 'Ready with the city list open');

      await userEvent.type(search, 'colu');
      expect(within(cities).getAllByRole('button').map((b) => b.textContent)).toEqual(['Columbus']);
      await userEvent.click(within(cities).getByRole('button', { name: 'Columbus' }));
      expect(onChangeMetro).toHaveBeenCalledTimes(1);
      expect(onChangeMetro).toHaveBeenCalledWith('CMH');
      // Picked: the list closes.
      expect(screen.queryByRole('searchbox', { name: 'Your city' })).not.toBeInTheDocument();
    });

    it('says so when no city matches, and the owner can close the list unchanged', async () => {
      const { onChangeMetro } = setup();
      await userEvent.click(screen.getByRole('button', { name: 'Not Cleveland?' }));
      await userEvent.type(screen.getByRole('searchbox', { name: 'Your city' }), 'Reykjavik');
      expect(screen.getByText("I don't have prices for that city yet. Pick the closest one.")).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Cities' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Keep Cleveland' }));
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Not Cleveland?' })).toBeInTheDocument();
      expect(onChangeMetro).not.toHaveBeenCalled();
    });

    it('reads "Set my city" when the prices are not a city\'s (and closes as "Never mind")', async () => {
      setup(withDraft({ assembled: { ...plumbingCleDraft.assembled, showsCity: false, priceSource: 'national' } }));
      expect(screen.queryByRole('button', { name: /^Not / })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Set my city' }));
      expect(screen.getByRole('searchbox', { name: 'Your city' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Never mind' }));
      expect(screen.getByRole('button', { name: 'Set my city' })).toBeInTheDocument();
    });

    it.each([
      ['a core choice', { greeting: { option: 'b' as const } }],
      ['an override', { trip_fee_and_rate: { override: { label: '$95, then $140 an hour', writes: {}, prices: { tripFeeCents: 9500, hourlyRateCents: 14000 } } } }],
      ['the established-shop question', { existing_number: { option: 'a' as const } }],
    ])('is not offered once anything is staged (%s): the server refuses it then', (_n, choices) => {
      setup(withDraft({ choices }));
      expect(screen.queryByRole('button', { name: /Not Cleveland|Set my city/ })).not.toBeInTheDocument();
    });

    it('while the change is saving, every control waits', async () => {
      setup(plumbingCleDraft, { changingMetro: true });
      for (const name of ['Not Cleveland?', 'Make it mine, 7 choices', 'Looks right as is, skip the choices']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
    });

    it('shows the refresh notice and a save problem as one line each', () => {
      setup(plumbingCleDraft, { notice: 'Your answers changed somewhere else, so I refreshed them.', error: "That didn't go through. Try again." });
      expect(screen.getByRole('status')).toHaveTextContent('Your answers changed somewhere else, so I refreshed them.');
      expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
    });
  });
});
