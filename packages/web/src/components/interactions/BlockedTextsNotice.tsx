/**
 * D-045 — blocked customer texts reach the owner's inbox: a count of texts
 * that did not go out, tapping through to the dispatch log filtered to them.
 *
 * Hidden when there are none and for a viewer without `dispatch:view` (403).
 * Any other failure says so, so "nothing blocked" is never a guess.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { MessageSquareWarning } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';

type LoadState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error' }
  | { status: 'ready'; total: number };

export function BlockedTextsNotice() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/interactions/dispatches?status=blocked&limit=1');
        if (res.status === 403) {
          if (!cancelled) setLoad({ status: 'hidden' });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { total?: number };
        const total = body.total ?? 0;
        if (!cancelled) setLoad(total > 0 ? { status: 'ready', total } : { status: 'hidden' });
      } catch {
        if (!cancelled) setLoad({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (load.status === 'loading' || load.status === 'hidden') return null;

  if (load.status === 'error') {
    return (
      <p role="alert" data-testid="blocked-texts-error" className="mb-4 text-sm text-destructive">
        Couldn't check for texts that didn't go out.
      </p>
    );
  }

  const { total } = load;
  return (
    <Link
      to="/interactions/dispatch?status=blocked"
      data-testid="blocked-texts-notice"
      className="mb-4 flex min-h-11 w-full items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800"
    >
      <MessageSquareWarning size={16} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        {total} customer text{total === 1 ? '' : 's'} didn't go out. See why
      </span>
    </Link>
  );
}
