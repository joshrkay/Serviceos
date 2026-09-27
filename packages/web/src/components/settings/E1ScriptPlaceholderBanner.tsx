import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';

/**
 * #1386 / O-2 — persistent owner warning while AI answering runs on the
 * UNREVIEWED placeholder E1 life-safety script (gas, CO, fire, injury calls).
 * The owner decided E1 may launch only with the placeholder hard-flagged until
 * a licensed trade professional plus counsel sign off; this is the visible
 * half of that flag (every E1 call's audit row carries the other half).
 * Not dismissible: it disappears only once a reviewed script is saved
 * (PUT /api/settings/e1-script). Hidden when the status can't be read.
 */
export function E1ScriptPlaceholderBanner() {
  const apiFetch = useApiClient();
  const [placeholder, setPlaceholder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(apiFetch('/api/settings/e1-script'))
      .then(async (res) => {
        if (cancelled || !res?.ok) return;
        const body = (await res.json()) as { status?: string };
        if (!cancelled) setPlaceholder(body.status === 'placeholder');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  if (!placeholder) return null;

  return (
    <div
      role="alert"
      data-testid="e1-placeholder-banner"
      className="border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 flex flex-wrap items-center gap-3"
    >
      <AlertTriangle size={16} className="shrink-0 text-red-700" />
      <span className="flex-1 min-w-0">
        Emergency (E1) calls use a placeholder safety script that no licensed professional or counsel has reviewed yet.
      </span>
    </div>
  );
}
