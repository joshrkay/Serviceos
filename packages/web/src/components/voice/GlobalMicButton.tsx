import { Mic } from 'lucide-react';

interface GlobalMicButtonProps {
  onClick: () => void;
  active?: boolean;
}

/**
 * P22-003 — persistent push-to-talk FAB (56px touch target).
 */
export function GlobalMicButton({ onClick, active = false }: GlobalMicButtonProps) {
  return (
    <button
      type="button"
      data-testid="global-mic-button"
      aria-label="Open voice assistant"
      onClick={onClick}
      className={`fixed z-40 flex size-14 min-h-11 min-w-11 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95 bottom-20 right-4 md:bottom-6 md:right-6 ${
        active ? 'bg-red-500 text-white' : 'bg-slate-900 text-white hover:bg-slate-700'
      }`}
    >
      <Mic size={22} />
    </button>
  );
}
