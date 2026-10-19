import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { RivetVoiceContext, useRivetVoice } from '../../../hooks/useRivetVoice';
import { plumbingCleDraft, withDraft } from './__fixtures__';
import { ReadyScreen } from './ReadyScreen';

vi.mock('../../../lib/analytics', () => ({ trackFunnel: vi.fn(), track: vi.fn() }));

/** The shell's real voice; jsdom has no microphone unless a test gives it one. */
function Shell({ children }: { children: ReactNode }) {
  const voice = useRivetVoice({ funnel: { tenantId: 't', userId: 'u' } });
  return <RivetVoiceContext.Provider value={voice}>{children}</RivetVoiceContext.Provider>;
}

function setup(draft = plumbingCleDraft, opts: { inShell?: boolean } = {}) {
  const onMakeItMine = vi.fn();
  const onKeepAsIs = vi.fn();
  const screenEl = <ReadyScreen draft={draft} onMakeItMine={onMakeItMine} onKeepAsIs={onKeepAsIs} />;
  render(opts.inShell ? <Shell>{screenEl}</Shell> : screenEl);
  return { onMakeItMine, onKeepAsIs };
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
});
