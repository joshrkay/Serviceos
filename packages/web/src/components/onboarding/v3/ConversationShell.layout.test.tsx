/**
 * Mobile/glove layout contract for the v3 screens. jsdom cannot measure real
 * overflow, so this pins the CSS class contract (every control is min-h-11 and
 * full-width or min-w-11; nothing is given a fixed width wider than 320px; long
 * words wrap); the measured check at 320px and 390px is
 * e2e/onboarding-v3-ready-readback.spec.ts.
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { plumbingCleDraft, withDraft } from './__fixtures__';
import { AnswerAsScreen } from './AnswerAsScreen';
import { ReadbackCard } from './ReadbackCard';
import { ReadyScreen } from './ReadyScreen';
import { TurnFrame } from './TurnFrame';

const LONG_NAME = 'WalshAndSonsPlumbingHeatingAndCoolingOfGreaterClevelandOhio';

/** Every `w-[Npx]` / `min-w-[Npx]` under the root, as numbers. */
function fixedWidths(root: Element): number[] {
  const found: number[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const cls = el.getAttribute('class') ?? '';
    for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) found.push(Number(m[1]));
  }
  return found;
}

describe('v3 mobile layout contract', () => {
  const screens: Array<[string, () => React.ReactElement]> = [
    ['Ready', () => <ReadyScreen draft={plumbingCleDraft} onMakeItMine={vi.fn()} onKeepAsIs={vi.fn()} />],
    [
      'Read-back',
      () => <ReadbackCard draft={plumbingCleDraft} approving={false} error={null} notice={null} onApprove={vi.fn()} onEdit={vi.fn()} />,
    ],
    ['What should I answer as', () => <AnswerAsScreen onSubmit={vi.fn()} />],
  ];

  for (const [name, screen] of screens) {
    it(`${name}: every control is a 44px target and nothing is wider than 320px`, () => {
      const { container } = render(<TurnFrame minutesLeft={5} progress={0.5} statusLabel="Waiting for your OK">{screen()}</TurnFrame>);
      expectAllTapTargets(container, name);
      expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
    });
  }

  it('the frame is one centred column, 480px at most, with no sidebar', () => {
    const { container } = render(<TurnFrame minutesLeft={6} progress={0.15}>{null}</TurnFrame>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('MAIN');
    for (const token of ['mx-auto', 'w-full', 'max-w-[480px]', 'flex-col']) expect(root.className).toContain(token);
    expect(container.querySelector('nav, aside')).toBeNull();
  });

  it('long values wrap instead of widening the page', () => {
    const draft = withDraft({
      businessName: LONG_NAME,
      choices: { greeting: { override: { label: LONG_NAME, writes: { voiceGreeting: LONG_NAME } } } },
    });
    const { getAllByText } = render(
      <TurnFrame minutesLeft={5} progress={0.5}>
        <ReadyScreen draft={draft} onMakeItMine={vi.fn()} onKeepAsIs={vi.fn()} />
        <ReadbackCard draft={draft} approving={false} error={null} notice={null} onApprove={vi.fn()} onEdit={vi.fn()} />
      </TurnFrame>,
    );
    for (const el of getAllByText(new RegExp(LONG_NAME))) {
      const owner = el.closest('span, h1') as HTMLElement;
      expect(owner.className).toMatch(/break-words|min-w-0/);
    }
  });
});
