import type { EscalationEvent } from '../../hooks/useEscalationStream';

interface EscalationPanelProps {
  event: EscalationEvent;
  onDismiss: () => void;
  onOutcome: (outcome: 'resolved' | 'hung_up' | 'needs_callback') => void;
}

export function EscalationPanel({ event, onDismiss, onOutcome }: EscalationPanelProps) {
  // event.panel is provided by backend serialization; default to safe empties.
  const panel = (event.panel ?? {}) as {
    header?: { title: string; callerName: string; callerPhone: string };
    customer?: { name: string; phone: string; tags?: string[] };
    lastInteraction?: string | null;
    intent?: { summary: string; entities?: Array<{ key: string; value: string }> };
    reason?: { code: string; humanReadable: string };
    transcriptSnapshot?: Array<{ role: 'caller' | 'ai'; text: string; ts: number }>;
  };

  return (
    <div
      role="dialog"
      aria-label="Incoming call transfer"
      className="w-96 rounded-lg border border-amber-300 bg-white shadow-2xl"
    >
      <div className="bg-amber-50 px-4 py-3 border-b border-amber-200 rounded-t-lg">
        <div className="font-semibold text-amber-900">📞 {panel.header?.title ?? 'Incoming transfer'}</div>
        <div className="text-sm text-amber-700">
          {panel.header?.callerName} · {panel.header?.callerPhone}
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        {panel.customer?.tags && panel.customer.tags.length > 0 && (
          <div className="flex gap-1">
            {panel.customer.tags.map((tag) => (
              <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                {tag}
              </span>
            ))}
          </div>
        )}

        {panel.lastInteraction && (
          <div className="text-sm text-gray-600">{panel.lastInteraction}</div>
        )}

        {panel.intent && (
          <div>
            <div className="text-sm font-medium">{panel.intent.summary}</div>
            {panel.intent.entities && panel.intent.entities.length > 0 && (
              <ul className="text-xs text-gray-500 mt-1">
                {panel.intent.entities.map((e) => (
                  <li key={e.key}>
                    {e.key}: {e.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {panel.reason && (
          <div className="text-xs text-amber-700">Reason: {panel.reason.humanReadable}</div>
        )}

        {panel.transcriptSnapshot && panel.transcriptSnapshot.length > 0 && (
          <div className="bg-gray-50 rounded p-2 max-h-40 overflow-y-auto text-xs space-y-1">
            {panel.transcriptSnapshot.map((t, i) => (
              <div key={i} className={t.role === 'caller' ? 'text-gray-800' : 'text-blue-700'}>
                <span className="font-medium">{t.role === 'caller' ? 'Caller' : 'AI'}:</span> {t.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 px-4 py-3 flex gap-2 justify-end">
        <button
          onClick={() => onOutcome('hung_up')}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
        >
          Hung up
        </button>
        <button
          onClick={() => onOutcome('needs_callback')}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
        >
          Needs callback
        </button>
        <button
          onClick={() => onOutcome('resolved')}
          className="text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700"
        >
          Resolved
        </button>
        <button
          onClick={onDismiss}
          className="text-xs px-2 py-1.5 text-gray-400 hover:text-gray-600"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
