import { useState, type FormEvent } from 'react';
import type { AssembledOnboardingChoice, OnboardingOptionKey, StagedOnboardingChoice } from '@ai-service-os/shared';
import { Button, OptionCard } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';
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
  /** "Next": the owner picked one of the two. */
  onPick: (option: OnboardingOptionKey) => void;
  /** "Type instead", on the two turns that have it. Absent elsewhere, and then there is no such control. */
  onTypeInstead?: (override: TypedOverride) => void;
  /** Opened from the read-back: the button reads "Save" and the shell returns there. */
  editing: boolean;
}

/**
 * One this-or-that choice. The owner selects a card, then taps Next, so a
 * mis-tap is recoverable. Nothing is saved until the shell stages the answer.
 */
export function OptionPairTurn({ choice, staged, busy, error, notice, onPick, onTypeInstead, editing }: OptionPairTurnProps) {
  const kind = onTypeInstead ? typedKind(choice.settingKey) : null;
  const [selected, setSelected] = useState<OnboardingOptionKey | null>(staged && 'option' in staged ? staged.option : null);
  const [typing, setTyping] = useState(kind !== null && isTypedAnswer(staged));
  const [typed, setTyped] = useState(() => initialTypedValues(staged));
  const [typedErrors, setTypedErrors] = useState<TypedErrors>({});

  const options = choice.options.map((o) => ({
    key: o.key,
    label: o.label,
    detail: o.detail,
    rivetLine: o.rivetLine,
    mostShops: o.key === choice.mostShops,
  }));

  const changeTyped = (field: TypedField, value: string) => {
    setTyped((v) => ({ ...v, [field]: value }));
    setTypedErrors(({ [field]: _cleared, ...rest }) => rest);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (typing && kind && onTypeInstead) {
      const result = typedAnswer(kind, typed);
      if (result.override) onTypeInstead(result.override);
      else setTypedErrors(result.errors);
    } else if (selected) {
      onPick(selected);
    }
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-1 flex-col">
      <SpeakerLine />
      <RivetHeading>{choice.question}</RivetHeading>
      {choice.supportLine ? <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">{choice.supportLine}</p> : null}

      {typing && kind ? (
        <TypeInsteadFields kind={kind} choice={choice} values={typed} errors={typedErrors} onChange={changeTyped} />
      ) : (
        <OptionCard className="mt-5" label={choice.question} options={options} value={selected} onChange={setSelected} disabled={busy} />
      )}

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
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
