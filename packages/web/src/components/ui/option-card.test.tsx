import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OptionCard, type OptionCardOption } from './option-card';

const LONG = 'ThanksForCallingWalshAndSonsPlumbingHeatingAndCoolingOfGreaterClevelandOhioWhatsGoingOnToday';

const OPTIONS: [OptionCardOption<'a' | 'b'>, OptionCardOption<'a' | 'b'>] = [
  {
    key: 'a',
    label: 'Book it on the call',
    detail: 'The caller leaves with a time.',
    rivetLine: 'I have Tuesday at 2 or Wednesday at 9.',
    mostShops: true,
  },
  {
    key: 'b',
    label: 'Hold it for me',
    detail: "I take the details and say you'll confirm.",
    rivetLine: "Jenna will confirm a time with you within the hour.",
  },
];

function setup(props: Partial<React.ComponentProps<typeof OptionCard<'a' | 'b'>>> = {}) {
  const onChange = vi.fn();
  const utils = render(<OptionCard label="Book or hold" options={OPTIONS} value={null} onChange={onChange} {...props} />);
  return { onChange, ...utils };
}

describe('OptionCard', () => {
  it('is a radiogroup named for the question, with one radio per option', () => {
    setup();
    const group = screen.getByRole('radiogroup', { name: 'Book or hold' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(screen.getByRole('radio', { name: 'Book it on the call' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Hold it for me' })).toBeInTheDocument();
  });

  it('shows the label, the detail, what Rivet would say, and the Most-shops mark on the right option only', () => {
    setup();
    const first = screen.getByRole('radio', { name: 'Book it on the call' });
    const second = screen.getByRole('radio', { name: 'Hold it for me' });
    expect(first).toHaveTextContent('The caller leaves with a time.');
    expect(first).toHaveTextContent('Rivet would say: “I have Tuesday at 2 or Wednesday at 9.”');
    expect(first).toHaveTextContent('Most shops like yours');
    expect(second).toHaveTextContent("Rivet would say: “Jenna will confirm a time with you within the hour.”");
    expect(second).not.toHaveTextContent('Most shops like yours');
  });

  it('describes each radio by its detail and its Rivet line, not just the label', () => {
    setup();
    const first = screen.getByRole('radio', { name: 'Book it on the call' });
    expect(first).toHaveAccessibleDescription(/The caller leaves with a time\..*Rivet would say/);
  });

  it('announces the Most-shops mark as the start of that option\'s description, and only for that option', () => {
    setup();
    expect(screen.getByRole('radio', { name: 'Book it on the call' })).toHaveAccessibleDescription(
      /^Most shops like yours The caller leaves with a time\./,
    );
    expect(screen.getByRole('radio', { name: 'Hold it for me' })).not.toHaveAccessibleDescription(/Most shops like yours/);
  });

  it('reads the mark in the dark ink, not the low-contrast green', () => {
    setup();
    const mark = screen.getByText('Most shops like yours');
    expect(mark.className).toMatch(/text-secondary-foreground/);
    expect(mark.className).not.toMatch(/(^|\s)text-success/);
  });

  it('leaves out the detail and the Rivet line when an option has none', () => {
    setup({ options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }] });
    const yes = screen.getByRole('radio', { name: 'Yes' });
    expect(yes).toHaveTextContent(/^Yes$/);
    expect(screen.queryByText(/Rivet would say/)).not.toBeInTheDocument();
  });

  it('marks exactly the selected option as checked', () => {
    setup({ value: 'b' });
    expect(screen.getByRole('radio', { name: 'Hold it for me' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Book it on the call' })).toHaveAttribute('aria-checked', 'false');
  });

  it('selects the option that is tapped', async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('radio', { name: 'Hold it for me' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  describe('keyboard', () => {
    function Controlled({ start = null }: { start?: 'a' | 'b' | null }) {
      const [value, setValue] = useState<'a' | 'b' | null>(start);
      return <OptionCard label="Book or hold" options={OPTIONS} value={value} onChange={setValue} />;
    }

    it('puts only one radio in the tab order: the selected one, or the first when none is', () => {
      const { rerender } = setup();
      expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1]);
      rerender(<OptionCard label="Book or hold" options={OPTIONS} value="b" onChange={vi.fn()} />);
      expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, 0]);
    });

    it('moves between the rows with the arrow keys, wrapping at both ends', async () => {
      render(<Controlled />);
      const [first, second] = screen.getAllByRole('radio');
      first.focus();
      await userEvent.keyboard('{ArrowDown}');
      expect(second).toHaveFocus();
      expect(second).toHaveAttribute('aria-checked', 'true');
      await userEvent.keyboard('{ArrowDown}');
      expect(first).toHaveFocus();
      await userEvent.keyboard('{ArrowUp}');
      expect(second).toHaveFocus();
      await userEvent.keyboard('{ArrowLeft}');
      expect(first).toHaveFocus();
      await userEvent.keyboard('{ArrowRight}');
      expect(second).toHaveFocus();
    });

    it('selects the focused row with Enter or Space', async () => {
      const { onChange } = setup();
      const [first, second] = screen.getAllByRole('radio');
      first.focus();
      await userEvent.keyboard('{Enter}');
      expect(onChange).toHaveBeenLastCalledWith('a');
      second.focus();
      await userEvent.keyboard(' ');
      expect(onChange).toHaveBeenLastCalledWith('b');
    });
  });

  it('ignores taps and keys while disabled', async () => {
    const { onChange } = setup({ disabled: true });
    const [first, second] = screen.getAllByRole('radio');
    expect(first).toBeDisabled();
    await userEvent.click(second);
    expect(onChange).not.toHaveBeenCalled();
  });

  describe('heard (S3-5: the owner answered out loud)', () => {
    const heardOptions: [OptionCardOption<'a' | 'b'>, OptionCardOption<'a' | 'b'>] = [OPTIONS[0], { ...OPTIONS[1], heard: 'the second one' }];

    it('shows what was heard under the matching card only, quoted', () => {
      setup({ options: heardOptions, value: 'b' });
      const [book, hold] = screen.getAllByRole('radio');
      expect(within(hold).getByText('Heard: “the second one”')).toBeInTheDocument();
      expect(within(book).queryByText(/Heard:/)).not.toBeInTheDocument();
    });

    it('is part of that card\'s description, so a screen reader hears it with the card', () => {
      setup({ options: heardOptions, value: 'b' });
      expect(screen.getByRole('radio', { name: 'Hold it for me' })).toHaveAccessibleDescription(/Heard: “the second one”$/);
    });

    it('wraps a long transcript, and the row stays min-h-14 and full width', () => {
      setup({ options: [OPTIONS[0], { ...OPTIONS[1], heard: LONG }], value: 'b' });
      expect(screen.getByText(`Heard: “${LONG}”`).className).toMatch(/break-words/);
      for (const radio of screen.getAllByRole('radio')) {
        expect(radio.className).toMatch(/(^|\s)min-h-14(\s|$)/);
        expect(radio.className).toMatch(/(^|\s)w-full(\s|$)/);
      }
    });
  });

  describe('class contract (jsdom cannot measure; e2e measures at 320px and 390px)', () => {
    it('gives every row min-h-14 and full width, so a row is never under 56px or narrower than the screen', () => {
      setup({ value: 'a' });
      for (const radio of screen.getAllByRole('radio')) {
        expect(radio.className).toMatch(/(^|\s)min-h-14(\s|$)/);
        expect(radio.className).toMatch(/(^|\s)w-full(\s|$)/);
      }
    });

    it('sets no fixed width wider than 320px anywhere', () => {
      const { container } = setup({ value: 'a' });
      const widths: number[] = [];
      for (const el of Array.from(container.querySelectorAll('*'))) {
        for (const m of (el.getAttribute('class') ?? '').matchAll(/(?:^|\s)(?:min-|max-)?w-\[(\d+)px\]/g)) widths.push(Number(m[1]));
      }
      expect(widths.filter((w) => w > 320)).toEqual([]);
    });

    it('wraps long labels, details and Rivet lines instead of widening the page', () => {
      setup({ options: [{ key: 'a', label: LONG, detail: LONG, rivetLine: LONG, mostShops: true }, OPTIONS[1]] });
      for (const el of screen.getAllByText(new RegExp(LONG))) {
        expect(el.className, el.textContent).toMatch(/break-words/);
      }
      const radio = screen.getAllByRole('radio')[0];
      expect(radio.className).toMatch(/(^|\s)min-w-0(\s|$)|(^|\s)w-full(\s|$)/);
    });

    it('uses design tokens only: no hard-coded slate, gray or white', () => {
      const { container } = setup({ value: 'a' });
      const classes = Array.from(container.querySelectorAll('*')).map((el) => el.getAttribute('class') ?? '').join(' ');
      expect(classes).not.toMatch(/(slate|gray|zinc|neutral|stone)-\d/);
      expect(classes).not.toMatch(/(^|\s)(bg|text|border)-(white|black)(\s|$)/);
      expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });

    it('shows one selected state: primary border and pale primary fill on the checked row only', () => {
      setup({ value: 'b' });
      const [first, second] = screen.getAllByRole('radio');
      expect(second.className).toMatch(/border-primary/);
      expect(second.className).toMatch(/bg-primary\/10/);
      expect(first.className).not.toMatch(/border-primary(?!\/)/);
      expect(first.className).not.toMatch(/bg-primary\/10/);
    });
  });
});
