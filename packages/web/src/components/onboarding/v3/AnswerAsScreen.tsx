import { useState, type FormEvent } from 'react';
import type { CreateOnboardingDraftBody } from '@ai-service-os/shared';
import { Button } from '../../ui';
import { cn } from '../../ui/utils';
import { isUsCellNumber } from './cell-number';
import { RivetHeading, SpeakerLine } from './TurnFrame';

const TRADES = [
  { packId: 'plumbing', label: 'Plumbing' },
  { packId: 'hvac', label: 'HVAC' },
  { packId: 'electrical', label: 'Electrical' },
  { packId: 'other', label: 'Something else' },
] as const;

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

/**
 * The one question Rivet cannot default: what to answer the phone as, and
 * which trade, plus the cell. The cell is required: until the later slice that
 * asks for it on its own and gates approval on it, this is the only place the
 * owner's number is given, and without it a booked job cannot be handed to the
 * owner and an emergency has nowhere to ring. Its area code also picks the
 * prices. Everything else is assembled from these before the owner is asked
 * anything.
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
  const refused = refusal !== null && typedCell === refusal.cell ? refusal.reason : null;
  const cellProblemShown = refused ?? (typedCell !== '' && !cellOk ? CELL_NOT_US : null);
  const canSubmit = name.length > 0 && packId !== null && cellOk && refused === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (packId === null || !canSubmit) return;
    onSubmit({ packId, businessName: name, phone: typedCell });
  };

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col">
      <SpeakerLine />
      <RivetHeading>What should I answer as?</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        Give me a name and a trade. I&apos;ll build the rest the way shops like yours run it.
      </p>

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
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            className={FIELD}
          />
        </div>

        <div role="group" aria-labelledby="v3-trade-label" className="flex flex-col gap-2">
          <span id="v3-trade-label" className="text-[15px] font-semibold">
            Your trade
          </span>
          <div className="flex flex-wrap gap-2">
            {TRADES.map((t) => {
              const selected = packId === t.packId;
              return (
                <button
                  key={t.packId}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPackId(t.packId)}
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
            value={cell}
            onChange={(e) => setCell(e.target.value)}
            aria-required="true"
            aria-invalid={cellProblemShown !== null}
            aria-describedby="v3-cell-hint"
            className={FIELD}
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

      <Button type="submit" fullWidth size="lg" className="h-14 rounded-2xl text-[17px] font-semibold" disabled={!canSubmit}>
        Show me my shop
      </Button>
    </form>
  );
}
