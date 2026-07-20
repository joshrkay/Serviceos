import { useAuth } from '@clerk/clerk-expo';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { createApiFetch, type ApiFetch } from '../lib/apiFetch';
import { API_BASE_URL } from '../lib/env';
import { onReconnect } from '../lib/connectivity';
import { useToast } from '../components/Toast';
import { uploadFile } from '../voice/nativeVoiceDeps';
import { deleteQueuedAudio } from './audioRelocation';
import { nativeAudioRelocationDeps } from './nativeOfflineDeps';
import { flushQueue } from './flush';
import { onOfflineFlushRequested } from './flushSignal';
import { getOfflineQueue } from './queueInstance';
import type { OfflineQueueItem } from './queue';

export interface UseOfflineFlushOptions {
  /** Gate on auth — flushing needs a signed-in session for tokens. */
  enabled: boolean;
  /** Re-fetch the proposals inbox after anything flushed or dropped. */
  onInboxRefresh?: () => void;
}

/**
 * Drains the offline queue (U12): restores the journal on mount (inflight →
 * pending), then flushes on the connectivity reconnect edge, on app
 * foreground, on sign-in (re-activating auth-parked items), and on manual
 * retry — one run at a time, with capped-backoff rescheduling after a
 * transient failure.
 *
 * The flush client is built WITHOUT `onUnauthenticated`, so a background
 * flush that hits a terminal auth failure parks items behind sign-in instead
 * of toasting + navigating the owner mid-screen.
 */
export function useOfflineFlush(options: UseOfflineFlushOptions): void {
  const { enabled, onInboxRefresh } = options;
  const { getToken, isSignedIn } = useAuth();
  const { showToast } = useToast();

  const api = useMemo<ApiFetch>(
    () =>
      createApiFetch({
        baseUrl: API_BASE_URL,
        getToken: (opts) =>
          getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
        // No onUnauthenticated on purpose — see the hook doc above.
      }),
    [getToken],
  );

  const flushingRef = useRef(false);
  const rerunRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const refreshRef = useRef(onInboxRefresh);
  refreshRef.current = onInboxRefresh;

  const onItemDropped = useCallback(
    (item: OfflineQueueItem) => {
      showToast({
        title: item.kind === 'approval' ? 'Already handled' : 'Voice note discarded',
        body:
          item.kind === 'approval'
            ? 'An approval you saved offline was resolved elsewhere or is no longer approvable.'
            : 'A voice note you saved offline could not be sent and was discarded.',
        tone: 'info',
      });
    },
    [showToast],
  );

  const trigger = useCallback(() => {
    if (!enabledRef.current) return;
    if (flushingRef.current) {
      rerunRef.current = true;
      return;
    }
    flushingRef.current = true;
    void (async () => {
      try {
        const queue = getOfflineQueue();
        await queue.restore();
        if (queue.depth() === 0) return;
        const result = await flushQueue(queue, {
          api,
          uploadFile,
          deleteAudio: (uri) => deleteQueuedAudio(nativeAudioRelocationDeps, uri),
          onItemDropped,
        });
        if ((result.flushed > 0 || result.dropped > 0) && refreshRef.current) {
          refreshRef.current();
        }
        if (result.retryAfterMs && !retryTimerRef.current) {
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            trigger();
          }, result.retryAfterMs);
        }
      } catch {
        // A flush run must never crash the app shell; items stay journaled.
      } finally {
        flushingRef.current = false;
        if (rerunRef.current) {
          rerunRef.current = false;
          trigger();
        }
      }
    })();
  }, [api, onItemDropped]);

  // Mount: restore + drain anything left from a previous launch.
  useEffect(() => {
    if (enabled) trigger();
  }, [enabled, trigger]);

  // Sign-in: re-activate items parked behind auth, then drain.
  useEffect(() => {
    if (!enabled || !isSignedIn) return;
    void getOfflineQueue()
      .reactivateAuthParked()
      .then((n) => {
        if (n > 0) trigger();
      });
  }, [enabled, isSignedIn, trigger]);

  // Reconnect edge + app foreground + manual retry.
  useEffect(() => {
    if (!enabled) return;
    const offReconnect = onReconnect(trigger);
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') trigger();
    });
    const offManual = onOfflineFlushRequested(trigger);
    return () => {
      offReconnect();
      appStateSub.remove();
      offManual();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [enabled, trigger]);
}
