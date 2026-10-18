import { useId } from 'react';
import type { AssembledOnboardingChoice } from '@ai-service-os/shared';
import { Input } from '../../ui';
import { GREETING_MAX, type TypedErrors, type TypedField, type TypedKind, type TypedValues } from './typed-answer';
import { dollars } from './summarize';

export interface TypeInsteadFieldsProps {
  kind: TypedKind;
  /** The assembled choice: its first option's prices are shown as the hint in the empty price fields. */
  choice: AssembledOnboardingChoice;
  values: TypedValues;
  errors: TypedErrors;
  onChange: (field: TypedField, value: string) => void;
}

/** The fields behind "Type instead". The turn owns the form, the values and the Next button. */
export function TypeInsteadFields({ kind, choice, values, errors, onChange }: TypeInsteadFieldsProps) {
  if (kind === 'greeting') {
    return (
      <div className="mt-5 flex flex-col gap-[18px]">
        <TypedInput
          label="Your greeting"
          value={values.greeting}
          placeholder={choice.options[0].label}
          maxLength={GREETING_MAX}
          error={errors.greeting}
          autoFocus
          onChange={(value) => onChange('greeting', value)}
        />
      </div>
    );
  }
  const typical = choice.options[0].prices;
  return (
    <div className="mt-5 flex flex-col gap-[18px]">
      <TypedInput
        label="To come out"
        value={values.trip}
        placeholder={typical ? dollars(typical.tripFeeCents) : undefined}
        inputMode="decimal"
        maxLength={14}
        error={errors.trip}
        autoFocus
        onChange={(value) => onChange('trip', value)}
      />
      <TypedInput
        label="Per hour"
        value={values.rate}
        placeholder={typical ? dollars(typical.hourlyRateCents) : undefined}
        inputMode="decimal"
        maxLength={14}
        error={errors.rate}
        onChange={(value) => onChange('rate', value)}
      />
    </div>
  );
}

interface TypedInputProps {
  label: string;
  value: string;
  placeholder?: string;
  maxLength: number;
  inputMode?: 'decimal';
  error?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}

function TypedInput({ label, value, placeholder, maxLength, inputMode, error, autoFocus, onChange }: TypedInputProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[15px] font-semibold">
        {label}
      </label>
      <Input
        id={id}
        type="text"
        autoComplete="off"
        autoFocus={autoFocus}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        invalid={error !== undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-2xl border-[1.5px] border-foreground/20 px-4 py-3.5 text-lg"
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
