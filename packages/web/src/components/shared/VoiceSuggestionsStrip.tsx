import type { VoiceSuggestion } from '../../hooks/useVoiceSuggestions';

interface VoiceSuggestionsStripProps {
  suggestions: VoiceSuggestion[];
  onSelect: (text: string) => void;
}

export function VoiceSuggestionsStrip({ suggestions, onSelect }: VoiceSuggestionsStripProps) {
  if (suggestions.length === 0) return null;

  return (
    <div
      className="mb-2 grid gap-2 min-w-0"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(0, 1fr))' }}
      data-testid="voice-suggestions-strip"
    >
      {suggestions.map((s) => (
        <button
          key={s.text}
          type="button"
          onClick={() => onSelect(s.text)}
          className="min-h-11 min-w-0 truncate rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-xs text-slate-600 hover:border-blue-300 hover:bg-blue-50/50"
        >
          {s.text}
        </button>
      ))}
    </div>
  );
}
