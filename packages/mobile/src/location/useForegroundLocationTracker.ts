import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { postLocationBatch } from '../api/technicianField';
import { useApiClient } from '../lib/useApiClient';
import { LocationPingBuffer, type ForegroundLocationSample } from './locationSamples';
import {
  createClientPingId,
  requestWhenInUsePermission,
  watchForegroundPosition,
  type ForegroundLocationSubscription,
} from './nativeLocationDeps';

export type ForegroundTrackingStatus =
  | 'idle'
  | 'requesting'
  | 'tracking'
  | 'paused'
  | 'denied'
  | 'error';

export interface ForegroundLocationTrackerOptions {
  enabled: boolean;
  technicianId: string | null;
  appointmentId?: string;
}

export interface ForegroundLocationTrackerResult {
  status: ForegroundTrackingStatus;
}

export function useForegroundLocationTracker(
  options: ForegroundLocationTrackerOptions,
): ForegroundLocationTrackerResult {
  const client = useApiClient();
  const [status, setStatus] = useState<ForegroundTrackingStatus>('idle');
  const buffer = useMemo(() => new LocationPingBuffer(), [options.technicianId]);

  useEffect(() => {
    if (!options.enabled || !options.technicianId) {
      setStatus('idle');
      return;
    }

    const technicianId = options.technicianId;
    let mounted = true;
    let permission: 'undetermined' | 'granted' | 'denied' = 'undetermined';
    let subscription: ForegroundLocationSubscription | null = null;
    let startVersion = 0;
    let flushing = false;

    const stopWatching = () => {
      startVersion += 1;
      subscription?.remove();
      subscription = null;
    };

    const flush = async (): Promise<void> => {
      if (flushing) return;
      const pings = buffer.pending();
      if (pings.length === 0) return;
      flushing = true;
      let sent = false;
      try {
        await postLocationBatch(client, { technicianId, pings });
        buffer.acknowledge(pings.map((ping) => ping.clientPingId));
        sent = true;
        if (mounted && AppState.currentState === 'active') setStatus('tracking');
      } catch (caught) {
        const failure =
          caught instanceof Error ? caught : new Error('Location update failed');
        if (mounted && failure.name !== 'AbortError') setStatus('error');
      } finally {
        flushing = false;
        if (sent && buffer.pending().length > 0) void flush();
      }
    };

    const onLocation = (sample: ForegroundLocationSample) => {
      buffer.enqueue(sample, createClientPingId(), options.appointmentId);
      void flush();
    };

    const startWatching = async (): Promise<void> => {
      if (!mounted || AppState.currentState !== 'active' || subscription) return;
      const version = ++startVersion;
      if (permission === 'undetermined') {
        setStatus('requesting');
        try {
          permission = await requestWhenInUsePermission();
        } catch (caught) {
          const failure =
            caught instanceof Error ? caught : new Error('Location permission failed');
          if (mounted && version === startVersion && failure.name !== 'AbortError') {
            setStatus('error');
          }
          return;
        }
      }
      if (!mounted || version !== startVersion || AppState.currentState !== 'active') return;
      if (permission === 'denied') {
        setStatus('denied');
        return;
      }
      try {
        const nextSubscription = await watchForegroundPosition(onLocation);
        if (!mounted || version !== startVersion || AppState.currentState !== 'active') {
          nextSubscription.remove();
          return;
        }
        subscription = nextSubscription;
        setStatus('tracking');
      } catch (caught) {
        const failure =
          caught instanceof Error ? caught : new Error('Location tracking failed');
        if (mounted && version === startVersion && failure.name !== 'AbortError') {
          setStatus('error');
        }
      }
    };

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void startWatching();
      } else {
        stopWatching();
        if (mounted) setStatus('paused');
      }
    });

    void startWatching();

    return () => {
      mounted = false;
      stopWatching();
      appStateSubscription.remove();
    };
  }, [buffer, client, options.appointmentId, options.enabled, options.technicianId]);

  return { status };
}
