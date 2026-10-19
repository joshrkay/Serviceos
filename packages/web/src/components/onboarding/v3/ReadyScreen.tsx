import type { OnboardingDraft } from '@ai-service-os/shared';
import { useRivetCanListen, useRivetLine } from '../../../hooks/useRivetVoice';
import { Button } from '../../ui';
import { useState } from 'react';
import { ONBOARDING_METROS, type OnboardingDraft, type OnboardingMetroCode } from '@ai-service-os/shared';
import { useRivetLine } from '../../../hooks/useRivetVoice';
import { Button, Input } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { CHOICE_COUNT, readyRows, typicalShopPhrase } from './summarize';

export interface ReadyScreenProps {
  draft: OnboardingDraft;
  /** "Make it mine": walk through the choices. */
  onMakeItMine: () => void;
  /** "Looks right as is": keep every typical answer and go to the read-back. */
  onKeepAsIs: () => void;
  /** "Not Cleveland?": re-price the shop for another city (PUT /draft/metro). */
  onChangeMetro: (metro: OnboardingMetroCode) => void;
  /** True while that change is being saved. */
  changingMetro: boolean;
  /** Owner-facing, one line each. */
  notice: string | null;
  error: string | null;
}

/** The finished shop, shown before anything is asked. */
export function ReadyScreen({ draft, onMakeItMine, onKeepAsIs, onChangeMetro, changingMetro, notice, error }: ReadyScreenProps) {
  const rows = readyRows(draft);
  const opener = `${draft.businessName} is already set up.`;
  useRivetLine('ready', opener);
  const canListen = useRivetCanListen();
  const [picking, setPicking] = useState(false);
  // The server refuses a metro change once ANY choice is staged (a staged pick names a price the
  // owner saw), so the control exists only while nothing is.
  const canChangeMetro = Object.keys(draft.choices).length === 0;
  const city = draft.assembled.showsCity ? draft.metroName : null;
  const pick = (metro: OnboardingMetroCode) => {
    setPicking(false);
    onChangeMetro(metro);
  };
  return (
    <>
      <SpeakerLine />
      <RivetHeading>{opener}</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        I built it the way {typicalShopPhrase(draft)} run. {numberWord(CHOICE_COUNT)} quick choices make it yours. Nothing to type.
      </p>

      {canChangeMetro && !picking ? (
        <Button
          variant="ghost"
          size="lg"
          className="mt-1 self-start whitespace-normal px-0 text-[15px] font-semibold text-primary underline-offset-4 hover:bg-transparent hover:underline"
          disabled={changingMetro}
          onClick={() => setPicking(true)}
        >
          {city ? `Not ${city}?` : 'Set my city'}
        </Button>
      ) : null}
      {canChangeMetro && picking ? (
        <CityPicker current={draft.metroCode} closeLabel={city ? `Keep ${city}` : 'Never mind'} onPick={pick} onClose={() => setPicking(false)} />
      ) : null}

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
        {canListen
          ? 'Each choice is two options. Tap the one that sounds right, or say "first" or "second". Nothing is saved until you say so.'
          : 'Each choice is two options. Tap the one that sounds right. Nothing is saved until you say so.'}
      </p>

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
          disabled={changingMetro}
          onClick={onMakeItMine}
        >
          {`Make it mine, ${CHOICE_COUNT} choices`}
        </Button>
        <Button
          fullWidth
          variant="ghost"
          size="lg"
          className="whitespace-normal text-[15px] text-secondary-foreground"
          disabled={changingMetro}
          onClick={onKeepAsIs}
        >
          Looks right as is, skip the choices
        </Button>
      </div>
    </>
  );
}

interface CityPickerProps {
  current: string | null;
  closeLabel: string;
  onPick: (metro: OnboardingMetroCode) => void;
  onClose: () => void;
}

/** The cities Rivet has prices for, searchable by name; picking one re-prices the shop for it. */
function CityPicker({ current, closeLabel, onPick, onClose }: CityPickerProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = ONBOARDING_METROS.filter((m) => m.code !== current && m.name.toLowerCase().includes(needle)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-border bg-card p-3">
      <label htmlFor="ready-city-search" className="text-sm font-medium text-secondary-foreground">
        Your city
      </label>
      <Input
        id="ready-city-search"
        type="search"
        autoFocus
        autoComplete="off"
        placeholder="Start typing your city"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches.length > 0 ? (
        <ul aria-label="Cities" className="flex max-h-64 flex-col overflow-y-auto">
          {matches.map((m) => (
            <li key={m.code}>
              <Button fullWidth variant="ghost" size="lg" className="justify-start whitespace-normal text-left text-[15px] text-foreground" onClick={() => onPick(m.code)}>
                {m.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">I don&apos;t have prices for that city yet. Pick the closest one.</p>
      )}
      <Button fullWidth variant="outline" size="lg" className="whitespace-normal text-[15px]" onClick={onClose}>
        {closeLabel}
      </Button>
    </div>
  );
}

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
