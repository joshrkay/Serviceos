import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth, useUser } from '@clerk/clerk-react';
import type { CreateOnboardingDraftBody } from '@ai-service-os/shared';
import { useOnboardingDraft } from '../../../hooks/useOnboardingDraft';
import { useOnboardingStatus } from '../../../hooks/useOnboardingStatus';
import { UNDO_WINDOW_MS } from '../../../hooks/useUndoableApproval';
import { trackFunnel, type AnalyticsEvent } from '../../../lib/analytics';
import { isExplicitRerun } from '../../../utils/onboarding-rerun';
import { Button, Spinner } from '../../ui';
import { OnboardingShell } from '../v2/OnboardingShell';
import { BillingStep } from '../v2/steps/BillingStep';
import { AnswerAsScreen } from './AnswerAsScreen';
import { ReadbackCard } from './ReadbackCard';
import { ReadyScreen } from './ReadyScreen';
import { SpeakerLine, RivetHeading, TurnFrame } from './TurnFrame';

type Screen = 'loading' | 'problem' | 'answer_as' | 'ready' | 'readback' | 'saving' | 'after';

interface ScreenFrame {
  minutesLeft: number;
  progress: number;
  statusLabel?: string;
}

/** Header and progress per screen. Progress only moves forward. */
const FRAME: Record<Screen, ScreenFrame> = {
  loading: { minutesLeft: 7, progress: 0.05 },
  problem: { minutesLeft: 7, progress: 0.05 },
  answer_as: { minutesLeft: 7, progress: 0.05, statusLabel: 'Nothing saved yet' },
  ready: { minutesLeft: 6, progress: 0.15, statusLabel: 'Nothing saved yet' },
  readback: { minutesLeft: 5, progress: 0.5, statusLabel: 'Waiting for your OK' },
  saving: { minutesLeft: 4, progress: 0.7, statusLabel: 'Saving' },
  after: { minutesLeft: 3, progress: 0.8, statusLabel: 'Saved' },
};

const SCREEN_VIEWED: Partial<Record<Screen, AnalyticsEvent>> = {
  ready: 'v3_ready_viewed',
  readback: 'v3_readback_viewed',
};

/**
 * "Pick, don't build" onboarding: one conversational surface. Rivet shows a
 * finished shop, the owner confirms it (or changes it), and the one tap on
 * "That's right" saves. A re-run of setup still opens the sidebar shell.
 */
export function ConversationShell() {
  const [params] = useSearchParams();
  if (isExplicitRerun(params)) return <OnboardingShell />;
  return <Conversation />;
}

function Conversation() {
  const navigate = useNavigate();
  const { userId } = useAuth();
  const { user } = useUser();
  const status = useOnboardingStatus(3000);
  const [createInput, setCreateInput] = useState<CreateOnboardingDraftBody | null>(null);
  const { draft, loading, error, notice, approving, approve, reload } = useOnboardingDraft(createInput);
  // The owner's own navigation; null until they pick, then the draft decides.
  const [picked, setPicked] = useState<'ready' | 'readback' | null>(null);
  const [saving, setSaving] = useState(false);

  const tenantId = status.data?.tenantId ?? draft?.tenantId ?? null;
  const isComplete = status.data?.isComplete === true;

  useEffect(() => {
    if (isComplete) void navigate('/', { replace: true });
  }, [isComplete, navigate]);

  useEffect(() => {
    if (!saving) return;
    const timer = setTimeout(() => setSaving(false), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [saving]);

  let screen: Screen;
  if (!draft) screen = loading ? 'loading' : error ? 'problem' : 'answer_as';
  else if (draft.status === 'approved') screen = saving ? 'saving' : 'after';
  else screen = picked ?? (Object.keys(draft.choices).length > 0 ? 'readback' : 'ready');

  const viewed = useRef<Set<Screen>>(new Set());
  useEffect(() => {
    const event = SCREEN_VIEWED[screen];
    if (!event || viewed.current.has(screen)) return;
    viewed.current.add(screen);
    trackFunnel(event, { tenantId, userId }, { trade: draft?.trade, metro: draft?.metroCode });
  }, [screen, tenantId, userId, draft?.trade, draft?.metroCode]);

  const startDraft = (input: Pick<CreateOnboardingDraftBody, 'packId' | 'businessName' | 'phone'>) => {
    const ownerFirstName = user?.firstName?.trim().slice(0, 60);
    setCreateInput({ ...input, ...(ownerFirstName ? { ownerFirstName } : {}) });
  };

  const approveReadback = async () => {
    const res = await approve();
    if (!res?.approvedNow) {
      // A repeat tap on an already-saved shop: nothing new to wait for.
      return;
    }
    trackFunnel('v3_approved', { tenantId, userId }, { proposal_count: res.proposalIds.length, trade: res.draft.trade });
    setSaving(true);
  };

  if (isComplete) return null;

  // Past "That's right": the saved choices go live, then the rest of setup is the existing steps.
  const step = status.data?.currentStep ?? null;
  if (screen === 'after' && status.data && step !== 'identity' && step !== 'pack' && step !== 'signup' && step !== 'billing') {
    return <OnboardingShell />;
  }

  const frame = FRAME[screen];
  return (
    <TurnFrame minutesLeft={frame.minutesLeft} progress={frame.progress} statusLabel={frame.statusLabel}>
      {screen === 'loading' && (
        <div className="flex flex-1 items-center justify-center" role="status" aria-label="Getting your shop ready">
          <Spinner size="md" />
        </div>
      )}
      {screen === 'problem' && (
        <>
          <SpeakerLine />
          <RivetHeading>{error}</RivetHeading>
          <div className="mt-6">
            <Button fullWidth size="lg" className="h-14 rounded-2xl text-[17px] font-semibold" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        </>
      )}
      {screen === 'answer_as' && <AnswerAsScreen onSubmit={startDraft} />}
      {screen === 'ready' && draft && (
        // S2b puts the seven choice turns between these two screens; until then
        // "Make it mine" goes straight to the read-back, like "Looks right as is".
        <ReadyScreen draft={draft} onMakeItMine={() => setPicked('readback')} onKeepAsIs={() => setPicked('readback')} />
      )}
      {screen === 'readback' && draft && (
        <ReadbackCard
          draft={draft}
          approving={approving}
          error={error}
          notice={notice}
          onApprove={() => void approveReadback()}
        />
      )}
      {screen === 'saving' && draft && <SavingLine count={draft.proposalIds.length} />}
      {screen === 'after' && (step === 'billing' ? <BillingStep /> : <SavingLine count={draft?.proposalIds.length ?? 0} settling />)}
    </TurnFrame>
  );
}

function SavingLine({ count, settling = false }: { count: number; settling?: boolean }) {
  return (
    <>
      <SpeakerLine />
      <RivetHeading>{settling ? 'Getting your shop ready.' : 'Saving your choices.'}</RivetHeading>
      <p role="status" className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        {count > 0
          ? `Saving ${count} ${count === 1 ? 'change' : 'changes'}. They go live in a few seconds.`
          : 'This takes a few seconds.'}
      </p>
    </>
  );
}
