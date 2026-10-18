import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiClient } from '../../../lib/apiClient';
import { invalidateOnboardingStatusCache, type OnboardingStatusResult } from '../../../hooks/useOnboardingStatus';
import { track, trackFunnel, type AnalyticsEvent } from '../../../lib/analytics';
import { ONBOARDING_RERUN_PATH } from '../../../utils/onboarding-rerun';
import { Button } from '../../ui';
import { afterScreen, afterStage, phoneNumberOf, stepOf, type AfterScreen } from './after-screen';
import { CONNECTION_ERROR, requestErrorCopy } from './connection-copy';
import { GettingReadyTurn } from './GettingReadyTurn';
import { NumberTurn } from './NumberTurn';
import { AFTER_PACING, highestSeen, type AfterStage } from './pacing';
import { TestCallTurn, type Closing } from './TestCallTurn';
import { useTestCallArrival } from './test-call-arrival';
import { TrialTurn } from './TrialTurn';
import { RivetHeading, SpeakerLine, TurnFrame } from './TurnFrame';
import { useBillingReturn } from './useBillingReturn';
import { WaitScreen } from './WaitScreen';

export interface AfterApprovalProps {
  status: OnboardingStatusResult;
  /** "That's right" was tapped a moment ago: the undo window is still open. */
  saving: boolean;
  /** How many changes are being saved, for the line shown during the undo window. */
  changeCount: number;
  /** The owner's pack, for the test-call scenario. */
  packId: string | null;
  userId: string | null | undefined;
}

const SCREEN_VIEWED: Partial<Record<AfterScreen, AnalyticsEvent>> = {
  trial: 'v3_trial_viewed',
  number: 'v3_number_viewed',
  test_call: 'v3_test_call_viewed',
};

const STATUS_LABEL: Record<AfterStage, string> = {
  saving: 'Saving',
  wait: 'Saving',
  trial: 'Saved',
  number: 'Your number',
  test_call: 'Almost open',
  open: 'Ready to open',
};

/**
 * Everything after "That's right", in the same frame: the saved choices go
 * live, then the trial, the number, the voice getting ready, the test call, and
 * the hand-off home. Which turn shows is derived from the onboarding status the
 * API computes, so it can never run ahead of what is true. The one place it
 * stays on a screen after setup is complete: the owner has just heard their
 * test call (or put it off) and has not yet answered "Open for business?". The
 * server opens the phones itself when a test call ends, so that screen reads
 * the live flag instead of assuming it is still off.
 */
export function AfterApproval({ status, saving, changeCount, packId, userId }: AfterApprovalProps) {
  const navigate = useNavigate();
  const apiFetch = useApiClient();
  const { data, refetch: refetchShared } = status;
  // The owner has just changed something (a retry, a skip, a payment). The status the hook shares for two
  // seconds is exactly the one that is now out of date, so ask again for real.
  const refetch = useCallback(() => {
    invalidateOnboardingStatusCache();
    return refetchShared();
  }, [refetchShared]);
  const tenantId = data?.tenantId ?? null;
  const funnel = { tenantId, userId };

  const returnNotice = useBillingReturn(refetch);
  const heard = useTestCallArrival(stepOf(data, 'test_call')?.status ?? null);
  const [opened, setOpened] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [testLater, setTestLater] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const testingLater = useRef(false);
  const highestProgress = useRef(0);
  const lowestMinutes = useRef(Infinity);

  const isComplete = data?.isComplete === true;
  const voiceAgentLive = data?.voiceAgentLive === true;
  // How the call step ended during this visit; a visit that finds setup finished never replays it.
  const closing: Closing | null = heard ? 'heard' : skipped ? 'skipped' : null;
  // Setup is done, but the owner has not yet answered "open for business?": stay for that one tap. A heard call
  // always waits (the server may already have opened the phones; the screen says so). Putting the call off only
  // waits while the phones are still closed, because that is the one place the owner is told answering is off.
  const awaitingOpen = !opened && (heard || (skipped && !voiceAgentLive));
  const handOff = isComplete && !awaitingOpen;

  useEffect(() => {
    if (handOff) void navigate('/', { replace: true });
  }, [handOff, navigate]);

  // The saved choices go live a moment after the undo window; do not wait for the next poll to find out.
  const wasSaving = useRef(saving);
  useEffect(() => {
    if (wasSaving.current && !saving) void refetch();
    wasSaving.current = saving;
  }, [saving, refetch]);

  // Setup finished during this visit: the first time a status that was not complete says it is. A visit that
  // opens on a finished setup is not a completion (same rule as the sidebar shell).
  const wasIncomplete = useRef(false);
  useEffect(() => {
    if (data?.isComplete === false) {
      wasIncomplete.current = true;
      return;
    }
    if (data?.isComplete && wasIncomplete.current) {
      wasIncomplete.current = false;
      track('onboarding_completed', { voiceAgentLive: data.voiceAgentLive });
      trackFunnel('wizard_completed', { tenantId, userId }, { voice_agent_live: data.voiceAgentLive });
    }
  }, [data?.isComplete, data?.voiceAgentLive, tenantId, userId]);

  const screen: AfterScreen = isComplete ? 'test_call' : afterScreen(data);

  // Once per screen per visit, and only for a screen the owner is actually shown (not one handed past).
  const viewed = useRef<Set<AfterScreen>>(new Set());
  useEffect(() => {
    const event = SCREEN_VIEWED[screen];
    if (saving || handOff || !event || viewed.current.has(screen)) return;
    viewed.current.add(screen);
    trackFunnel(event, { tenantId, userId });
  }, [screen, saving, handOff, tenantId, userId]);

  // The number turned up while the owner was on the number turn. A visit that resumes later in the flow
  // never saw the wait, so it does not report one (the funnel reads number_viewed to number_ready as the wait).
  const phoneNumber = phoneNumberOf(data);
  const sawNumberTurn = useRef(false);
  const numberReported = useRef(false);
  useEffect(() => {
    if (screen === 'number') sawNumberTurn.current = true;
    if (!sawNumberTurn.current || !phoneNumber || numberReported.current) return;
    numberReported.current = true;
    trackFunnel('v3_number_ready', { tenantId, userId });
  }, [screen, phoneNumber, tenantId, userId]);

  // The call was heard during this visit (same meaning as the original test-call step; a resumed visit does not replay it).
  const succeededReported = useRef(false);
  useEffect(() => {
    if (!heard || succeededReported.current) return;
    succeededReported.current = true;
    trackFunnel('test_call_succeeded', { tenantId, userId });
  }, [heard, tenantId, userId]);

  const testCallLater = () => {
    if (testingLater.current) return;
    testingLater.current = true;
    setSkipping(true);
    setTestLater(null);
    void (async () => {
      try {
        const res = await apiFetch('/api/onboarding/test-call/skip', { method: 'POST' });
        if (!res.ok) {
          setTestLater(requestErrorCopy(res.status));
          return;
        }
        setSkipped(true);
        await refetch();
      } catch {
        setTestLater(CONNECTION_ERROR);
      }
    })().finally(() => {
      testingLater.current = false;
      setSkipping(false);
    });
  };

  if (handOff) return null;

  const stage = afterStage(screen, saving, closing !== null);
  const pacing = AFTER_PACING[stage];
  // Never backwards, whatever a late status says: not the line, and not the minutes.
  highestProgress.current = highestSeen(highestProgress.current, pacing.progress);
  lowestMinutes.current = Math.min(lowestMinutes.current, pacing.minutesLeft);
  // No way out of the trial (a card is needed for the number) or of getting the number; the call can wait.
  const escape =
    !saving && screen === 'test_call' && !closing
      ? { label: "I'll test later", onSelect: testCallLater, busy: skipping }
      : undefined;

  return (
    <TurnFrame minutesLeft={lowestMinutes.current} progress={highestProgress.current} statusLabel={STATUS_LABEL[stage]} escape={escape}>
      {saving ? (
        <SavingLine count={changeCount} />
      ) : screen === 'wait' ? (
        <WaitScreen
          heading="Getting your shop ready."
          support="This takes a few seconds."
          onRetry={refetch}
          retryLabel="Check again"
          slowNote="Some of your choices may not have saved. You can check again, or go through setup step by step."
          slowAction={
            <Button fullWidth variant="outline" size="lg" className="h-14 rounded-2xl text-[17px] font-semibold whitespace-normal" onClick={() => void navigate(ONBOARDING_RERUN_PATH)}>
              Go through setup step by step
            </Button>
          }
        />
      ) : screen === 'trial' ? (
        <TrialTurn
          notice={returnNotice}
          onCheckoutRequested={(plan) => trackFunnel('v3_trial_started', funnel, { plan })}
        />
      ) : screen === 'number' ? (
        <NumberTurn step={stepOf(data, 'phone')} onChanged={refetch} />
      ) : screen === 'getting_ready' ? (
        <GettingReadyTurn step={stepOf(data, 'ai_check')} onChanged={() => void refetch()} />
      ) : (
        <TestCallTurn
          phoneNumber={phoneNumber}
          packId={packId}
          closing={closing}
          voiceAgentLive={voiceAgentLive}
          tenantId={tenantId}
          userId={userId}
          testLaterError={testLater}
          onOpened={() => {
            setOpened(true);
            // The phones are open now: leave the next screen a status that says so, not the one cached before the tap.
            void refetch();
          }}
        />
      )}
    </TurnFrame>
  );
}

function SavingLine({ count }: { count: number }) {
  return (
    <>
      <SpeakerLine />
      <RivetHeading>Saving your choices.</RivetHeading>
      <p role="status" className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        {count > 0
          ? `Saving ${count} ${count === 1 ? 'change' : 'changes'}. They go live in a few seconds.`
          : 'This takes a few seconds.'}
      </p>
    </>
  );
}
