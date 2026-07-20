/**
 * Host for the offline flush machine (U12). Mounted once under the auth gate.
 *
 * Owns the {@link createFlushController} lifecycle and its triggers:
 *  - connectivity reconnect edge (controller.start → onReconnect)
 *  - app foreground (AppState 'active')
 * and constructs the flush transport as an `ApiFetch` with `onUnauthenticated`
 * SUPPRESSED, so a background flush that hits a terminal 401 parks the queue
 * behind sign-in instead of toasting + navigating there (the terminal 401
 * surfaces as the tagged `UnauthorizedError`, a null token as an AbortError —
 * both are park signals the controller handles internally).
 */
import { useAuth } from '@clerk/clerk-expo';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { createApiFetch } from '../lib/apiFetch';
import { API_BASE_URL } from '../lib/env';
import { useToast } from '../components/Toast';
import { uploadFile } from '../voice/nativeVoiceDeps';
import { createFlushController } from './flush';
import { getOfflineQueue, loadQueue } from './offlineQueue';
import type { QueueItem } from './queue';
import { subscribeOfflineFlushRequests } from './flushSignal';

export function useOfflineSync(enabled: boolean, refreshInbox?: () => void): void {
  const { getToken } = useAuth();
  const { showToast } = useToast();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // A background-safe transport: no onUnauthenticated, so no navigation.
    const api = createApiFetch({
      baseUrl: API_BASE_URL,
      getToken: (opts) =>
        getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
    });

    const controller = createFlushController({
      queue: getOfflineQueue(),
      api,
      uploadFile,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onPermanentDrop: (item: QueueItem) => {
        showToast(
          item.kind === 'approval'
            ? {
                title: 'No longer waiting',
                body: 'That approval was resolved elsewhere, so we didn’t re-approve it.',
                tone: 'info',
              }
            : {
                title: 'Couldn’t send a voice note',
                body: 'A queued voice note was rejected and has been discarded.',
                tone: 'info',
              },
        );
        // Re-fetch the inbox so a dropped approval disappears from the list.
        refreshInbox?.();
      },
      // Auth-park: intentionally silent (no navigation). The "N actions waiting"
      // banner is the surface; the queue flushes once the owner signs in again.
      onAuthRequired: () => {},
    });

    const stopReconnect = controller.start();
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void controller.flush();
    });
    // Manual retry (approvals pull-to-refresh) — reactivate poison-parked items
    // and drain. This is the only user-driven path back off `parked`.
    const stopFlushRequests = subscribeOfflineFlushRequests(() => {
      void controller.retry();
    });

    void loadQueue().then(() => {
      // On a fresh launch, recover anything that poison-parked in a prior
      // session (retry, not plain flush) — conditions have plausibly changed.
      if (!cancelled) void controller.retry();
    });

    return () => {
      cancelled = true;
      stopReconnect();
      appStateSub.remove();
      stopFlushRequests();
    };
  }, [enabled, getToken, showToast, refreshInbox]);
}
