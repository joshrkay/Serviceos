import { useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import type { OnboardingCoreChoiceKey, OnboardingDraft } from '@ai-service-os/shared';
import { useRivetLine } from '../../../hooks/useRivetVoice';
import { Button } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { readbackRows } from './summarize';

export interface ReadbackCardProps {
  draft: OnboardingDraft;
  /** True while "That's right" is in flight. */
  approving: boolean;
  /** Owner-facing, one line each. */
  error: string | null;
  notice: string | null;
  /** "That's right": the only thing that saves. */
  onApprove: () => void;
  /** Tap a row to change that choice: the shell opens that turn and returns here. */
  onEdit: (key: OnboardingCoreChoiceKey) => void;
}

const READBACK_LINE = "Here's what I've got. Tap anything to change it.";

const ROW =
  'flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 disabled:opacity-60';

/** Here is what I've got: one row per choice, in plain words, and the one tap that saves it. */
export function ReadbackCard({ draft, approving, error, notice, onApprove, onEdit }: ReadbackCardProps) {
  const rows = readbackRows(draft);
  const heading = useRef<HTMLHeadingElement>(null);
  // The read-back replaces a turn (or the Ready screen): put focus on what Rivet now says.
  useEffect(() => heading.current?.focus(), []);
  useRivetLine('readback', READBACK_LINE);
  return (
    <>
      <SpeakerLine />
      <RivetHeading ref={heading}>{READBACK_LINE}</RivetHeading>

      <ul className="mt-5 flex flex-col rounded-2xl border border-border bg-card">
        {rows.map((row) => (
          <li key={row.key} className="border-b border-border last:border-b-0">
            <button type="button" className={ROW} disabled={approving} onClick={() => onEdit(row.key)}>
              <span className="shrink-0 basis-[84px] pt-0.5 text-sm text-muted-foreground">{row.label}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="break-words text-base font-medium">{row.value}</span>
                {row.note ? <span className="text-[13px] text-muted-foreground">{row.note}</span> : null}
              </span>
              <ChevronRight aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>

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
        <Button
          fullWidth
          size="lg"
          className="h-14 whitespace-normal rounded-2xl text-[17px] font-semibold"
          loading={approving}
          onClick={onApprove}
        >
          That&apos;s right
        </Button>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">Nothing&apos;s saved until you say so.</p>
      </div>
    </>
  );
}
