import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiClient } from '../../../lib/apiClient';
import { invalidateOnboardingStatusCache, type OnboardingStatusResult } from '../../../hooks/useOnboardingStatus';
import { trackFunnel, type AnalyticsEvent } from '../../../lib/analytics';
import { afterScreen, afterStage, phoneNumberOf, stepOf, type AfterScreen } from './after-screen';
import { CONNECTION_ERROR, requestErrorCopy } from './connection-copy';
import { GettingReadyTurn } from './GettingReadyTurn';
import { NumberTurn } from './NumberTurn';
import { AFTER_PACING, highestSeen, type AfterStage } from './pacing';
import { TestCallTurn } from './TestCallTurn';
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
 * test call and has not yet said "Open for business".
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
  const [testLater, setTestLater] = useState<string | null>(null);
  const testingLater = useRef(false);
  const highestProgress = useRef(0);

  const isComplete = data?.isComplete === true;
  // Setup is done, but the owner has not yet opened for business: stay for that one tap.
  const awaitingOpen = heard && !opened && data?.voiceAgentLive !== true;
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
    setTestLater(null);
    void (async () => {
      try {
        const res = await apiFetch('/api/onboarding/test-call/skip', { method: 'POST' });
        if (!res.ok) {
          setTestLater(requestErrorCopy(res.status));
          return;
        }
        await refetch();
      } catch {
        setTestLater(CONNECTION_ERROR);
      }
    })().finally(() => {
      testingLater.current = false;
    });
  };

  if (handOff) return null;

  const stage = afterStage(screen, saving, heard);
  const pacing = AFTER_PACING[stage];
  // Never backwards, whatever a late status says.
  highestProgress.current = highestSeen(highestProgress.current, pacing.progress);
  // No way out of the trial (a card is needed for the number) or of getting the number; the call can wait.
  const escape =
    !saving && screen === 'test_call' && !heard ? { label: "I'll test later", onSelect: testCallLater } : undefined;

  return (
    <TurnFrame minutesLeft={pacing.minutesLeft} progress={highestProgress.current} statusLabel={STATUS_LABEL[stage]} escape={escape}>
      {saving ? (
        <SavingLine count={changeCount} />
      ) : screen === 'wait' ? (
        <WaitScreen heading="Getting your shop ready." support="This takes a few seconds." onRetry={() => void refetch()} />
      ) : screen === 'trial' ? (
        <TrialTurn
          notice={returnNotice}
          onCheckoutRequested={(plan) => trackFunnel('v3_trial_started', funnel, { plan })}
        />
      ) : screen === 'number' ? (
        <NumberTurn step={stepOf(data, 'phone')} onChanged={() => void refetch()} />
      ) : screen === 'getting_ready' ? (
        <GettingReadyTurn step={stepOf(data, 'ai_check')} onChanged={() => void refetch()} />
      ) : (
        <TestCallTurn
          phoneNumber={phoneNumber}
          packId={packId}
          heard={heard}
          tenantId={tenantId}
          userId={userId}
          testLaterError={testLater}
          onOpened={() => setOpened(true)}
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
