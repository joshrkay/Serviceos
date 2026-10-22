/**
 * State machine for the spoken setup screen (app/(onboarding)/talk.tsx).
 *
 *   starting → ready ⇄ sending → review → saving → finished
 *
 * `start` asks the server for the greeting. Each owner turn (a transcribed
 * clip, or typed text) goes to the setup conversation and Rivet's reply is
 * shown and spoken. When the conversation completes, its setup items are
 * listed for review; "Save my setup" approves them in one batch (they are
 * capture-class, `onboarding_*`), then waits for the business-identity step
 * to finish executing so the app can unlock.
 *
 * All I/O is injected so the hook is tested without a device. Every failure
 * leaves a visible message and a way forward; nothing is retried quietly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchApproveResult } from '../proposals/useApproveBatch';
import {
  approvalFailureCopy,
  type OnboardingTurn,
  type OnboardingTurnOutcome,
  type OnboardingTurnRequest,
} from './talkThrough';

export type TranscribeOutcome = { transcript: string } | { notConfigured: true };

export interface OnboardingTalkDeps {
  sendTurn: (req: OnboardingTurnRequest) => Promise<OnboardingTurnOutcome>;
  /** Clip URI → transcript. Throws on a network/server failure. */
  transcribe: (fileUri: string) => Promise<TranscribeOutcome>;
  /**
   * Speak one of Rivet's lines. Best-effort: resolves even when nothing plays.
   * `isCurrent` turns false once the owner reaches for the mic; the clip must
   * not start after that, because playback flips the audio session out of
   * record mode and would cut the owner's answer.
   */
  speak: (text: string, isCurrent: () => boolean) => Promise<void> | void;
  /** Batch-approve the setup items. Throws on a non-2xx. */
  approve: (proposalIds: string[]) => Promise<BatchApproveResult>;
  /** Which of these items still await approval; null when that can't be read. */
  stillAwaiting: (proposalIds: string[]) => Promise<string[] | null>;
  /** Whether the business-identity step is done: true, false, or null when the status could not be read. */
  identityDone: () => Promise<boolean | null>;
  /** Device IANA zone; undefined when unknown (the server then asks). */
  timezone: string | undefined;
  /** Injected for tests. */
  wait?: (ms: number) => Promise<void>;
}

export type OnboardingTalkStatus = 'starting' | 'ready' | 'sending' | 'review' | 'saving' | 'finished';

export interface TalkTurn {
  id: string;
  role: 'owner' | 'rivet';
  text: string;
}

export interface TalkError {
  message: string;
  /** What the one button next to the message does. */
  action: 'retry_turn' | 'restart' | 'retry_save' | 'check_again' | 'none';
}

export interface UseOnboardingTalk {
  status: OnboardingTalkStatus;
  turns: TalkTurn[];
  proposalIds: string[];
  error: TalkError | null;
  /** The server has no transcription: typing only. */
  sttUnavailable: boolean;
  sendText: (text: string) => Promise<void>;
  sendAudio: (fileUri: string) => Promise<void>;
  /** The owner is about to record: drop any of Rivet's speech that has not started playing. */
  hush: () => void;
  /** The error's action: re-send the last turn, start a new conversation, re-save, or re-check. */
  recover: () => Promise<void>;
  save: () => Promise<void>;
}

/** After approval the settings execute once the 5 s undo window closes; this is how long the screen waits. */
export const SAVE_POLL_INTERVAL_MS = 2_000;
export const SAVE_POLL_ATTEMPTS = 15;

export const NOT_HEARD_COPY = "I didn't catch that. Hold the mic and try again, or type it.";
export const TRANSCRIBE_FAILED_COPY = "I couldn't hear that clip. Try again, or type it.";
export const STT_UNAVAILABLE_COPY = "Voice isn't available right now. Type your answer instead.";
export const MIC_DENIED_COPY = 'Microphone access is off. Turn it on in Settings, or type your answer.';
export const MIC_FAILED_COPY = "I couldn't start the microphone. Try again, or type your answer.";
export const SAVE_FAILED_COPY = "I couldn't save your setup. Check your connection and try again.";
export const SAVE_CHECK_FAILED_COPY = "I couldn't check what was already saved. Check your connection and try again.";
export const SAVE_SLOW_COPY = "Your setup is saved but still being applied. Check again in a moment.";
export const STATUS_UNKNOWN_COPY = "Your setup is saved, but I couldn't confirm it's finished. Check again in a moment.";

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function useOnboardingTalk(deps: OnboardingTalkDeps): UseOnboardingTalk {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [status, setStatus] = useState<OnboardingTalkStatus>('starting');
  const [turns, setTurns] = useState<TalkTurn[]>([]);
  const [proposalIds, setProposalIds] = useState<string[]>([]);
  const [error, setError] = useState<TalkError | null>(null);
  const [sttUnavailable, setSttUnavailable] = useState(false);

  const sessionId = useRef<string | undefined>(undefined);
  // Turns never overlap (the controls are disabled while one is in flight), so writing
  // the latest server answer is never a stale overwrite.
  const setSession = (id: string | undefined) => {
    sessionId.current = id;
  };
  const lastMessage = useRef<string | undefined>(undefined);
  /** Owner turns the server has confirmed. */
  const knownTurnCount = useRef(0);
  /** The last owner turn failed without an answer: it may or may not have reached the server. */
  const turnUnconfirmed = useRef(false);
  const counter = useRef(0);
  /** Bumped by hush(); a pending clip plays only while its generation is still current. */
  const speechGen = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const push = useCallback((role: TalkTurn['role'], text: string) => {
    counter.current += 1;
    const turn = { id: `t${counter.current}`, role, text };
    setTurns((t) => [...t, turn]);
  }, []);

  const applyTurn = useCallback(
    (turn: OnboardingTurn) => {
      setSession(turn.sessionId);
      knownTurnCount.current = turn.turnCount;
      turnUnconfirmed.current = false;
      push('rivet', turn.assistantMessage);
      const gen = speechGen.current;
      void depsRef.current.speak(turn.assistantMessage, () => mounted.current && speechGen.current === gen);
      if (turn.completed) {
        setProposalIds(turn.proposalIds);
        setStatus('review');
      } else {
        setStatus('ready');
      }
    },
    [push],
  );

  const applyFailure = useCallback((outcome: Exclude<OnboardingTurnOutcome, { kind: 'turn' }>) => {
    if (outcome.kind === 'session_gone' || outcome.kind === 'conflict') setSession(undefined);
    setError({
      message: outcome.message,
      action: outcome.kind === 'forbidden' ? 'none' : outcome.kind === 'failed' ? 'retry_turn' : 'restart',
    });
    setStatus(sessionId.current ? 'ready' : 'starting');
  }, []);

  const request = (userMessage?: string) => {
    const { timezone } = depsRef.current;
    return depsRef.current.sendTurn({
      ...(sessionId.current ? { sessionId: sessionId.current } : {}),
      ...(userMessage !== undefined ? { userMessage } : {}),
      ...(timezone ? { clientTimezone: timezone } : {}),
    });
  };

  /** One round-trip. `userMessage` undefined = the opening greeting. */
  const runTurn = useCallback(
    async (userMessage: string | undefined) => {
      setStatus(userMessage === undefined ? 'starting' : 'sending');
      setError(null);
      lastMessage.current = userMessage;
      const outcome = await request(userMessage);
      if (!mounted.current) return;
      if (outcome.kind === 'turn') {
        applyTurn(outcome.turn);
        return;
      }
      turnUnconfirmed.current = outcome.kind === 'failed' && userMessage !== undefined;
      applyFailure(outcome);
    },
    [applyTurn, applyFailure],
  );

  /**
   * "Try again" after a turn whose answer was lost. The server may already have
   * taken it, and re-sending would answer the NEXT question with the same words.
   * A turn with no message replays Rivet's latest line without advancing; if the
   * owner-turn count moved, that line is the lost answer and nothing is re-sent.
   */
  const retryTurn = useCallback(async () => {
    if (!turnUnconfirmed.current || !sessionId.current) {
      await runTurn(lastMessage.current);
      return;
    }
    setStatus('sending');
    setError(null);
    const probe = await request();
    if (!mounted.current) return;
    if (probe.kind !== 'turn') {
      applyFailure(probe);
      return;
    }
    if (probe.turn.turnCount > knownTurnCount.current) {
      applyTurn(probe.turn);
      return;
    }
    await runTurn(lastMessage.current);
  }, [runTurn, applyTurn, applyFailure]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runTurn(undefined);
  }, [runTurn]);

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      push('owner', trimmed);
      await runTurn(trimmed);
    },
    [push, runTurn],
  );

  const sendAudio = useCallback(
    async (fileUri: string) => {
      setStatus('sending');
      setError(null);
      let result: TranscribeOutcome;
      try {
        result = await depsRef.current.transcribe(fileUri);
      } catch {
        if (!mounted.current) return;
        setError({ message: TRANSCRIBE_FAILED_COPY, action: 'none' });
        setStatus('ready');
        return;
      }
      if (!mounted.current) return;
      if ('notConfigured' in result) {
        setSttUnavailable(true);
        setError({ message: STT_UNAVAILABLE_COPY, action: 'none' });
        setStatus('ready');
        return;
      }
      if (!result.transcript.trim()) {
        setError({ message: NOT_HEARD_COPY, action: 'none' });
        setStatus('ready');
        return;
      }
      await sendText(result.transcript);
    },
    [sendText],
  );

  const hush = useCallback(() => {
    speechGen.current += 1;
  }, []);

  /** Wait for the identity step to finish executing after approval. */
  const awaitIdentity = useCallback(async () => {
    const { identityDone, wait = defaultWait } = depsRef.current;
    let lastKnown: boolean | null = null;
    for (let attempt = 0; attempt < SAVE_POLL_ATTEMPTS; attempt += 1) {
      let done: boolean | null;
      try {
        done = await identityDone();
      } catch {
        done = null;
      }
      if (!mounted.current) return;
      if (done === true) {
        setStatus('finished');
        return;
      }
      lastKnown = done;
      await wait(SAVE_POLL_INTERVAL_MS);
      if (!mounted.current) return;
    }
    setError({ message: lastKnown === null ? STATUS_UNKNOWN_COPY : SAVE_SLOW_COPY, action: 'check_again' });
  }, []);

  /** `reconcile`: a retry. The last attempt may have gone through, so only re-approve what still waits. */
  const save = useCallback(async (reconcile = false) => {
    let ids = proposalIds;
    setStatus('saving');
    setError(null);
    if (reconcile) {
      const waiting = await depsRef.current.stillAwaiting(ids);
      if (!mounted.current) return;
      if (waiting === null) {
        setError({ message: SAVE_CHECK_FAILED_COPY, action: 'retry_save' });
        setStatus('review');
        return;
      }
      if (waiting.length === 0) {
        await awaitIdentity();
        return;
      }
      ids = waiting;
      setProposalIds(waiting);
    }
    let result: BatchApproveResult;
    try {
      result = await depsRef.current.approve(ids);
    } catch {
      if (!mounted.current) return;
      setError({ message: SAVE_FAILED_COPY, action: 'retry_save' });
      setStatus('review');
      return;
    }
    if (!mounted.current) return;
    if (result.failed.length > 0) {
      // Keep only what is still waiting, so "Try again" never re-sends an approved item.
      setProposalIds(result.failed.map((f) => f.id));
      setError({ message: approvalFailureCopy(result.failed), action: 'retry_save' });
      setStatus('review');
      return;
    }
    await awaitIdentity();
  }, [proposalIds, awaitIdentity]);

  const recover = useCallback(async () => {
    const action = error?.action;
    if (action === 'retry_turn') {
      await retryTurn();
    } else if (action === 'restart') {
      sessionId.current = undefined;
      setTurns([]);
      await runTurn(undefined);
    } else if (action === 'retry_save') {
      await save(true);
    } else if (action === 'check_again') {
      setError(null);
      await awaitIdentity();
    }
  }, [error, retryTurn, runTurn, save, awaitIdentity]);

  return { status, turns, proposalIds, error, sttUnavailable, sendText, sendAudio, hush, recover, save: () => save() };
}
