import { useState, type FormEvent } from 'react';
import type { CreateOnboardingDraftBody } from '@ai-service-os/shared';
import { Button } from '../../ui';
import { cn } from '../../ui/utils';
import { RivetHeading, SpeakerLine } from './TurnFrame';

const TRADES = [
  { packId: 'plumbing', label: 'Plumbing' },
  { packId: 'hvac', label: 'HVAC' },
  { packId: 'electrical', label: 'Electrical' },
  { packId: 'other', label: 'Something else' },
] as const;

const FIELD =
  'min-h-11 w-full rounded-2xl border-[1.5px] border-foreground/20 bg-card px-4 py-3.5 text-lg text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none';

export interface AnswerAsScreenProps {
  onSubmit: (input: Pick<CreateOnboardingDraftBody, 'packId' | 'businessName' | 'phone'>) => void;
}

/**
 * The one question Rivet cannot default: what to answer the phone as, and
 * which trade. Everything else is assembled from these two (and the cell's
 * area code, when given) before the owner is asked anything.
 */
export function AnswerAsScreen({ onSubmit }: AnswerAsScreenProps) {
  const [businessName, setBusinessName] = useState('');
  const [packId, setPackId] = useState<string | null>(null);
  const [cell, setCell] = useState('');

  const name = businessName.trim();
  const cellDigits = cell.replace(/\D/g, '').length;
  const cellOk = cellDigits === 0 || cellDigits >= 10;
  const canSubmit = name.length > 0 && packId !== null && cellOk;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (packId === null || !canSubmit) return;
    onSubmit({ packId, businessName: name, ...(cell.trim() ? { phone: cell.trim() } : {}) });
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
            aria-describedby="v3-cell-hint"
            className={FIELD}
          />
          <p id="v3-cell-hint" className="text-sm text-muted-foreground">
            {cellOk ? 'So I can match prices to your area. You can skip this.' : 'Include the area code, 10 digits.'}
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
