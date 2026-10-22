import { useState } from 'react';
import { useApiClient } from '../../../lib/apiClient';
import { Button } from '../../ui';
import type { OnboardingStep } from '../../../types/onboarding';
import { CONNECTION_ERROR, requestErrorCopy } from './connection-copy';
import { voiceBlockerCopy } from './getting-ready-copy';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { WaitScreen } from './WaitScreen';

export interface GettingReadyTurnProps {
  /** The voice check step from the onboarding status; undefined before the first status. */
  step: OnboardingStep | undefined;
  /** The check was retried or skipped: check the status again. */
  onChanged: () => void;
}

type Action = 'retry' | 'skip';

const PATH: Record<Action, string> = {
  retry: '/api/onboarding/ai-check/retry',
  skip: '/api/onboarding/ai-check/skip',
};

/**
 * The pre-state of the test call: Rivet getting its voice ready. It passes by
 * itself in a few seconds; if it does not, the owner can run it again or skip
 * it and carry on (a failed check must never trap setup).
 */
export function GettingReadyTurn({ step, onChanged }: GettingReadyTurnProps) {
  const apiFetch = useApiClient();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: Action) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const res = await apiFetch(PATH[action], { method: 'POST' });
      if (!res.ok) {
        setError(requestErrorCopy(res.status));
        return;
      }
      onChanged();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(null);
    }
  };

  const skip = (
    <Button
      fullWidth
      variant="ghost"
      size="lg"
      className="text-[15px] text-secondary-foreground"
      loading={busy === 'skip'}
      disabled={busy !== null}
      onClick={() => void run('skip')}
    >
      Skip for now
    </Button>
  );

  if (step?.status !== 'error') {
    return (
      <WaitScreen
        heading="Getting my voice ready."
        support="This takes a few seconds."
        onRetry={() => void run('retry')}
        retrying={busy === 'retry'}
        retryError={error}
      >
        {skip}
      </WaitScreen>
    );
  }

  return (
    <>
      <SpeakerLine />
      <RivetHeading>I couldn&apos;t get my voice ready.</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">{voiceBlockerCopy(step.blockers)}</p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          fullWidth
          size="lg"
          className="h-14 rounded-2xl text-[17px] font-semibold"
          loading={busy === 'retry'}
          disabled={busy !== null}
          onClick={() => void run('retry')}
        >
          Try again
        </Button>
        {skip}
        <p className="text-center text-[13px] text-muted-foreground">Skipping is fine. You can run my check again later in Settings.</p>
      </div>
    </>
  );
}
