// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// D2 / Open Question 6: there is no direct client-reachable expense-write route
// and `log_expense` is not on the POST /api/proposals mint whitelist, so this
// screen DEFERS to the sanctioned, human-approved voice path (mirroring the U5
// late-fee deferral). These tests pin that contract: the screen surfaces the
// voice affordance, never a form that writes an expense, and routes voice
// capture pre-scoped to this job.
const h = vi.hoisted(() => ({
  push: vi.fn(),
  id: 'job-1' as string | undefined,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: h.id }),
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
}));

// eslint-disable-next-line import/first
import JobExpenses from '../../app/jobs/[id]/expenses';

beforeEach(() => {
  vi.clearAllMocks();
  h.id = 'job-1';
});

afterEach(() => cleanup());

describe('Job expenses screen (D2 voice-deferred capture)', () => {
  it('surfaces the sanctioned voice path and confirms captures land in Approvals', () => {
    const { getByText } = render(createElement(JobExpenses));

    expect(getByText('Log an expense')).toBeTruthy();
    expect(getByText(/say it out loud/i)).toBeTruthy();
    expect(getByText(/Approvals/)).toBeTruthy();
    // No free-text form fields — capture is voice-only until a gated route lands.
    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('routes voice capture pre-scoped to this job on an explicit tap only', () => {
    const { getByText } = render(createElement(JobExpenses));

    // Nothing navigates just by rendering.
    expect(h.push).not.toHaveBeenCalled();

    fireEvent.click(getByText('Log by voice').closest('button')!);
    expect(h.push).toHaveBeenCalledWith({ pathname: '/voice', params: { jobId: 'job-1' } });
  });

  it('keeps the CTA a >=44px tap target', () => {
    const { getByText } = render(createElement(JobExpenses));

    const button = getByText('Log by voice').closest('button')!;
    expect(button.className).toMatch(/\bmin-h-11\b/);
    expect(button.className).not.toMatch(/\bmin-w-\[/);
  });

  it('disables the voice CTA when the job id is missing', () => {
    h.id = undefined;
    const { getByText } = render(createElement(JobExpenses));

    const button = getByText('Log by voice').closest('button')!;
    fireEvent.click(button);
    expect(h.push).not.toHaveBeenCalled();
    expect(button.className).toMatch(/\bopacity-50\b/);
  });
});
