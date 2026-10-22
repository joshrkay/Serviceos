import { useContext, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Mic } from 'lucide-react';
import type { CreateOnboardingDraftBody } from '@ai-service-os/shared';
import { RivetVoiceContext, useRivetTurnListener } from '../../../hooks/useRivetVoice';
import type { ScreenCommand, Utterance, UtteranceScreen } from '../../../lib/onboarding-utterance';
import { Button } from '../../ui';
import { cn } from '../../ui/utils';
import { isUsCellNumber } from './cell-number';
import {
  ASK_CELL,
  ASK_NAME,
  ASK_SPELL,
  ASK_TRADE,
  CELL_NONE,
  NAME_MISS,
  TRADE_MISS,
  TRADES,
  askFor,
  confirmMiss,
  matchTrade,
  nameHeard,
  nextIntroStep,
  parseSpokenCell,
  spokenBusinessName,
  tradeAmbiguous,
  tradeHeard,
  type IntroStep,
  type TradePackId,
} from './intro-speech';
import { RivetHeading, SpeakerLine } from './TurnFrame';

const FIELD =
  'min-h-11 w-full rounded-2xl border-[1.5px] border-foreground/20 bg-card px-4 py-3.5 text-lg text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none';

export type AnswerAsInput = Required<Pick<CreateOnboardingDraftBody, 'packId' | 'businessName' | 'phone'>>;

export interface AnswerAsScreenProps {
  onSubmit: (input: AnswerAsInput) => void;
  /** What the owner typed last time, so coming back to the form never blanks it. Read once, when the form opens. */
  initial?: Partial<AnswerAsInput>;
  /**
   * Why the API refused the cell in `initial` (its own owner-facing words). Read once, when the
   * form opens: it stays on the field for as long as the field holds that same cell, and that
   * cell is never sent again.
   */
  cellProblem?: string | null;
}

const CELL_WHY = 'I ring this number for emergencies, and your area code sets your prices. 10 digits with the area code.';
const CELL_NOT_US = "That doesn't look like a US cell number. Include the area code, 10 digits.";

const SPELL: ScreenCommand = { id: 'spell', phrases: ['spell it', 'let me spell it', 'spell the name'] };
const TYPE: ScreenCommand = { id: 'type', phrases: ['type it', "I'll type it", 'let me type it'] };
/** Send the form (or, before it is complete, ask for what is missing). Never a bare "yes", which a correction can start with. */
const SHOW: ScreenCommand = { id: 'show', phrases: ['show me my shop', 'looks good', 'sounds good', 'go ahead'] };
const CHANGE: readonly ScreenCommand[] = [
  { id: 'change_name', phrases: ['change the name', 'change the business name'] },
  { id: 'change_trade', phrases: ['change the trade'] },
  { id: 'change_cell', phrases: ['change the number', 'change the cell', 'change my cell', 'change my number'] },
];
/** Boosted for the transcription on this screen: the trades as Rivet names them. */
const INTRO_KEYTERMS = ['plumbing', 'HVAC', 'electrical', 'something else'];
const QUIET_LINE = "Take your time. Tap the mic when you're ready.";
const CANNOT_HEAR = "I can't hear you on this device, so type your answers below.";
const TYPE_IT = 'Go ahead and type it.';

/**
 * The one question Rivet cannot default: what to answer the phone as, and
 * which trade, plus the cell. The cell is required: until the later slice that
 * asks for it on its own and gates approval on it, this is the only place the
 * owner's number is given, and without it a booked job cannot be handed to the
 * owner and an emergency has nowhere to ring. Its area code also picks the
 * prices. Everything else is assembled from these before the owner is asked
 * anything.
 *
 * Out loud (voice-only onboarding, build plan PR 4): where Rivet can listen,
 * "Answer out loud" unlocks his voice and asks for the microphone in the same
 * tap, and he asks the three one at a time: the name (read back, with "spell
 * it" to spell it), the trade (plumbing, HVAC, electrical, or something else;
 * two trades named are asked about, never picked), and the cell (read back
 * digit by digit). Each answer fills the form, so the owner sees and can fix
 * it, and anything that did not fit is said aloud and shown: the form's own
 * cell message, a trade not caught, a name not caught. Then he reads the whole
 * form back and "show me my shop" sends it, exactly as the button does. Plain
 * matching only (intro-speech.ts), no model. An owner who comes back to this form
 * with the microphone still on (a refused cell, "Change my answers") is asked
 * the first thing still missing, and a refused cell is said with its reason.
 */
export function AnswerAsScreen({ onSubmit, initial, cellProblem = null }: AnswerAsScreenProps) {
  const [businessName, setBusinessName] = useState(initial?.businessName ?? '');
  const [packId, setPackId] = useState<string | null>(initial?.packId ?? null);
  const [cell, setCell] = useState(initial?.phone ?? '');
  const [refusal] = useState(() => (cellProblem ? { cell: (initial?.phone ?? '').trim(), reason: cellProblem } : null));

  const name = businessName.trim();
  const typedCell = cell.trim();
  const cellOk = isUsCellNumber(typedCell);
  // The reason belongs to the cell that was refused, not to the field: another number clears it.
  const refusedFor = (value: string) => (refusal !== null && value === refusal.cell ? refusal.reason : null);
  const refused = refusedFor(typedCell);
  const cellProblemShown = refused ?? (typedCell !== '' && !cellOk ? CELL_NOT_US : null);
  const canSubmit = name.length > 0 && packId !== null && cellOk && refused === null;

  const send = () => {
    if (packId === null || !canSubmit) return;
    setSent(true);
    onSubmit({ packId, businessName: name, phone: typedCell });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };

  // ---- Out loud ----------------------------------------------------------
  const voice = useContext(RivetVoiceContext);
  const [step, setStep] = useState<IntroStep | null>(() =>
    voice?.input === 'on' ? nextIntroStep({ name, packId, cellOk: cellOk && refused === null }) : null,
  );
  const [rivetSaid, setRivetSaid] = useState('');
  const lastLines = useRef<string[]>([]);
  const [resumedAfterQuiet, setResumedAfterQuiet] = useState(false);
  // Sent: stop listening, so "show me my shop" heard twice sends once.
  const [sent, setSentState] = useState(false);
  const sentRef = useRef(false);
  const setSent = (value: boolean) => {
    sentRef.current = value;
    setSentState(value);
  };

  const say = (said: string[]) => {
    const lines = said.filter(Boolean);
    lastLines.current = lines;
    setRivetSaid(lines.join(' '));
    if (voice) void voice.speakAll(lines, { turn: 'answer_as', with: lines });
  };

  // Opened with the microphone already on: ask the first thing still missing, a refused cell with its reason.
  const opening = useRef(step);
  useEffect(() => {
    const first = opening.current;
    if (first === null) return;
    say(first === 'cell' && refused !== null ? [refused, ASK_CELL] : askFor(first, { name, packId, cell: typedCell }));
    // Once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Leaving the form ends whatever Rivet was saying on it.
  const stopRef = useRef(voice?.stop);
  stopRef.current = voice?.stop;
  useEffect(() => () => stopRef.current?.(), []);

  const listenFor = useMemo<UtteranceScreen>(
    () => ({
      help: ['repeat'],
      freeAnswer: true,
      keyterms: INTRO_KEYTERMS,
      commands: step === 'confirm' ? [SHOW, SPELL, ...CHANGE, TYPE] : [SHOW, SPELL, TYPE],
    }),
    [step],
  );

  const nameField = useRef<HTMLInputElement>(null);
  const tradeGroup = useRef<HTMLDivElement>(null);
  const cellField = useRef<HTMLInputElement>(null);

  /** Ask for the next thing still missing, after `heard` (what Rivet says about the answer just given, if anything). */
  const moveOn = (heard: string, now: { name: string; packId: string | null; cell: string }) => {
    const next = nextIntroStep({ name: now.name, packId: now.packId, cellOk: isUsCellNumber(now.cell) && refusedFor(now.cell) === null });
    setStep(next);
    say([heard, ...askFor(next, now)]);
  };

  const answer = (text: string) => {
    const now = { name, packId, cell: typedCell };
    if (step === 'name' || step === 'spell') {
      const heardName = spokenBusinessName(text);
      if (heardName === null) {
        say([step === 'spell' ? `I didn't catch that. ${ASK_SPELL}` : NAME_MISS]);
        return;
      }
      setBusinessName(heardName);
      moveOn(nameHeard(heardName), { ...now, name: heardName });
    } else if (step === 'trade') {
      const match = matchTrade(text);
      if (match.kind === 'trade') {
        setPackId(match.packId);
        moveOn(tradeHeard(match.packId), { ...now, packId: match.packId });
      } else {
        say([match.kind === 'ambiguous' ? tradeAmbiguous(match.packIds) : TRADE_MISS]);
      }
    } else if (step === 'cell') {
      const heardCell = parseSpokenCell(text);
      if (heardCell.kind === 'cell') {
        setCell(heardCell.display);
        const why = refusedFor(heardCell.display);
        if (why !== null) say([why, ASK_CELL]);
        else moveOn('', { ...now, cell: heardCell.display });
      } else if (heardCell.kind === 'not_us') {
        // Shown in the field as heard, so the form's own message sits under it.
        setCell(heardCell.digits);
        say([CELL_NOT_US]);
      } else {
        say([CELL_NONE]);
      }
    } else if (step === 'confirm') {
      say([confirmMiss(text)]);
    }
  };

  const command = (id: string) => {
    if (id === 'spell') {
      setStep('spell');
      say([ASK_SPELL]);
    } else if (id === 'type') {
      // The owner's hands take over: stop listening and put them on the field Rivet was asking for.
      if (listen.listening) listen.toggle();
      voice?.stop();
      setRivetSaid(TYPE_IT);
      if (step === 'trade') tradeGroup.current?.querySelector('button')?.focus();
      else if (step === 'cell') cellField.current?.focus();
      else nameField.current?.focus();
    } else if (id === 'show') {
      if (canSubmit) send();
      else {
        const next = nextIntroStep({ name, packId, cellOk: cellOk && refused === null });
        setStep(next);
        say(askFor(next, { name, packId, cell: typedCell }));
      }
    } else if (id === 'change_name') {
      setStep('name');
      say([ASK_NAME]);
    } else if (id === 'change_trade') {
      setStep('trade');
      say([ASK_TRADE]);
    } else if (id === 'change_cell') {
      setStep('cell');
      say([ASK_CELL]);
    }
  };

  const listen = useRivetTurnListener(voice, {
    turn: 'answer_as',
    screen: listenFor,
    enabled: step !== null && !sent,
    onResult: (said: Utterance) => {
      if (sentRef.current || step === null) return;
      if (said.kind === 'help') say(lastLines.current);
      else if (said.kind === 'command') command(said.command);
      else if (said.kind === 'free') answer(said.text);
    },
  });

  const startOutLoud = () => {
    if (!voice) return;
    // Inside the tap: unlock Rivet's voice, then ask for the microphone (one prompt for the whole pass).
    voice.unlock('start');
    voice.openMic();
    const first = nextIntroStep({ name, packId, cellOk: cellOk && refused === null });
    setStep(first);
    say(askFor(first, { name, packId, cell: typedCell }));
  };
  const tapMic = () => {
    if (step === null) {
      startOutLoud();
      return;
    }
    if (listen.quiet && !resumedAfterQuiet) {
      setResumedAfterQuiet(true);
      say(lastLines.current);
    }
    listen.toggle();
  };

  const pickTrade = (id: TradePackId) => {
    setPackId(id);
    // Out loud, a tapped chip answers the trade question just as saying it would.
    if (step === 'trade') moveOn(tradeHeard(id), { name, packId: id, cell: typedCell });
  };

  const cannotHear = step !== null && !listen.available;
  const showsQuiet = listen.quiet && !resumedAfterQuiet;
  const transcriptLine = listen.partial
    ? listen.partial
    : listen.missed
      ? listen.missed.reply
      : cannotHear
        ? CANNOT_HEAR
        : showsQuiet
          ? QUIET_LINE
          : rivetSaid;
  const asking = (field: 'name' | 'trade' | 'cell') =>
    step === field || (field === 'name' && step === 'spell') ? 'ring-2 ring-primary/40 ring-offset-1' : '';

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col">
      <SpeakerLine />
      <RivetHeading>What should I answer as?</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        Give me a name and a trade. I&apos;ll build the rest the way shops like yours run it.
      </p>

      {listen.available || step !== null ? (
        <div className="mt-5 flex flex-col gap-2.5">
          {step !== null ? (
            <p
              data-testid="rivet-transcript"
              role="status"
              aria-live="polite"
              className={cn(
                'break-words text-[15px] leading-[1.45]',
                transcriptLine ? 'rounded-2xl border border-border bg-card px-4 py-3 text-foreground' : 'sr-only',
              )}
            >
              {transcriptLine}
            </p>
          ) : null}
          {listen.available ? (
            <button
              type="button"
              aria-label="Answer out loud"
              aria-pressed={step === null ? undefined : listen.listening}
              onClick={tapMic}
              disabled={sent}
              className={cn(
                'flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border-[1.5px] px-4 py-2.5 text-[15px] font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 disabled:opacity-60',
                listen.listening ? 'border-success bg-success/10 text-success' : 'border-foreground/20 bg-card text-foreground',
              )}
            >
              <Mic aria-hidden="true" size={20} className={cn(listen.listening && 'motion-safe:animate-pulse')} />
              <span aria-hidden="true">
                {step === null ? 'Answer out loud' : listen.listening ? 'Listening' : 'Tap to talk'}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-7 flex flex-col gap-[18px]">
        <div className="flex flex-col gap-2">
          <label htmlFor="v3-business-name" className="text-[15px] font-semibold">
            Business name
          </label>
          <input
            id="v3-business-name"
            type="text"
            autoComplete="organization"
            maxLength={120}
            placeholder="Walsh Plumbing"
            ref={nameField}
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            className={cn(FIELD, asking('name'))}
          />
        </div>

        <div role="group" aria-labelledby="v3-trade-label" className="flex flex-col gap-2">
          <span id="v3-trade-label" className="text-[15px] font-semibold">
            Your trade
          </span>
          <div ref={tradeGroup} className={cn('flex flex-wrap gap-2 rounded-3xl', asking('trade'))}>
            {TRADES.map((t) => {
              const selected = packId === t.packId;
              return (
                <button
                  key={t.packId}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pickTrade(t.packId)}
                  className={cn(
                    'min-h-11 min-w-11 rounded-full border-[1.5px] px-4 text-[15px]',
                    selected
                      ? 'border-primary bg-primary/10 font-semibold text-primary'
                      : 'border-foreground/20 bg-card font-medium text-foreground',
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="v3-cell" className="text-[15px] font-semibold">
            Your cell
          </label>
          <input
            id="v3-cell"
            type="tel"
            autoComplete="tel"
            maxLength={20}
            placeholder="(216) 555-0142"
            ref={cellField}
            value={cell}
            onChange={(e) => setCell(e.target.value)}
            aria-required="true"
            aria-invalid={cellProblemShown !== null}
            aria-describedby="v3-cell-hint"
            className={cn(FIELD, asking('cell'))}
          />
          <p
            id="v3-cell-hint"
            role={refused !== null ? 'alert' : undefined}
            className={cn('break-words text-sm', cellProblemShown !== null ? 'text-destructive' : 'text-muted-foreground')}
          >
            {cellProblemShown ?? CELL_WHY}
          </p>
        </div>
      </div>

      <div className="min-h-6 flex-1" />

      <Button type="submit" fullWidth size="lg" className="h-14 rounded-2xl text-[17px] font-semibold" disabled={!canSubmit || sent}>
        Show me my shop
      </Button>
    </form>
  );
}
