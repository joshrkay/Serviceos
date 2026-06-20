import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { type ReviewProposal, undoSecondsLeft } from '../proposals/proposalReview';

export type { ReviewProposal };

export type ReviewPhase =
  | 'loading'
  | 'review'
  | 'approving'
  | 'approved' // within the undo window
  | 'undoing'
  | 'undone'
  | 'committed' // undo window elapsed; the action will execute
  | 'error';

export interface UseProposalReviewResult {
  proposal: ReviewProposal | null;
  phase: ReviewPhase;
  error: string | null;
  /** Whole seconds left in the undo window (0 outside 'approved'). */
  secondsLeft: number;
  approve: () => Promise<void>;
  undo: () => Promise<void>;
  reload: () => Promise<void>;
}

function normalize(raw: Record<string, unknown>): ReviewProposal {
  return {
    id: String(raw.id ?? ''),
    proposalType: String(raw.proposalType ?? ''),
    status: String(raw.status ?? ''),
    summary: String(raw.summary ?? ''),
    explanation: typeof raw.explanation === 'string' ? raw.explanation : undefined,
    confidenceScore: typeof raw.confidenceScore === 'number' ? raw.confidenceScore : undefined,
    payload:
      raw.payload && typeof raw.payload === 'object'
        ? (raw.payload as Record<string, unknown>)
        : undefined,
    approvedAt: typeof raw.approvedAt === 'string' ? raw.approvedAt : null,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Please retry.';
}

/**
 * Drives the proposal review + 5-second-undo screen: GET the proposal, POST
 * approve, then a countdown over the server's `approvedAt` during which POST
 * undo can reverse it. After the window the action commits (the worker executes
 * it server-side) and the owner is notified — never auto-executed before then.
 */
export function useProposalReview(id: string): UseProposalReviewResult {
  const api = useApiClient();
  const [proposal, setProposal] = useState<ReviewProposal | null>(null);
  const [phase, setPhase] = useState<ReviewPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const approvedAtRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const res = await api(`/api/proposals/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProposal(normalize(await res.json()));
      setPhase('review');
    } catch (e) {
      setError(message(e));
      setPhase('error');
    }
  }, [api, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const approve = useCallback(async () => {
    setPhase('approving');
    setError(null);
    try {
      const res = await api(`/api/proposals/${id}/approve`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // POST /:id/approve returns the approved Proposal directly (res.json of
      // approveProposal's result). Support a { approved: [...] } wrapper too in
      // case a chained/batch path is ever routed here.
      const body = (await res.json()) as Record<string, unknown>;
      const approvedRaw = Array.isArray(body.approved) ? body.approved[0] : body;
      if (!approvedRaw || typeof approvedRaw !== 'object') {
        throw new Error('This proposal could not be approved.');
      }
      const p = normalize(approvedRaw as Record<string, unknown>);
      setProposal(p);
      approvedAtRef.current = p.approvedAt ?? new Date().toISOString();
      setPhase('approved');
    } catch (e) {
      setError(message(e));
      setPhase('error');
    }
  }, [api, id]);

  const undo = useCallback(async () => {
    setPhase('undoing');
    setError(null);
    try {
      const res = await api(`/api/proposals/${id}/undo`, { method: 'POST' });
      if (!res.ok) {
        // 409 = window already closed server-side; the action will execute.
        if (res.status === 409) {
          setPhase('committed');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      setProposal(normalize(await res.json()));
      setPhase('undone');
    } catch (e) {
      setError(message(e));
      setPhase('error');
    }
  }, [api, id]);

  // Tick the undo countdown while approved; commit when it reaches zero.
  useEffect(() => {
    if (phase !== 'approved') return;
    const tick = () => {
      const left = undoSecondsLeft(approvedAtRef.current, Date.now());
      setSecondsLeft(left);
      if (left <= 0) setPhase('committed');
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [phase]);

  return { proposal, phase, error, secondsLeft, approve, undo, reload };
}
