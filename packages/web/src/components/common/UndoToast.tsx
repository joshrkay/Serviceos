import { Undo2, X } from 'lucide-react';

interface UndoToastProps {
  /** The approved proposal's summary, shown as the toast headline. */
  summary: string;
  /** Milliseconds remaining before the undo window closes. */
  remainingMs: number;
  /** Full window length, for the progress-bar denominator. */
  windowMs: number;
  onUndo: () => void;
  onDismiss: () => void;
}

/**
 * Finding 2 — the shared approval-undo toast. Extracted from InboxPage so the
 * inbox and the assistant surface render an IDENTICAL affordance driven by the
 * same server-anchored countdown (see useUndoableApproval). The countdown value
 * comes from the hook, which anchors it to the server's `undoExpiresAt`, so the
 * "Ns to undo" copy and the progress bar reflect the TRUE remaining window, not
 * a fresh client 5s.
 */
export function UndoToast({ summary, remainingMs, windowMs, onUndo, onDismiss }: UndoToastProps) {
  const pct = Math.max(0, Math.min(100, (remainingMs / windowMs) * 100));
  return (
    <div
      data-testid="undo-toast"
      className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-border bg-card shadow-lg px-4 py-3 min-w-[280px] max-w-[90vw]"
      style={{ animation: 'undoToastSlideUp 0.2s ease-out' }}
    >
      {/* Progress bar — shrinks with the true remaining window. */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-secondary rounded-b-xl overflow-hidden">
        <div
          data-testid="undo-toast-progress"
          className="h-full bg-warning transition-all ease-linear"
          style={{ width: `${pct}%`, transitionDuration: '100ms' }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">{summary}</p>
        <p className="text-xs text-muted-foreground">
          Approved · {Math.ceil(remainingMs / 1000)}s to undo
        </p>
      </div>
      <button
        type="button"
        onClick={onUndo}
        className="flex items-center gap-1.5 min-h-11 rounded-lg bg-warning text-primary-foreground px-3 py-1.5 text-sm font-medium hover:bg-warning/90 shrink-0"
      >
        <Undo2 size={14} /> Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="flex items-center justify-center min-h-11 min-w-11 text-muted-foreground hover:text-foreground shrink-0"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
      <style>{`@keyframes undoToastSlideUp { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }`}</style>
    </div>
  );
}
