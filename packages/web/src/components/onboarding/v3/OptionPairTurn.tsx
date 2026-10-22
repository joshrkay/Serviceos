import { useContext, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Mic } from 'lucide-react';
import type { AssembledOnboardingChoice, OnboardingOptionKey, StagedOnboardingChoice } from '@ai-service-os/shared';
import { RivetVoiceContext, useRivetLine, useRivetTurnListener } from '../../../hooks/useRivetVoice';
import type { UtteranceScreen } from '../../../lib/onboarding-utterance';
import { Button, OptionCard } from '../../ui';
import { cn } from '../../ui/utils';
import { withoutListeningPromise } from './listening-copy';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { spokenLines } from './turns';
import { TypeInsteadFields } from './TypeInsteadFields';
import {
  initialTypedValues,
  isTypedAnswer,
  typedAnswer,
  typedKind,
  type TypedErrors,
  type TypedField,
  type TypedOverride,
} from './typed-answer';

export interface OptionPairTurnProps {
  /** Rivet's question, its support line and the two options, all from the assembled draft. */
  choice: AssembledOnboardingChoice;
  /** What is already staged for this choice: shown selected (resume, or edit from the read-back). */
  staged?: StagedOnboardingChoice;
  /** True while the answer is being saved. */
  busy: boolean;
  /** Owner-facing, one line each. */
  error: string | null;
  notice: string | null;
  /** "Next": the owner picked one of the two (or said which, out loud: then at once, with `via` 'voice'). */
  onPick: (option: OnboardingOptionKey, via?: 'voice') => void;
  /** "Type instead", on the two turns that have it. Absent elsewhere, and then there is no such control. */
  onTypeInstead?: (override: TypedOverride) => void;
  /** Opened from the read-back: the button reads "Save" and the shell returns there. */
  editing: boolean;
}

/**
 * One this-or-that choice. The owner selects a card, then taps Next, so a
 * mis-tap is recoverable. Nothing is saved until the shell stages the answer.
 * Inside the shell Rivet says the question when the turn opens, and tapping a
 * card plays what Rivet would say ("Tap one to hear it"). When Rivet can
 * listen, the turn listens too: the mic is live, what the owner is saying fills
 * the transcript card, and "first", "the second one" or words from a label pick
 * that card at once with `Heard: "…"` under it (the read-back is where it is
 * changed). A miss says what was heard and how to answer; quiet for 6 s stops
 * the mic with "Take your time". Where nothing listens there is no mic and no
 * banner: the cards and Next are the turn.
 */
export function OptionPairTurn({ choice, staged, busy, error, notice, onPick, onTypeInstead, editing }: OptionPairTurnProps) {
  const kind = onTypeInstead ? typedKind(choice.settingKey) : null;
  const [selected, setSelected] = useState<OnboardingOptionKey | null>(staged && 'option' in staged ? staged.option : null);
  const [typing, setTyping] = useState(kind !== null && isTypedAnswer(staged));
  const [typed, setTyped] = useState(() => initialTypedValues(staged));
  const [typedErrors, setTypedErrors] = useState<TypedErrors>({});

  const voice = useContext(RivetVoiceContext);
  const lines = useMemo(() => spokenLines(choice), [choice]);
  useRivetLine(choice.settingKey, choice.question, lines);
  const [heard, setHeard] = useState<{ key: OnboardingOptionKey; text: string } | null>(null);
  const [resumedAfterQuiet, setResumedAfterQuiet] = useState(false);
  // An answer was sent from this turn: stop listening until it fails (the shell moves on when it saves),
  // so the moment between "saved" and the next turn never opens another socket.
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!busy && (error || notice)) setSent(false);
  }, [busy, error, notice]);
  // The cards only, for now: help phrases arrive with Rivet's longer explanations (build plan PR 3).
  const listenFor = useMemo<UtteranceScreen>(() => ({ options: choice.options }), [choice.options]);
  const listen = useRivetTurnListener(voice, {
    turn: choice.settingKey,
    screen: listenFor,
    enabled: !busy && !typing && !sent,
    onResult: (said) => {
      if (said.kind !== 'pick') {
        setHeard(null);
        return;
      }
      setSelected(said.key);
      setHeard({ key: said.key, text: said.transcript });
      setSent(true);
      onPick(said.key, 'voice');
    },
  });
  const supportLine = listen.available ? choice.supportLine : withoutListeningPromise(choice.supportLine);

  const pick = (key: OnboardingOptionKey) => {
    setSelected(key);
    if (heard && heard.key !== key) setHeard(null);
    const line = choice.options.find((o) => o.key === key)?.rivetLine;
    if (voice && line) void voice.speak(line, { turn: choice.settingKey, with: lines });
  };

  // Each turn is a fresh mount, so put focus on Rivet's new question rather than let it fall to the page.
  // A turn that opens on the owner's typed words already focuses its own field.
  const heading = useRef<HTMLHeadingElement>(null);
  const opensTyping = useRef(typing);
  useEffect(() => {
    if (!opensTyping.current) heading.current?.focus();
  }, []);

  const options = choice.options.map((o) => ({
    key: o.key,
    label: o.label,
    detail: o.detail,
    // The greeting's options are what Rivet says, so the line would repeat the label under it.
    rivetLine: o.rivetLine === o.label ? undefined : o.rivetLine,
    mostShops: o.key === choice.mostShops,
    heard: heard?.key === o.key ? heard.text : undefined,
  }));

  const showsQuiet = listen.quiet && !resumedAfterQuiet;
  const transcriptLine = listen.partial
    ? listen.partial
    : listen.missed
      ? listen.missed.reply
      : showsQuiet
        ? "Take your time. Tap the mic when you're ready."
        : '';
  const tapMic = () => {
    if (listen.quiet) setResumedAfterQuiet(true);
    listen.toggle();
  };

  const changeTyped = (field: TypedField, value: string) => {
    setTyped((v) => ({ ...v, [field]: value }));
    setTypedErrors(({ [field]: _cleared, ...rest }) => rest);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (typing && kind && onTypeInstead) {
      const result = typedAnswer(kind, typed);
      if (result.override) {
        setSent(true);
        onTypeInstead(result.override);
      }
      else setTypedErrors(result.errors);
    } else if (selected) {
      setSent(true);
      onPick(selected);
    }
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-1 flex-col">
      <SpeakerLine />
      <RivetHeading ref={heading}>{choice.question}</RivetHeading>
      {supportLine ? <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">{supportLine}</p> : null}

      {typing && kind ? (
        <TypeInsteadFields kind={kind} choice={choice} values={typed} errors={typedErrors} onChange={changeTyped} />
      ) : (
        <OptionCard className="mt-5" label={choice.question} options={options} value={selected} onChange={pick} disabled={busy} />
      )}

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        {listen.available && !typing ? (
          <>
            <p
              data-testid="rivet-transcript"
              role="status"
              aria-live="polite"
              className={cn(
                'break-words text-center text-[15px] leading-[1.45]',
                transcriptLine ? 'rounded-2xl border border-border bg-card px-4 py-3 text-foreground' : 'sr-only',
              )}
            >
              {transcriptLine}
            </p>
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                aria-label="Answer out loud"
                aria-pressed={listen.listening}
                onClick={tapMic}
                disabled={busy}
                className={cn(
                  'relative flex size-[76px] min-h-11 min-w-11 items-center justify-center rounded-full border-2 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 disabled:opacity-60',
                  listen.listening ? 'border-success bg-success/10 text-success' : 'border-foreground/20 bg-card text-foreground',
                )}
              >
                {listen.listening ? (
                  <span
                    data-halo
                    aria-hidden="true"
                    className="absolute inset-0 animate-ping rounded-full bg-success/20 motion-reduce:animate-none"
                  />
                ) : null}
                <Mic aria-hidden="true" size={30} className="relative" />
              </button>
              <span className={cn('text-sm font-medium', listen.listening ? 'text-success' : 'text-muted-foreground')}>
                {listen.listening ? 'Listening' : 'Tap the mic to answer out loud'}
              </span>
            </div>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-center text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          {kind ? (
            <Button
              variant="ghost"
              size="lg"
              className="shrink-0 text-[15px] text-secondary-foreground"
              disabled={busy}
              onClick={() => setTyping((t) => !t)}
            >
              {typing ? 'Pick instead' : 'Type instead'}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="h-14 flex-1 rounded-2xl text-[17px] font-semibold"
            disabled={!typing && selected === null}
            loading={busy}
          >
            {editing ? 'Save' : 'Next'}
          </Button>
        </div>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">Nothing&apos;s saved until you say so.</p>
      </div>
    </form>
  );
}
