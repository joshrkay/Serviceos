import type { OnboardingDraft } from '@ai-service-os/shared';
import { Button } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { CHOICE_COUNT, readyRows, typicalShopPhrase } from './summarize';

export interface ReadyScreenProps {
  draft: OnboardingDraft;
  /** "Make it mine": walk through the choices. */
  onMakeItMine: () => void;
  /** "Looks right as is": keep every typical answer and go to the read-back. */
  onKeepAsIs: () => void;
}

/** The finished shop, shown before anything is asked. */
export function ReadyScreen({ draft, onMakeItMine, onKeepAsIs }: ReadyScreenProps) {
  const rows = readyRows(draft);
  return (
    <>
      <SpeakerLine />
      <RivetHeading>{draft.businessName} is already set up.</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        I built it the way {typicalShopPhrase(draft)} run. {numberWord(CHOICE_COUNT)} quick choices make it yours. Nothing to type.
      </p>

      <ul className="mt-[18px] flex flex-col rounded-2xl border border-border bg-card">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2 last:border-b-0"
          >
            <span className="shrink-0 basis-24 text-sm text-muted-foreground">{row.label}</span>
            <span className="min-w-0 flex-1 break-words text-[15px] font-medium">{row.value}</span>
            {row.mostShops ? (
              <span className="whitespace-nowrap rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                Most shops
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="mt-3.5 text-sm leading-[1.45] text-muted-foreground">
        Each choice is two options. Tap the one that sounds right. Nothing is saved until you say so.
      </p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        <Button fullWidth size="lg" className="h-14 whitespace-normal rounded-2xl text-[17px] font-semibold" onClick={onMakeItMine}>
          {`Make it mine, ${CHOICE_COUNT} choices`}
        </Button>
        <Button
          fullWidth
          variant="ghost"
          size="lg"
          className="whitespace-normal text-[15px] text-secondary-foreground"
          onClick={onKeepAsIs}
        >
          Looks right as is, skip the choices
        </Button>
      </div>
    </>
  );
}

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
