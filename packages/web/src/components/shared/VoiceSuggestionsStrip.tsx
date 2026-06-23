import { MessageSquareText } from 'lucide-react';

interface VoiceSuggestionsStripProps {
  /** Route-relevant example utterances (see useVoiceSuggestions). */
  suggestions: string[];
  /** Pre-fills the mic transcript with the tapped utterance for review + send. */
  onPick: (text: string) => void;
}

/**
 * "You can say…" affordance under the idle mic. Each chip pre-fills the
 * transcript (it does NOT auto-send) so the owner can glance, edit, and send —
 * the same review-then-dispatch path as a spoken transcript.
 *
 * Mobile contract (CLAUDE.md): ≥44px tap targets (min-h-11) and no horizontal
 * overflow at 320px — the row scrolls internally (overflow-x-auto + min-w-0)
 * rather than widening the bar. Pinned by VoiceSuggestionsStrip.test.tsx
 * (classes) + e2e/voice-suggestions-mobile.spec.ts (rendered px).
 */
export function VoiceSuggestionsStrip({ suggestions, onPick }: VoiceSuggestionsStripProps) {
  if (suggestions.length === 0) return null;

  return (
    <div
      data-testid="voice-suggestions"
      className="mt-2 flex items-center gap-2 overflow-x-auto min-w-0"
      style={{ scrollbarWidth: 'none' }}
    >
      <span className="shrink-0 inline-flex items-center gap-1 text-xs text-slate-400">
        <MessageSquareText size={13} className="text-slate-300" />
        Try
      </span>
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onPick(text)}
          className="
            shrink-0 min-h-11 inline-flex items-center rounded-full
            border border-slate-200 bg-white px-3 text-xs text-slate-600
            hover:border-blue-300 hover:bg-blue-50/50 hover:text-blue-700
            active:scale-[0.98] transition-colors whitespace-nowrap
          "
        >
          {text}
        </button>
      ))}
    </div>
  );
}
