import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { narrateTurn, type AssembledOnboardingChoice, type OnboardingCoreChoiceKey, type StagedOnboardingChoice } from '@ai-service-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { expectAllTapTargets, expectTapTarget } from '../../../test-utils/tap-target';
import { RivetVoiceContext, useRivetVoice } from '../../../hooks/useRivetVoice';
import { plumbingCleDraft } from './__fixtures__';
import { OptionPairTurn, type OptionPairTurnProps } from './OptionPairTurn';

vi.mock('../../../lib/analytics', () => ({ trackFunnel: vi.fn(), track: vi.fn() }));

function choiceFor(key: OnboardingCoreChoiceKey): AssembledOnboardingChoice {
  const choice = plumbingCleDraft.assembled.choices.find((c) => c.settingKey === key);
  if (!choice) throw new Error(`fixture has no ${key}`);
  return choice;
}

function setup(key: OnboardingCoreChoiceKey, props: Partial<OptionPairTurnProps> = {}) {
  const onPick = vi.fn();
  const onTypeInstead = vi.fn();
  const utils = render(
    <OptionPairTurn
      choice={choiceFor(key)}
      busy={false}
      error={null}
      notice={null}
      editing={false}
      onPick={onPick}
      onTypeInstead={onTypeInstead}
      {...props}
    />,
  );
  return { onPick, onTypeInstead, ...utils };
}

const next = () => screen.getByRole('button', { name: 'Next' });

describe('OptionPairTurn', () => {
  describe('the pair', () => {
    it("asks Rivet's question as the one heading, with the support line under it", () => {
      setup('booking_posture', { onTypeInstead: undefined });
      expect(screen.getByRole('heading', { level: 1, name: 'When someone wants a repair, do I book it or hold it for you?' })).toBeInTheDocument();
      expect(screen.getByText('Emergencies skip this. Those always come straight to you.')).toBeInTheDocument();
      expect(screen.getAllByRole('heading')).toHaveLength(1);
      expect(screen.getByText('Rivet')).toBeInTheDocument();
    });

    it('shows both options with what Rivet would say, and the Most-shops mark on the typical one only', () => {
      setup('booking_posture', { onTypeInstead: undefined });
      const group = screen.getByRole('radiogroup', { name: 'When someone wants a repair, do I book it or hold it for you?' });
      const [book, hold] = within(group).getAllByRole('radio');
      expect(book).toHaveAccessibleName('Book it on the call');
      expect(book).toHaveTextContent('Rivet would say: “I have Tuesday at 2 or Wednesday at 9. Which works for you?”');
      expect(book).toHaveTextContent('Most shops like yours');
      expect(book).toHaveAccessibleDescription(/^Most shops like yours/);
      expect(hold).toHaveAccessibleName('Hold it for me');
      expect(hold).not.toHaveAccessibleDescription(/Most shops like yours/);
      expect(hold).toHaveTextContent('Jenna will confirm a time with you within the hour.');
      expect(hold).not.toHaveTextContent('Most shops like yours');
    });

    it('does not say the same sentence twice when an option\'s label is what Rivet says', () => {
      const choice = choiceFor('greeting');
      setup('greeting', { choice: { ...choice, options: choice.options.map((o) => ({ ...o, rivetLine: o.label })) as typeof choice.options } });
      expect(screen.queryByText(/Rivet would say/)).not.toBeInTheDocument();
      expect(screen.getAllByText(choice.options[0].label)).toHaveLength(1);
    });

    it('moves focus to the new question when the turn opens, and to the typed field when it opens on typed words', () => {
      const { unmount } = setup('booking_posture', { onTypeInstead: undefined });
      expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
      unmount();
      const typed: StagedOnboardingChoice = { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } };
      setup('greeting', { staged: typed, editing: true });
      expect(screen.getByRole('textbox', { name: 'Your greeting' })).toHaveFocus();
    });

    it('puts the mark on whichever option the draft says most shops pick', () => {
      const flipped: AssembledOnboardingChoice = { ...choiceFor('booking_posture'), mostShops: 'b' };
      setup('booking_posture', { choice: flipped, onTypeInstead: undefined });
      const [book, hold] = screen.getAllByRole('radio');
      expect(book).not.toHaveTextContent('Most shops like yours');
      expect(hold).toHaveTextContent('Most shops like yours');
    });

    it('shows no heading text of its own: every word comes from the draft', () => {
      const choice: AssembledOnboardingChoice = { ...choiceFor('booking_posture'), question: 'Which one?', supportLine: undefined };
      setup('booking_posture', { choice, onTypeInstead: undefined });
      expect(screen.getByRole('heading', { level: 1, name: 'Which one?' })).toBeInTheDocument();
      expect(screen.queryByText(/Emergencies skip this/)).not.toBeInTheDocument();
    });

    it("says nothing's saved until the owner does", () => {
      setup('booking_posture', { onTypeInstead: undefined });
      expect(screen.getByText("Nothing's saved until you say so.")).toBeInTheDocument();
    });
  });

  describe('picking', () => {
    it('keeps Next disabled until an option is selected', async () => {
      setup('booking_posture', { onTypeInstead: undefined });
      expect(next()).toBeDisabled();
      await userEvent.click(screen.getByRole('radio', { name: 'Hold it for me' }));
      expect(next()).toBeEnabled();
    });

    it('selecting a card does not answer; Next does, once', async () => {
      const { onPick } = setup('booking_posture', { onTypeInstead: undefined });
      await userEvent.click(screen.getByRole('radio', { name: 'Hold it for me' }));
      expect(onPick).not.toHaveBeenCalled();
      await userEvent.click(next());
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenCalledWith('b');
    });

    it('lets a mis-tap be corrected before Next', async () => {
      const { onPick } = setup('booking_posture', { onTypeInstead: undefined });
      await userEvent.click(screen.getByRole('radio', { name: 'Hold it for me' }));
      await userEvent.click(screen.getByRole('radio', { name: 'Book it on the call' }));
      await userEvent.click(next());
      expect(onPick).toHaveBeenCalledWith('a');
    });

    it('opens with the staged option already selected (resume and edit)', async () => {
      const staged: StagedOnboardingChoice = { option: 'b' };
      const { onPick } = setup('booking_posture', { staged, onTypeInstead: undefined });
      expect(screen.getByRole('radio', { name: 'Hold it for me' })).toHaveAttribute('aria-checked', 'true');
      expect(next()).toBeEnabled();
      await userEvent.click(next());
      expect(onPick).toHaveBeenCalledWith('b');
    });

    it('reads "Save" instead of "Next" when opened from the read-back', () => {
      setup('booking_posture', { staged: { option: 'a' }, editing: true, onTypeInstead: undefined });
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    });

    it('disables the cards and Next while an answer is being saved', () => {
      setup('booking_posture', { staged: { option: 'a' }, busy: true, onTypeInstead: undefined });
      expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
      for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    });

    it('says why nothing moved: a one-line error or a refreshed-answers notice', () => {
      setup('booking_posture', {
        staged: { option: 'a' },
        error: "That didn't go through. Try again.",
        notice: 'Your answers changed somewhere else, so I refreshed them. Tap again.',
        onTypeInstead: undefined,
      });
      expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
      expect(screen.getByRole('status')).toHaveTextContent('Your answers changed somewhere else, so I refreshed them. Tap again.');
    });

    it('renders no alert or status line when there is nothing to say', () => {
      setup('booking_posture', { onTypeInstead: undefined });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  describe('Type instead', () => {
    it('is not on screen for a turn that cannot be typed', () => {
      setup('booking_posture', { onTypeInstead: undefined });
      expect(screen.queryByRole('button', { name: /Type instead/ })).not.toBeInTheDocument();
    });

    it('is not on screen for a turn that cannot be typed even if a handler is passed', () => {
      setup('booking_posture');
      expect(screen.queryByRole('button', { name: /Type instead/ })).not.toBeInTheDocument();
    });

    it('is on screen for the greeting and the price when a handler is given', () => {
      const { unmount } = setup('greeting');
      expect(screen.getByRole('button', { name: 'Type instead' })).toBeInTheDocument();
      unmount();
      setup('trip_fee_and_rate');
      expect(screen.getByRole('button', { name: 'Type instead' })).toBeInTheDocument();
    });

    it('puts Type instead on the left of the answer bar and Next on the right', () => {
      setup('greeting');
      const buttons = screen.getAllByRole('button').filter((b) => b.getAttribute('role') !== 'radio');
      expect(buttons.map((b) => b.textContent)).toEqual(['Type instead', 'Next']);
    });

    describe('the greeting', () => {
      it('swaps the cards for one text field, and back', async () => {
        setup('greeting');
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
        const field = screen.getByRole('textbox', { name: 'Your greeting' });
        expect(field).toHaveAttribute('maxlength', '120');
        expect(field.className).toMatch(/min-h-11/);
        await userEvent.click(screen.getByRole('button', { name: 'Pick instead' }));
        expect(screen.getByRole('radiogroup')).toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      });

      it("emits an override whose label and voice greeting are the owner's words", async () => {
        const { onTypeInstead, onPick } = setup('greeting');
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Your greeting' }), '  Walsh Plumbing, go ahead  ');
        await userEvent.click(next());
        expect(onTypeInstead).toHaveBeenCalledTimes(1);
        expect(onTypeInstead).toHaveBeenCalledWith({
          label: 'Walsh Plumbing, go ahead',
          writes: { voiceGreeting: 'Walsh Plumbing, go ahead' },
        });
        expect(onPick).not.toHaveBeenCalled();
      });

      it('submits with the Enter key too', async () => {
        const { onTypeInstead } = setup('greeting');
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Your greeting' }), 'Walsh here{Enter}');
        expect(onTypeInstead).toHaveBeenCalledWith({ label: 'Walsh here', writes: { voiceGreeting: 'Walsh here' } });
      });

      it('says so inline, and sends nothing, when the field is empty or blank', async () => {
        const { onTypeInstead } = setup('greeting');
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        await userEvent.click(next());
        expect(screen.getByRole('alert')).toHaveTextContent('Type what you want me to say.');
        await userEvent.type(screen.getByRole('textbox', { name: 'Your greeting' }), '   ');
        await userEvent.click(next());
        expect(onTypeInstead).not.toHaveBeenCalled();
        expect(screen.getByRole('textbox', { name: 'Your greeting' })).toBeInvalid();
      });

      it('clears the inline message once the owner types again', async () => {
        setup('greeting');
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        await userEvent.click(next());
        expect(screen.getByRole('alert')).toBeInTheDocument();
        await userEvent.type(screen.getByRole('textbox', { name: 'Your greeting' }), 'W');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      it('opens on the owner’s typed greeting, ready to change, when that is what is staged', () => {
        const staged: StagedOnboardingChoice = { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } };
        setup('greeting', { staged, editing: true });
        expect(screen.getByRole('textbox', { name: 'Your greeting' })).toHaveValue('Walsh, go ahead');
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Pick instead' })).toBeInTheDocument();
      });

      it('keeps what was typed when the owner flips to the cards and back', async () => {
        setup('greeting');
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Your greeting' }), 'Walsh here');
        await userEvent.click(screen.getByRole('button', { name: 'Pick instead' }));
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        expect(screen.getByRole('textbox', { name: 'Your greeting' })).toHaveValue('Walsh here');
      });

      it('still answers by card after flipping away from typing', async () => {
        const { onPick, onTypeInstead } = setup('greeting');
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        await userEvent.click(screen.getByRole('button', { name: 'Pick instead' }));
        await userEvent.click(screen.getByRole('radio', { name: /Thanks for calling Walsh Plumbing/ }));
        await userEvent.click(next());
        expect(onPick).toHaveBeenCalledWith('b');
        expect(onTypeInstead).not.toHaveBeenCalled();
      });
    });

    describe('the price', () => {
      async function openPrice(props: Partial<OptionPairTurnProps> = {}) {
        const utils = setup('trip_fee_and_rate', props);
        await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
        return utils;
      }
      const tripField = () => screen.getByRole('textbox', { name: 'To come out' });
      const rateField = () => screen.getByRole('textbox', { name: 'Per hour' });

      it('swaps the cards for two dollar fields, each a 44px target', async () => {
        await openPrice();
        expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
        for (const field of [tripField(), rateField()]) {
          expect(field.className).toMatch(/min-h-11/);
          expect(field.className).toMatch(/w-full/);
          expect(field).toHaveAttribute('inputmode', 'decimal');
        }
      });

      it('emits integer cents and a label built from them', async () => {
        const { onTypeInstead } = await openPrice();
        await userEvent.type(tripField(), '$120');
        await userEvent.type(rateField(), '175');
        await userEvent.click(next());
        expect(onTypeInstead).toHaveBeenCalledTimes(1);
        const override = onTypeInstead.mock.calls[0][0];
        expect(override).toEqual({
          label: '$120 to come out, then $175 an hour',
          writes: {},
          prices: { tripFeeCents: 12000, hourlyRateCents: 17500 },
        });
        expect(Number.isInteger(override.prices.tripFeeCents)).toBe(true);
        expect(Number.isInteger(override.prices.hourlyRateCents)).toBe(true);
      });

      it('keeps real cents in the cents and the label', async () => {
        const { onTypeInstead } = await openPrice();
        await userEvent.type(tripField(), '89.50');
        await userEvent.type(rateField(), '$234.05');
        await userEvent.click(next());
        expect(onTypeInstead).toHaveBeenCalledWith({
          label: '$89.50 to come out, then $234.05 an hour',
          writes: {},
          prices: { tripFeeCents: 8950, hourlyRateCents: 23405 },
        });
      });

      it('accepts a free trip, since a shop may not charge to come out', async () => {
        const { onTypeInstead } = await openPrice();
        await userEvent.type(tripField(), '0');
        await userEvent.type(rateField(), '150');
        await userEvent.click(next());
        expect(onTypeInstead).toHaveBeenCalledWith({
          label: '$0 to come out, then $150 an hour',
          writes: {},
          prices: { tripFeeCents: 0, hourlyRateCents: 15000 },
        });
      });

      it('submits with the Enter key from either field', async () => {
        const { onTypeInstead } = await openPrice();
        await userEvent.type(tripField(), '120');
        await userEvent.type(rateField(), '175{Enter}');
        expect(onTypeInstead).toHaveBeenCalledTimes(1);
      });

      it('rejects anything that is not dollars, inline, and sends nothing', async () => {
        const { onTypeInstead } = await openPrice();
        for (const bad of ['abc', '-5', '89.999', '12 0', '1,2']) {
          await userEvent.clear(tripField());
          await userEvent.clear(rateField());
          await userEvent.type(tripField(), bad);
          await userEvent.type(rateField(), '150');
          await userEvent.click(next());
          expect(tripField(), bad).toBeInvalid();
          expect(screen.getByRole('alert'), bad).toHaveTextContent('Use dollars, like 120 or 89.50.');
        }
        expect(onTypeInstead).not.toHaveBeenCalled();
      });

      it('names the field that is wrong, and only that one', async () => {
        const { onTypeInstead } = await openPrice();
        await userEvent.type(tripField(), '120');
        await userEvent.type(rateField(), 'lots');
        await userEvent.click(next());
        expect(tripField()).toBeValid();
        expect(rateField()).toBeInvalid();
        expect(rateField()).toHaveAccessibleDescription('Use dollars, like 120 or 89.50.');
        // The wrong field shows red; the right one keeps its normal border.
        expect(rateField().className).toMatch(/border-destructive/);
        expect(rateField().className).not.toMatch(/border-foreground\/20/);
        expect(tripField().className).toMatch(/border-foreground\/20/);
        expect(onTypeInstead).not.toHaveBeenCalled();
      });

      it('asks for both amounts when either is empty', async () => {
        const { onTypeInstead } = await openPrice();
        await userEvent.click(next());
        expect(tripField()).toHaveAccessibleDescription('Enter what you charge to come out.');
        expect(rateField()).toHaveAccessibleDescription('Enter your hourly rate.');
        await userEvent.type(tripField(), '120');
        await userEvent.type(rateField(), '0');
        await userEvent.click(next());
        expect(rateField()).toHaveAccessibleDescription('Enter your hourly rate.');
        expect(onTypeInstead).not.toHaveBeenCalled();
      });

      it('opens on the typed prices, ready to change, when that is what is staged', () => {
        const staged: StagedOnboardingChoice = {
          override: {
            label: '$120 to come out, then $175 an hour',
            writes: {},
            prices: { tripFeeCents: 12000, hourlyRateCents: 17550 },
          },
        };
        setup('trip_fee_and_rate', { staged, editing: true });
        expect(tripField()).toHaveValue('$120');
        expect(rateField()).toHaveValue('$175.50');
      });

      it('shows the typical prices as hints, never as values', async () => {
        await openPrice();
        expect(tripField()).toHaveValue('');
        expect(tripField()).toHaveAttribute('placeholder', '$89');
        expect(rateField()).toHaveAttribute('placeholder', '$150');
      });
    });
  });
  describe('Rivet speaks (inside the shell)', () => {
    /** The shell's real voice hook, as ConversationShell provides it; the network is stubbed at fetch. */
    function Voice({ children }: { children: ReactNode }) {
      const voice = useRivetVoice({ funnel: { tenantId: 't', userId: 'u' } });
      return <RivetVoiceContext.Provider value={voice}>{children}</RivetVoiceContext.Provider>;
    }
    let batches: string[][];
    let singles: string[];
    let played: string[];
    let element: HTMLMediaElement | null;
    /** The clip playing now reaches its end, as the audio element reports it. */
    const finish = () => act(() => void element?.dispatchEvent(new Event('ended')));
    const src = (text: string) => `data:audio/mpeg;base64,${btoa(encodeURIComponent(text))}`;

    beforeEach(() => {
      batches = [];
      singles = [];
      played = [];
      element = null;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const json = (body: unknown) =>
            Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          if (String(input) === '/api/voice/tts') {
            const { text } = JSON.parse(String(init?.body)) as { text: string };
            singles.push(text);
            return json({ clipHash: 'f'.repeat(64), audio: btoa(encodeURIComponent(text)), contentType: 'audio/mpeg' });
          }
          const { items } = JSON.parse(String(init?.body)) as { items: string[] };
          if (String(input) !== '/api/voice/tts/batch') throw new Error(`unexpected request ${String(input)}`);
          batches.push(items);
          const clips = items.map((text, i) => ({
            text,
            clipHash: String(i).padStart(64, '0'),
            audio: btoa(encodeURIComponent(text)),
            contentType: 'audio/mpeg',
            cached: false,
          }));
          return Promise.resolve(new Response(JSON.stringify({ clips }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }),
      );
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        element = this;
        played.push(this.src);
        return Promise.resolve();
      });
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    });
    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('narrates the turn when it opens: the question, each option with its reason and what callers hear, then which most shops pick', async () => {
      const choice = choiceFor('booking_posture');
      const lines = narrateTurn(choice);
      render(
        <Voice>
          <OptionPairTurn choice={choice} busy={false} error={null} notice={null} editing={false} onPick={vi.fn()} />
        </Voice>,
      );
      await waitFor(() => expect(played).toEqual([src(lines[0])]));
      // The whole narration is one request.
      expect(batches).toEqual([lines]);
      expect(lines).toEqual([
        'When someone wants a repair, do I book it or hold it for you?',
        expect.stringMatching(/^First: Book it on the call\. The caller leaves with a time\..* Callers hear: “I have Tuesday at 2/),
        expect.stringMatching(/^Second: Hold it for me\. I take the details.* Callers hear: “I've got everything I need\./),
        'Most shops pick the first. Which one?',
      ]);
      for (let i = 1; i < lines.length; i += 1) {
        finish();
        await waitFor(() => expect(played.at(-1)).toBe(src(lines[i])));
      }
      expect(singles).toEqual([]);
    });

    it("a tapped card selects it, cuts the narration short, and plays that option's caller line", async () => {
      const choice = choiceFor('booking_posture');
      const lines = narrateTurn(choice);
      render(
        <Voice>
          <OptionPairTurn choice={choice} busy={false} error={null} notice={null} editing={false} onPick={vi.fn()} />
        </Voice>,
      );
      await waitFor(() => expect(played).toEqual([src(lines[0])]));

      await userEvent.click(screen.getByRole('radio', { name: 'Hold it for me' }));
      expect(screen.getByRole('radio', { name: 'Hold it for me' })).toHaveAttribute('aria-checked', 'true');
      await waitFor(() => expect(played.at(-1)).toBe(src(choice.options[1].rivetLine)));
      expect(singles).toEqual([choice.options[1].rivetLine]);
      finish();
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The rest of the narration never plays after the tap.
      expect(played).toEqual([src(lines[0]), src(choice.options[1].rivetLine)]);
      expect(next()).toBeEnabled();
    });

    it('outside the shell nothing listens, so the greeting keeps only the hearing half of its line', () => {
      setup('greeting');
      expect(screen.getByText('Tap one to hear it.')).toBeInTheDocument();
      expect(screen.queryByText(/say .?first|say .?second/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Answer out loud' })).not.toBeInTheDocument();
    });

    it('stays silent outside the shell: no voice, no request', () => {
      setup('booking_posture', { onTypeInstead: undefined });
      expect(batches).toEqual([]);
      expect(played).toEqual([]);
    });
  });

  describe('Rivet listens (inside the shell, S3-5)', () => {
    // The microphone and Deepgram's socket are the browser/vendor boundary (faked as in
    // useDeepgramDictation.test.ts); the voice hook, the matcher and the turn are real, and
    // the API is stubbed at fetch.
    class FakeWebSocket {
      static OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    class FakeMediaRecorder {
      state = 'inactive';
      ondataavailable: unknown = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    let micAnswer: 'granted' | 'denied';
    let tokenStatus: number;
    const socket = () => FakeWebSocket.instances.at(-1)!;
    const open = () => act(() => {
      socket().readyState = 1;
      socket().onopen?.();
    });
    const hear = (transcript: string) =>
      act(() => {
        socket().onmessage?.({ data: JSON.stringify({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript }] } }) });
      });
    const interim = (transcript: string) =>
      act(() => {
        socket().onmessage?.({ data: JSON.stringify({ is_final: false, channel: { alternatives: [{ transcript }] } }) });
      });
    const flush = () =>
      act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });

    beforeEach(() => {
      FakeWebSocket.instances = [];
      micAnswer = 'granted';
      tokenStatus = 200;
      vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
      vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
      vi.stubGlobal('navigator', {
        ...navigator,
        mediaDevices: {
          getUserMedia: vi.fn(async () => {
            if (micAnswer === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
            return { getTracks: () => [{ stop: vi.fn() }] };
          }),
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const path = String(input);
          const reply = (status: number, body: unknown) =>
            Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
          if (path.startsWith('/api/voice/stream-token')) {
            return tokenStatus === 200
              ? reply(200, { token: 'dg-temp', expiresIn: 30, model: 'nova-3' })
              : reply(tokenStatus, { error: 'NOT_CONFIGURED', message: 'Live transcription is not configured' });
          }
          if (path.startsWith('/api/voice/tts')) return reply(501, { error: 'NOT_CONFIGURED', message: 'Speech synthesis is not configured' });
          throw new Error(`unexpected request ${path}`);
        }),
      );
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    });
    afterEach(() => {
      cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    /** The shell's voice: "Make it mine" unlocks the audio and asks for the microphone, then the turn opens. */
    function Shell({ children }: { children: ReactNode }) {
      const voice = useRivetVoice({ funnel: { tenantId: 't', userId: 'u' } });
      const [started, setStarted] = useState(false);
      return (
        <RivetVoiceContext.Provider value={voice}>
          {started ? (
            children
          ) : (
            <button
              type="button"
              onClick={() => {
                voice.unlock('make_it_mine');
                voice.openMic();
                setStarted(true);
              }}
            >
              Make it mine
            </button>
          )}
        </RivetVoiceContext.Provider>
      );
    }

    async function openTurn(key: OnboardingCoreChoiceKey, props: Partial<OptionPairTurnProps> = {}) {
      const onPick = vi.fn();
      const utils = render(
        <Shell>
          <OptionPairTurn choice={choiceFor(key)} busy={false} error={null} notice={null} editing={false} onPick={onPick} {...props} />
        </Shell>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Make it mine' }));
      await flush();
      return { onPick, ...utils };
    }
    const mic = () => screen.queryByRole('button', { name: 'Answer out loud' });
    const transcript = () => screen.getByTestId('rivet-transcript');

    it('puts the mic on the turn only when Rivet can listen', async () => {
      await openTurn('booking_posture');
      expect(mic()).toBeInTheDocument();
      open();
      expect(mic()).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Listening')).toBeInTheDocument();
      cleanup();

      micAnswer = 'denied';
      await openTurn('booking_posture');
      expect(mic()).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getAllByRole('radio')).toHaveLength(2);
      cleanup();

      tokenStatus = 503;
      await openTurn('booking_posture');
      expect(mic()).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says the whole greeting line when it can listen, and drops the listening half when it cannot', async () => {
      await openTurn('greeting');
      expect(screen.getByText('Tap one to hear it. Say "first" or "second" to pick.')).toBeInTheDocument();
      cleanup();
      micAnswer = 'denied';
      await openTurn('greeting');
      expect(screen.getByText('Tap one to hear it.')).toBeInTheDocument();
      expect(screen.queryByText(/say .?first/i)).not.toBeInTheDocument();
    });

    it('a spoken answer selects the card, shows what was heard under it, and answers at once', async () => {
      const { onPick } = await openTurn('booking_posture');
      open();
      interim('hold');
      expect(transcript()).toHaveTextContent('hold');
      hear('hold it');
      const hold = screen.getByRole('radio', { name: 'Hold it for me' });
      expect(hold).toHaveAttribute('aria-checked', 'true');
      expect(within(hold).getByText('Heard: “hold it”')).toBeInTheDocument();
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenCalledWith('b', 'voice');
    });

    it('a miss says what it heard and how to answer; the second miss adds an example; nothing is picked', async () => {
      const { onPick } = await openTurn('booking_posture');
      open();
      hear('banana');
      expect(transcript()).toHaveTextContent('I heard “banana”. Tap one, or say first or second.');
      expect(transcript()).not.toHaveTextContent('For example');
      hear('something else');
      expect(transcript()).toHaveTextContent('I heard “something else”. Tap one, or say first or second. For example, say “first”.');
      expect(onPick).not.toHaveBeenCalled();
      expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
      expect(transcript()).toHaveAttribute('role', 'status');
      expect(transcript()).toHaveAttribute('aria-live', 'polite');
    });

    it('after 6 s of quiet says "Take your time" once, stops listening, and never says it twice', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await openTurn('booking_posture');
      open();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_900);
      });
      expect(screen.queryByText("Take your time. Tap the mic when you're ready.")).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.getByText("Take your time. Tap the mic when you're ready.")).toBeInTheDocument();
      expect(mic()).toHaveAttribute('aria-pressed', 'false');

      // The mic tap listens again; another quiet spell stops it without saying the line again.
      fireEvent.click(mic()!);
      await flush();
      open();
      expect(mic()).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByText("Take your time. Tap the mic when you're ready.")).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_100);
      });
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryAllByText("Take your time. Tap the mic when you're ready.")).toHaveLength(0);
    });

    it('stops listening while the owner types, and while an answer is being saved', async () => {
      const onTypeInstead = vi.fn();
      await openTurn('greeting', { onTypeInstead });
      open();
      const first = socket();
      fireEvent.click(screen.getByRole('button', { name: 'Type instead' }));
      expect(first.readyState).toBe(3);
      expect(mic()).not.toBeInTheDocument();
      cleanup();

      const onPick = vi.fn();
      const turnWith = (busy: boolean) => (
        <Shell>
          <OptionPairTurn choice={choiceFor('booking_posture')} busy={busy} error={null} notice={null} editing={false} onPick={onPick} />
        </Shell>
      );
      const { rerender } = render(turnWith(false));
      fireEvent.click(screen.getByRole('button', { name: 'Make it mine' }));
      await flush();
      open();
      const second = socket();
      rerender(turnWith(true));
      expect(second.readyState).toBe(3);
      expect(mic()).toBeDisabled();
    });

    it('class contract at 320px: the mic is a 44px-plus target, every control is, and nothing is wider than the screen', async () => {
      const { container } = await openTurn('greeting', { onTypeInstead: vi.fn() });
      open();
      hear('banana');
      expectTapTarget(mic()!, 'the mic');
      expect(mic()!.className).toMatch(/(^|\s)min-h-11(\s|$)/);
      expectAllTapTargets(container, 'a listening turn');
      const widths: number[] = [];
      for (const el of Array.from(container.querySelectorAll('*'))) {
        for (const m of (el.getAttribute('class') ?? '').matchAll(/(?:^|\s)(?:min-|max-)?w-\[(\d+)px\]/g)) widths.push(Number(m[1]));
      }
      expect(widths.filter((w) => w > 320)).toEqual([]);
      expect(transcript().className).toMatch(/break-words/);
      // The halo pulses only for owners who have not asked for less motion.
      const halo = mic()!.querySelector('[data-halo]');
      expect(halo?.getAttribute('class')).toMatch(/motion-reduce:animate-none/);
    });
  });
});
