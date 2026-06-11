import { useEscalationStream } from '../../hooks/useEscalationStream';
import { EscalationPanel } from './EscalationPanel';
import { useApiClient } from '../../lib/apiClient';

export function EscalationPanelHost() {
  const apiFetch = useApiClient();
  const { activeEscalations, dismissEscalation } = useEscalationStream();

  const handleOutcome = async (
    escalationId: string,
    outcome: 'resolved' | 'hung_up' | 'needs_callback',
  ) => {
    try {
      await apiFetch(`/api/escalations/${escalationId}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
    } catch {
      // best-effort; user may need to retry
    }
    dismissEscalation(escalationId);
  };

  return (
    <>
      {activeEscalations.map((evt, idx) => (
        <div
          key={evt.escalationId}
          style={{ top: `${1 + idx * 28}rem` }}
          className="fixed right-4 z-50"
        >
          <EscalationPanel
            event={evt}
            onDismiss={() => dismissEscalation(evt.escalationId)}
            onOutcome={(outcome) => handleOutcome(evt.escalationId, outcome)}
          />
        </div>
      ))}
    </>
  );
}
