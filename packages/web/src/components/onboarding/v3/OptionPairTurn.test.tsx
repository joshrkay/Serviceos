import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssembledOnboardingChoice, OnboardingCoreChoiceKey, StagedOnboardingChoice } from '@ai-service-os/shared';
import { describe, expect, it, vi } from 'vitest';
import { plumbingCleDraft } from './__fixtures__';
import { OptionPairTurn, type OptionPairTurnProps } from './OptionPairTurn';

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
      expect(hold).toHaveAccessibleName('Hold it for me');
      expect(hold).toHaveTextContent('Jenna will confirm a time with you within the hour.');
      expect(hold).not.toHaveTextContent('Most shops like yours');
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
        await userEvent.type(rateField(), '$1,234.05');
        await userEvent.click(next());
        expect(onTypeInstead).toHaveBeenCalledWith({
          label: '$89.50 to come out, then $1,234.05 an hour',
          writes: {},
          prices: { tripFeeCents: 8950, hourlyRateCents: 123405 },
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
});
