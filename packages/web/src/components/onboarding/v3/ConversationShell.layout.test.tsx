/**
 * Mobile/glove layout contract for the v3 screens. jsdom cannot measure real
 * overflow, so this pins the CSS class contract (every control is min-h-11 and
 * full-width or min-w-11; nothing is given a fixed width wider than 320px; long
 * words wrap); the measured check at 320px and 390px is
 * e2e/onboarding-v3-ready-readback.spec.ts.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { AssembledOnboardingChoice, OnboardingCoreChoiceKey, StagedOnboardingChoice } from '@ai-service-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStatusResult } from '../../../hooks/useOnboardingStatus';
import type { OnboardingStatusResponse } from '../../../types/onboarding';
import { expectAllTapTargets, expectTapTarget } from '../../../test-utils/tap-target';
import { plumbingCleDraft, withDraft } from './__fixtures__';
import { HERMETIC_PLANS_503, PLANS, json, statusAt } from './__fixtures__/after';
import { AfterApproval } from './AfterApproval';
import { AnswerAsScreen } from './AnswerAsScreen';
import { OptionPairTurn } from './OptionPairTurn';
import { ReadbackCard } from './ReadbackCard';
import { ReadyScreen } from './ReadyScreen';
import { SpeakerLine, TurnFrame } from './TurnFrame';
import { RivetVoiceContext, type RivetVoice } from '../../../hooks/useRivetVoice';

const LONG_NAME = 'WalshAndSonsPlumbingHeatingAndCoolingOfGreaterClevelandOhio';
const REFUSED_CELL = 'That does not look like a US cell number. Include the 10-digit area code, for example (216) 555-0100.';

function choiceFor(key: OnboardingCoreChoiceKey): AssembledOnboardingChoice {
  const choice = plumbingCleDraft.assembled.choices.find((c) => c.settingKey === key);
  if (!choice) throw new Error(`fixture has no ${key}`);
  return choice;
}

/** A turn as the shell renders it, with the lines that can appear under the cards. */
function turn(key: OnboardingCoreChoiceKey, over: { staged?: StagedOnboardingChoice; typeable?: boolean; editing?: boolean } = {}) {
  return (
    <OptionPairTurn
      choice={choiceFor(key)}
      staged={over.staged}
      busy={false}
      error="That didn't go through. Try again."
      notice="Your answers changed somewhere else, so I refreshed them. Tap again."
      editing={over.editing ?? false}
      onPick={vi.fn()}
      onTypeInstead={over.typeable ? vi.fn() : undefined}
    />
  );
}

/** The Ready screen as the shell renders it, with the lines that can appear above its buttons. */
function ready(draft = plumbingCleDraft) {
  return (
    <ReadyScreen
      draft={draft}
      onMakeItMine={vi.fn()}
      onKeepAsIs={vi.fn()}
      onChangeMetro={vi.fn()}
      changingMetro={false}
      error="That didn't go through. Try again."
      notice="Your answers changed somewhere else, so I refreshed them."
    />
  );
}

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
    ['Ready', () => ready()],
    [
      'Read-back',
      () => <ReadbackCard draft={plumbingCleDraft} approving={false} error={null} notice={null} onApprove={vi.fn()} onEdit={vi.fn()} />,
    ],
    ['What should I answer as', () => <AnswerAsScreen onSubmit={vi.fn()} />],
    [
      'What should I answer as: a cell that is not a US number',
      () => <AnswerAsScreen onSubmit={vi.fn()} initial={{ packId: 'plumbing', businessName: LONG_NAME, phone: '+44 7911 123456' }} />,
    ],
    [
      'What should I answer as: the API refused the cell',
      () => (
        <AnswerAsScreen
          onSubmit={vi.fn()}
          initial={{ packId: 'plumbing', businessName: LONG_NAME, phone: '(216) 555-0142' }}
          cellProblem={REFUSED_CELL}
        />
      ),
    ],
    ['Turn: two cards', () => turn('booking_posture', { staged: { option: 'b' } })],
    ['Turn: two cards with Type instead', () => turn('greeting', { typeable: true })],
    ['Turn: editing from the read-back', () => turn('payment_collection_mode', { staged: { option: 'a' }, editing: true })],
    [
      'Turn: typing the greeting',
      () => turn('greeting', { typeable: true, staged: { override: { label: 'Walsh here', writes: { voiceGreeting: 'Walsh here' } } } }),
    ],
    [
      'Turn: typing the prices',
      () =>
        turn('trip_fee_and_rate', {
          typeable: true,
          staged: { override: { label: '$120 to come out, then $175 an hour', writes: {}, prices: { tripFeeCents: 12000, hourlyRateCents: 17500 } } },
        }),
    ],
  ];

  for (const [name, screen] of screens) {
    it(`${name}: every control is a 44px target and nothing is wider than 320px`, () => {
      const { container } = render(<TurnFrame minutesLeft={5} progress={0.5} statusLabel="Waiting for your OK">{screen()}</TurnFrame>);
      expectAllTapTargets(container, name);
      expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
    });
  }

  it('the "Speaking" mark adds no control and wraps with the speaker name at 320px', () => {
    const speaking: RivetVoice = { unlock: vi.fn(), speak: vi.fn(), prefetch: vi.fn(), stop: vi.fn(), speaking: true };
    const { container } = render(
      <RivetVoiceContext.Provider value={speaking}>
        <TurnFrame minutesLeft={5} progress={0.5}>
          <SpeakerLine />
        </TurnFrame>
      </RivetVoiceContext.Provider>,
    );
    const mark = screen.getByText('Speaking');
    // Announced in words, politely: never the sound mark alone.
    expect(mark.closest('[aria-live="polite"]')).not.toBeNull();
    expect(container.querySelectorAll('button, [role="button"], a, input')).toHaveLength(0);
    const line = mark.closest('[aria-live]')!.parentElement!;
    expect(line.className).toMatch(/\bflex-wrap\b/);
    expect(line.className).toMatch(/\bmin-w-0\b/);
    expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
  it('Ready with the city list open: every city, the search and the close are 44px targets that wrap, nothing wider than 320px', async () => {
    const { container } = render(<TurnFrame minutesLeft={6} progress={0.15} statusLabel="Nothing saved yet">{ready()}</TurnFrame>);
    await userEvent.click(screen.getByRole('button', { name: 'Not Cleveland?' }));
    expectAllTapTargets(container, 'Ready with the city list open');
    expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
    const cities = screen.getByRole('list', { name: 'Cities' });
    // The list scrolls inside the screen rather than growing it, and long names wrap.
    expect(cities.className).toMatch(/max-h-\S+/);
    expect(cities.className).toContain('overflow-y-auto');
    for (const button of Array.from(cities.querySelectorAll('button'))) {
      expect(button.className).toContain('whitespace-normal');
      expect(button.className).toContain('w-full');
    }
    expect(screen.getByRole('button', { name: 'San Francisco Bay Area' })).toBeInTheDocument();
  });

  it('the cell field and what is said under it wrap at 320px, for the why, a wrong number and a refusal alike', () => {
    for (const props of [
      {},
      { initial: { phone: '+44 7911 123456' } },
      { initial: { phone: '(216) 555-0142' }, cellProblem: REFUSED_CELL },
    ]) {
      const { container, unmount } = render(
        <TurnFrame minutesLeft={5} progress={0.5}>
          <AnswerAsScreen onSubmit={vi.fn()} {...props} />
        </TurnFrame>,
      );
      const cell = screen.getByLabelText('Your cell');
      expectTapTarget(cell, 'Your cell');
      const hint = container.querySelector('#v3-cell-hint') as HTMLElement;
      expect(cell).toHaveAttribute('aria-describedby', 'v3-cell-hint');
      expect(hint.className).toMatch(/(^|\s)break-words(\s|$)/);
      expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
      unmount();
    }
  });

  it('the header escape hatch is a 44px target at the right of the header, with nothing fixed wider than 320px', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TurnFrame minutesLeft={5} progress={0.2} statusLabel="Nothing saved yet" escape={{ label: 'Keep the rest as is', onSelect }}>
        {null}
      </TurnFrame>,
    );
    const escape = screen.getByRole('button', { name: 'Keep the rest as is' });
    expectTapTarget(escape, 'Keep the rest as is');
    expect(escape.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    expect(container.querySelector('header')).toContainElement(escape);
    expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
    await userEvent.click(escape);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('a turn keeps its cards and its answer bar at full width, with Type instead and Next side by side', () => {
    const { container } = render(<TurnFrame minutesLeft={5} progress={0.2} statusLabel="Nothing saved yet" escape={{ label: 'Keep the rest as is', onSelect: vi.fn() }}>{turn('greeting', { typeable: true })}</TurnFrame>);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.className).toMatch(/(^|\s)min-h-14(\s|$)/);
      expect(radio.className).toMatch(/(^|\s)w-full(\s|$)/);
    }
    const typeInstead = screen.getByRole('button', { name: 'Type instead' });
    const next = screen.getByRole('button', { name: 'Next' });
    expect(typeInstead.parentElement).toBe(next.parentElement);
    expect(typeInstead.parentElement?.className).toMatch(/(^|\s)flex(\s|$)/);
    expect(next.className).toMatch(/(^|\s)flex-1(\s|$)/);
    expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
  });

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
        {ready(draft)}
        <ReadbackCard draft={draft} approving={false} error={null} notice={null} onApprove={vi.fn()} onEdit={vi.fn()} />
      </TurnFrame>,
    );
    for (const el of getAllByText(new RegExp(LONG_NAME))) {
      const owner = el.closest('span, h1') as HTMLElement;
      expect(owner.className).toMatch(/break-words|min-w-0/);
    }
  });

  it('long answers on a turn wrap instead of widening the page', () => {
    const long: AssembledOnboardingChoice = {
      ...choiceFor('greeting'),
      question: LONG_NAME,
      options: [
        { ...choiceFor('greeting').options[0], label: LONG_NAME, detail: LONG_NAME, rivetLine: LONG_NAME },
        choiceFor('greeting').options[1],
      ],
    };
    const { container, getAllByText } = render(
      <TurnFrame minutesLeft={5} progress={0.2}>
        <OptionPairTurn choice={long} busy={false} error={null} notice={null} editing={false} onPick={vi.fn()} />
      </TurnFrame>,
    );
    for (const el of getAllByText(new RegExp(LONG_NAME))) {
      const owner = el.closest('span, h1') as HTMLElement;
      expect(owner.className, owner.textContent).toMatch(/break-words|min-w-0/);
    }
    expectAllTapTargets(container, 'long turn');
  });
});

/**
 * The screens after "That's right", each rendered the way the shell renders it
 * (AfterApproval with a status), in every state an owner can meet.
 */
describe('v3 mobile layout contract after "That\'s right"', () => {
  const NUMBER = '+12165550180';
  const phoneDone: Parameters<typeof statusAt>[1] = { phone: { status: 'done', metadata: { phoneNumber: NUMBER } } };
  let plans: () => Response;

  beforeEach(() => {
    plans = () => json(200, { plans: PLANS });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === '/api/onboarding/billing/plans') return Promise.resolve(plans());
        throw new Error(`unexpected request ${String(input)}`);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function result(data: OnboardingStatusResponse | null): OnboardingStatusResult {
    return { data, isLoading: false, error: null, accessRevoked: false, refetch: vi.fn(() => Promise.resolve()) };
  }

  function after(data: OnboardingStatusResponse | null, saving = false) {
    return (
      <MemoryRouter>
        <AfterApproval status={result(data)} saving={saving} changeCount={2} packId="plumbing" userId="user-1" />
      </MemoryRouter>
    );
  }

  const savedAs = (execution: 'failed' | 'stopped') =>
    statusAt('identity', {}, { draft: { status: 'approved', choicesAnswered: 7, version: 2, execution } });
  const claiming = statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'claiming', pendingNumber: '+12165550199' } } });
  const asking = statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'awaiting_pick' } } });
  const holding = statusAt('phone', { phone: { status: 'current', metadata: { phoneNumber: NUMBER } } });
  const noNumber = statusAt('phone', { phone: { status: 'error', blockers: ['twilio_provisioning_failed'] } });
  const voiceWaiting = statusAt('ai_check', { ...phoneDone, ai_check: { status: 'current', metadata: { verifying: true } } });
  const voiceFailed = statusAt('ai_check', { ...phoneDone, ai_check: { status: 'error', blockers: ['ai_verification_failed'] } });

  const screens: Array<[string, OnboardingStatusResponse | null, { saving?: boolean; ready?: () => Promise<unknown> }]> = [
    ['Saving your choices', statusAt('identity'), { saving: true }],
    ['Getting your shop ready', statusAt('identity'), {}],
    ['Before the first status arrives', null, {}],
    ['Save failed: Try again', savedAs('failed'), {}],
    ['Save stopped: step by step', savedAs('stopped'), {}],
    ['Trial: the plans', statusAt('billing'), { ready: () => screen.findByRole('radiogroup') }],
    ['Trial: the plans cannot be shown', statusAt('billing'), { ready: () => screen.findByRole('alert') }],
    ['Number: getting it', claiming, {}],
    ['Number: asking for it', asking, {}],
    ['Number: here it is', holding, {}],
    ['Number: could not get one', noNumber, {}],
    ['Voice: getting ready', voiceWaiting, {}],
    ['Voice: could not get ready', voiceFailed, {}],
    ['Test call: now you call me', statusAt('test_call', phoneDone), {}],
    ['Test call: no number reported yet', statusAt('test_call'), {}],
  ];

  for (const [name, data, opts] of screens) {
    it(`${name}: every control is a 44px target and nothing is wider than 320px`, async () => {
      if (name.includes('cannot be shown')) plans = () => json(503, HERMETIC_PLANS_503);
      const { container } = render(after(data, opts.saving));
      if (opts.ready) await opts.ready();
      expectAllTapTargets(container, name);
      expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(container.querySelector('main')?.className).toContain('max-w-[480px]');
    });
  }

  it('Save failed: a failed retry adds one line under the buttons, not a wider page, and both buttons wrap at 320px', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(409, { error: 'CONFLICT', message: 'DRAFT_RETRY_UNSAFE' }))));
    const { container } = render(after(savedAs('failed')));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('alert');
    expectAllTapTargets(container, 'save failed after a failed retry');
    expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
    for (const name of ['Try again', 'Go through setup step by step']) {
      expect(screen.getByRole('button', { name }).className, name).toMatch(/whitespace-normal/);
    }
  });

  it('Test call: "I\'ll test later" is a 44px target in the header, and a failed skip adds one line, not a wider page', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(500, { error: 'INTERNAL', message: 'boom' }))));
    const { container } = render(after(statusAt('test_call', phoneDone)));
    const later = screen.getByRole('button', { name: "I'll test later" });
    expectTapTarget(later, "I'll test later");
    expect(container.querySelector('header')).toContainElement(later);
    expect(later.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    await userEvent.click(later);
    await screen.findByRole('alert');
    expectAllTapTargets(container, 'test call after a failed skip');
    expect(fixedWidths(container).filter((w) => w > 320)).toEqual([]);
  });

  it('Open for business: the one button is a 44px target and the page is no wider than 320px', async () => {
    const view = render(after(statusAt('test_call', phoneDone)));
    // The call comes in while the owner is looking, and setup is complete.
    view.rerender(after(statusAt(null, phoneDone)));
    await screen.findByRole('button', { name: "That's right. Open for business." });
    expectAllTapTargets(view.container, 'open for business');
    expect(fixedWidths(view.container).filter((w) => w > 320)).toEqual([]);
    expect(screen.queryByRole('button', { name: "I'll test later" })).not.toBeInTheDocument();
  });

  it('long numbers and plan names wrap instead of widening the page', async () => {
    const long = '+4412345678901234567890';
    const number = render(after(statusAt('phone', { phone: { status: 'current', metadata: { phoneNumber: long } } })));
    expect((screen.getByText(long).closest('p') as HTMLElement).className).toMatch(/break-words/);
    number.unmount();

    const call = render(after(statusAt('test_call', { phone: { status: 'done', metadata: { phoneNumber: long } } })));
    expect(screen.getByRole('link', { name: long }).className).toMatch(/break-words/);
    call.unmount();

    plans = () => json(200, { plans: [{ ...PLANS[0], name: 'WalshAndSonsPlumbingHeatingAndCoolingOfGreaterClevelandOhio' }] });
    const trial = render(after(statusAt('billing')));
    const row = await screen.findByRole('radio');
    expect(row.querySelector('[class*="break-words"], [class*="min-w-0"]')).not.toBeNull();
    expectAllTapTargets(trial.container, 'trial with a long plan name');
  });

  it('the headings are one breath: under twenty words on every screen', async () => {
    for (const [name, data, opts] of screens) {
      if (name.includes('cannot be shown')) plans = () => json(503, HERMETIC_PLANS_503);
      else plans = () => json(200, { plans: PLANS });
      const view = render(after(data, opts.saving));
      if (opts.ready) await opts.ready();
      await act(async () => {});
      const words = (view.container.querySelector('h1')?.textContent ?? '').trim().split(/\s+/);
      expect(words.length, name).toBeLessThan(20);
      view.unmount();
    }
  });
});
