import { useEffect } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OnboardingStepStatus } from '../../../types/onboarding';
import { callArrived, useTestCallArrival } from './test-call-arrival';

describe('callArrived', () => {
  it('is true only when a step that was waiting is seen to have become done', () => {
    expect(callArrived('current', 'done')).toBe(true);
    expect(callArrived('pending', 'done')).toBe(true);
    expect(callArrived('skipped', 'done')).toBe(true);
    expect(callArrived('error', 'done')).toBe(true);
  });

  it('is false for a step that was already done when first seen (a resumed visit), or is not done', () => {
    expect(callArrived(null, 'done')).toBe(false);
    expect(callArrived('done', 'done')).toBe(false);
    expect(callArrived('current', 'current')).toBe(false);
    expect(callArrived('current', 'skipped')).toBe(false);
    expect(callArrived('current', null)).toBe(false);
  });
});

describe('useTestCallArrival', () => {
  function watch(first: OnboardingStepStatus | null) {
    return renderHook(({ status }) => useTestCallArrival(status), { initialProps: { status: first } });
  }

  it('turns true the render the step flips to done, and stays true', () => {
    const view = watch('current');
    expect(view.result.current).toBe(false);
    act(() => view.rerender({ status: 'done' }));
    expect(view.result.current).toBe(true);
    act(() => view.rerender({ status: 'done' }));
    expect(view.result.current).toBe(true);
  });

  it('is already true in the first committed render that shows the step done, so nothing can navigate away before the shell knows', () => {
    const committed: Array<{ status: OnboardingStepStatus | null; arrived: boolean }> = [];
    function Probe({ status }: { status: OnboardingStepStatus | null }) {
      const arrived = useTestCallArrival(status);
      useEffect(() => {
        committed.push({ status, arrived });
      });
      return null;
    }
    const view = render(<Probe status="current" />);
    view.rerender(<Probe status="done" />);
    expect(committed).toEqual([
      { status: 'current', arrived: false },
      { status: 'done', arrived: true },
    ]);
  });

  it('does not replay on a resumed visit: first seen as done is not an arrival', () => {
    const view = watch(null);
    act(() => view.rerender({ status: 'done' }));
    expect(view.result.current).toBe(false);
  });

  it('stays false for the first status it sees, whatever that is', () => {
    expect(watch('done').result.current).toBe(false);
    expect(watch('current').result.current).toBe(false);
  });

  it('is false while the status is still loading, then waiting, then done: only the flip counts', () => {
    const view = watch(null);
    act(() => view.rerender({ status: 'pending' }));
    act(() => view.rerender({ status: 'current' }));
    expect(view.result.current).toBe(false);
    act(() => view.rerender({ status: 'done' }));
    expect(view.result.current).toBe(true);
  });
});
