import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth, useUser } from '@clerk/clerk-react';
import type { CreateOnboardingDraftBody, OnboardingCoreChoiceKey, StagedOnboardingChoice } from '@ai-service-os/shared';
import { useOnboardingDraft } from '../../../hooks/useOnboardingDraft';
import { useOnboardingStatus } from '../../../hooks/useOnboardingStatus';
import { UNDO_WINDOW_MS } from '../../../hooks/useUndoableApproval';
import { trackFunnel, type AnalyticsEvent } from '../../../lib/analytics';
import { isExplicitRerun } from '../../../utils/onboarding-rerun';
import { Button, Spinner } from '../../ui';
import { OnboardingShell } from '../v2/OnboardingShell';
import { BillingStep } from '../v2/steps/BillingStep';
import { AnswerAsScreen } from './AnswerAsScreen';
import { OptionPairTurn } from './OptionPairTurn';
import { READBACK_PROGRESS, READY_PROGRESS, highestSeen, minutesLeft, turnProgress } from './pacing';
import { ReadbackCard } from './ReadbackCard';
import { ReadyScreen } from './ReadyScreen';
import { SpeakerLine, RivetHeading, TurnFrame } from './TurnFrame';
import { answeredCount, coreTurns, landingTarget, makeItMineTarget, nextUnanswered, type CoreTurn, type TurnTarget } from './turns';
import { typedKind } from './typed-answer';

type Screen = 'loading' | 'problem' | 'answer_as' | 'ready' | 'turn' | 'readback' | 'saving' | 'after';

interface ScreenFrame {
  minutesLeft: number;
  progress: number;
  statusLabel?: string;
}

/** Header and progress for the screens whose timing does not depend on the draft. */
const STATIC_FRAME: Record<'loading' | 'problem' | 'answer_as' | 'saving' | 'after', ScreenFrame> = {
  loading: { minutesLeft: 7, progress: 0.05 },
  problem: { minutesLeft: 7, progress: 0.05 },
  answer_as: { minutesLeft: 7, progress: 0.05, statusLabel: 'Nothing saved yet' },
  saving: { minutesLeft: 3, progress: 0.7, statusLabel: 'Saving' },
  after: { minutesLeft: 3, progress: 0.8, statusLabel: 'Saved' },
};

const SCREEN_VIEWED: Partial<Record<Screen, AnalyticsEvent>> = {
  ready: 'v3_ready_viewed',
  readback: 'v3_readback_viewed',
};

/** Where the owner is in the flow once they have left Ready: a choice turn (opened to answer, or to edit), or the read-back. */
type Place = { screen: 'turn'; key: OnboardingCoreChoiceKey; editing: boolean } | { screen: 'readback' };

const placeFor = (target: TurnTarget): Place => (target.screen === 'turn' ? { screen: 'turn', key: target.key, editing: false } : target);

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
  const { draft, loading, error, notice, approving, stage, approve, reload } = useOnboardingDraft(createInput);
  // The owner's own navigation; null until they move, then the draft decides where a returning owner opens.
  const [nav, setNav] = useState<Place | null>(null);
  // What the owner last tried to save: the turn they answered, or "That's right". The hook's one error and
  // notice belong to that screen only, so a failed answer never shows up later on the read-back, or the reverse.
  const [attempt, setAttempt] = useState<OnboardingCoreChoiceKey | 'approve' | null>(null);
  const [staging, setStaging] = useState(false);
  const [saving, setSaving] = useState(false);

  const tenantId = status.data?.tenantId ?? draft?.tenantId ?? null;
  const isComplete = status.data?.isComplete === true;
  const funnelContext = { tenantId, userId };

  useEffect(() => {
    if (isComplete) void navigate('/', { replace: true });
  }, [isComplete, navigate]);

  useEffect(() => {
    if (!saving) return;
    const timer = setTimeout(() => setSaving(false), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [saving]);

  const turns = draft ? coreTurns(draft) : [];
  const landing = draft ? landingTarget(draft) : null;
  const place: Place | null = nav ?? (landing ? placeFor(landing) : null);
  const currentTurn = place?.screen === 'turn' ? turns.find((t) => t.settingKey === place.key) : undefined;
  const editing = place?.screen === 'turn' && place.editing;

  let screen: Screen;
  if (!draft) screen = loading ? 'loading' : error ? 'problem' : 'answer_as';
  else if (draft.status === 'approved') screen = saving ? 'saving' : 'after';
  else if (!place) screen = 'ready';
  else screen = currentTurn ? 'turn' : 'readback';

  const viewed = useRef<Set<Screen>>(new Set());
  useEffect(() => {
    const event = SCREEN_VIEWED[screen];
    if (!event || viewed.current.has(screen)) return;
    viewed.current.add(screen);
    trackFunnel(event, { tenantId, userId }, { trade: draft?.trade, metro: draft?.metroCode });
  }, [screen, tenantId, userId, draft?.trade, draft?.metroCode]);

  // Once per turn per visit to this page, however many times it is opened (editing reopens turns).
  const viewedTurns = useRef<Set<OnboardingCoreChoiceKey>>(new Set());
  const turnKey = screen === 'turn' ? currentTurn?.settingKey : undefined;
  useEffect(() => {
    if (!turnKey || viewedTurns.current.has(turnKey)) return;
    viewedTurns.current.add(turnKey);
    trackFunnel('v3_turn_viewed', { tenantId, userId }, { choice_key: turnKey });
  }, [turnKey, tenantId, userId]);

  const highestProgress = useRef(0);

  const goTo = (next: Place) => {
    setAttempt(null);
    setNav(next);
  };

  const startDraft = (input: Pick<CreateOnboardingDraftBody, 'packId' | 'businessName' | 'phone'>) => {
    const ownerFirstName = user?.firstName?.trim().slice(0, 60);
    setCreateInput({ ...input, ...(ownerFirstName ? { ownerFirstName } : {}) });
  };

  const makeItMine = () => {
    if (draft) goTo(placeFor(makeItMineTarget(draft)));
  };

  const keepTheRest = () => {
    if (!draft || staging) return;
    trackFunnel('v3_keep_rest', funnelContext, { answered_count: answeredCount(draft) });
    goTo({ screen: 'readback' });
  };

  const editFromReadback = (key: OnboardingCoreChoiceKey) => {
    trackFunnel('v3_readback_edit', funnelContext, { choice_key: key });
    goTo({ screen: 'turn', key, editing: true });
  };

  /** Stage the owner's answer; move on only when it is saved. A failure stays here and the turn shows why. */
  const answer = async (turn: CoreTurn, choice: StagedOnboardingChoice) => {
    if (!draft || staging) return;
    setStaging(true);
    setAttempt(turn.settingKey);
    const saved = await stage(turn.settingKey, choice).finally(() => setStaging(false));
    if (!saved) return;
    const tapped = 'option' in choice;
    trackFunnel('v3_choice_made', funnelContext, {
      choice_key: turn.settingKey,
      answer_mode: tapped ? 'tap' : 'type',
      option: tapped ? choice.option : 'override',
      is_most_shops: tapped && choice.option === turn.mostShops,
    });
    const next = editing ? null : nextUnanswered(draft, turn.settingKey);
    goTo(next ? { screen: 'turn', key: next, editing: false } : { screen: 'readback' });
  };

  const approveReadback = async () => {
    setAttempt('approve');
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

  const frame = frameFor(screen, turns.length, draft ? answeredCount(draft) : 0, editing);
  // Never backwards: going back to change an answer does not lower the line.
  highestProgress.current = highestSeen(highestProgress.current, frame.progress);
  const escape =
    screen === 'turn' ? (editing ? { label: 'Back', onSelect: () => goTo({ screen: 'readback' }) } : { label: 'Keep the rest as is', onSelect: keepTheRest }) : undefined;

  return (
    <TurnFrame minutesLeft={frame.minutesLeft} progress={highestProgress.current} statusLabel={frame.statusLabel} escape={escape}>
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
        <ReadyScreen draft={draft} onMakeItMine={makeItMine} onKeepAsIs={() => goTo({ screen: 'readback' })} />
      )}
      {screen === 'turn' && draft && currentTurn && (
        <OptionPairTurn
          key={`${currentTurn.settingKey}:${editing ? 'edit' : 'ask'}`}
          choice={currentTurn}
          // Editing opens on what the read-back showed: the owner's answer, or the one most shops pick.
          staged={draft.choices[currentTurn.settingKey] ?? (editing ? { option: currentTurn.mostShops } : undefined)}
          busy={staging}
          error={attempt === currentTurn.settingKey ? error : null}
          notice={attempt === currentTurn.settingKey ? notice : null}
          editing={editing}
          onPick={(option) => void answer(currentTurn, { option })}
          onTypeInstead={typedKind(currentTurn.settingKey) ? (override) => void answer(currentTurn, { override }) : undefined}
        />
      )}
      {screen === 'readback' && draft && (
        <ReadbackCard
          draft={draft}
          approving={approving}
          error={attempt === 'approve' ? error : null}
          notice={attempt === 'approve' ? notice : null}
          onApprove={() => void approveReadback()}
          onEdit={editFromReadback}
        />
      )}
      {screen === 'saving' && draft && <SavingLine count={draft.proposalIds.length} />}
      {screen === 'after' &&
        (step === 'billing' ? (
          <div className="mt-7">
            <BillingStep />
          </div>
        ) : (
          <SavingLine count={draft?.proposalIds.length ?? 0} settling />
        ))}
    </TurnFrame>
  );
}

/** Header and progress for a screen. Ready and the read-back bracket the turns; the turns count down what is left. */
function frameFor(screen: Screen, total: number, answered: number, editing: boolean): ScreenFrame {
  switch (screen) {
    case 'ready':
      return { minutesLeft: minutesLeft(total), progress: READY_PROGRESS, statusLabel: 'Nothing saved yet' };
    case 'turn':
      // Changing an answer from the read-back adds no work, so it reads like the read-back does.
      return {
        minutesLeft: minutesLeft(editing ? 0 : total - answered),
        progress: turnProgress(answered, total),
        statusLabel: 'Nothing saved yet',
      };
    case 'readback':
      return { minutesLeft: minutesLeft(0), progress: READBACK_PROGRESS, statusLabel: 'Waiting for your OK' };
    default:
      return STATIC_FRAME[screen];
  }
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
