import { useId, useRef, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { cn } from './utils';

export interface OptionCardOption<K extends string = string> {
  key: K;
  /** The option as the owner would say it. */
  label: string;
  /** One supporting sentence under the label. */
  detail?: string;
  /** What Rivet would say to a caller if this option is picked. */
  rivetLine?: string;
  /** The option most shops pick; gets the small "Most shops like yours" mark. */
  mostShops?: boolean;
  /** What the owner said out loud that picked this option, shown as `Heard: "…"` under it. */
  heard?: string;
}

export interface OptionCardProps<K extends string = string> {
  /** Names the group for assistive tech: the question being asked. */
  label: string;
  options: readonly OptionCardOption<K>[];
  /** The selected option, or null before the owner has picked. */
  value: K | null;
  onChange: (key: K) => void;
  disabled?: boolean;
  className?: string;
}

const ROW =
  'flex min-h-14 w-full items-start gap-3 rounded-2xl border-2 p-4 text-left transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/**
 * A this-or-that choice: a radiogroup of full-width rows (56px or taller),
 * one selected state (primary border, pale primary fill, check mark). Arrow
 * keys move between the rows and select; Enter and Space select the focused
 * row. Picking only selects; whatever saves it is the caller's button.
 */
export function OptionCard<K extends string = string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: OptionCardProps<K>) {
  const baseId = useId();
  const rows = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !back) return;
    event.preventDefault();
    const target = (index + (forward ? 1 : -1) + options.length) % options.length;
    rows.current[target]?.focus();
    onChange(options[target].key);
  };

  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-col gap-3', className)}>
      {options.map((option, index) => {
        const selected = value === option.key;
        const id = `${baseId}-${option.key}`;
        const describedBy = [
          option.mostShops ? `${id}-most` : null,
          option.detail ? `${id}-detail` : null,
          option.rivetLine ? `${id}-say` : null,
          option.heard ? `${id}-heard` : null,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={option.key}
            ref={(el) => {
              rows.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-labelledby={`${id}-label`}
            aria-describedby={describedBy || undefined}
            // One tab stop for the group: the selected row, or the first before a pick.
            tabIndex={selected || (value === null && index === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(ROW, selected ? 'border-primary bg-primary/10' : 'border-foreground/20 bg-card hover:border-primary/40')}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2',
                selected ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/30 bg-card',
              )}
            >
              {selected ? <Check size={14} strokeWidth={3} /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              {option.mostShops ? (
                <span
                  id={`${id}-most`}
                  className="inline-flex items-center gap-1 self-start rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground"
                >
                  <Check aria-hidden="true" size={12} strokeWidth={3} className="text-success" />
                  Most shops like yours
                </span>
              ) : null}
              <span id={`${id}-label`} className="break-words text-base font-semibold leading-snug text-foreground">
                {option.label}
              </span>
              {option.detail ? (
                <span id={`${id}-detail`} className="break-words text-sm leading-[1.45] text-secondary-foreground">
                  {option.detail}
                </span>
              ) : null}
              {option.rivetLine ? (
                <span id={`${id}-say`} className="break-words text-sm leading-[1.45] text-muted-foreground">
                  Rivet would say: &ldquo;{option.rivetLine}&rdquo;
                </span>
              ) : null}
              {option.heard ? (
                <span id={`${id}-heard`} className="break-words text-sm font-medium leading-[1.45] text-primary">
                  Heard: &ldquo;{option.heard}&rdquo;
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
