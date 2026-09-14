import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EstimateForm } from './EstimateForm';

/**
 * #1146 — EstimateForm's job picker is a `<select required>`
 * (EstimateForm.tsx ~397-400) whose `<option>`s arrive asynchronously from
 * `useListQuery('/api/jobs', ...)`. Submitting while `jobsLoading` is still
 * true (or, after loading, with nothing selected) is blocked by the
 * browser's OWN native constraint-validation — a required `<select>` whose
 * current value is the empty-string placeholder option is invalid, so the
 * `submit` event never reaches `handleSubmit`, and `handleSubmit`'s own
 * `if (!form.jobId.trim()) setError('Job is required.')` check (already
 * written, EstimateForm.tsx ~273-276) never runs. The owner sees a dead
 * Submit button with no visible feedback at all.
 *
 * Fix: disable Submit (with a visible "Loading…" label) until the job
 * options have loaded, and put `noValidate` on the form so the app's own
 * validation — not the browser's silent native one — is what runs and is
 * shown when the select is empty on submit.
 */

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (url.startsWith('/api/jobs/')) {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    if (url.startsWith('/api/agreements')) {
      return { ok: true, status: 200, json: async () => [] } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }),
}));

// vi.hoisted so the apiClient mock factory (hoisted above imports) can close
// over a promise the test controls the resolution of — simulating the real
// race: the job list has not arrived yet when the owner hits Submit.
const harness = vi.hoisted(() => {
  let resolveJobs: ((body: { data: unknown[]; total: number }) => void) | null = null;
  const jobsPromise = new Promise<{ data: unknown[]; total: number }>((resolve) => {
    resolveJobs = resolve;
  });
  return { jobsPromise, resolveJobs: () => resolveJobs };
});

vi.mock('../../lib/apiClient', () => {
  const routedFetch = async (url: string): Promise<Response> => {
    if (url.startsWith('/api/jobs')) {
      const body = await harness.jobsPromise;
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  };
  return { useApiClient: () => routedFetch };
});

describe('EstimateForm — job-select submit feedback (#1146)', () => {
  it('disables Submit with a visible "Loading…" affordance until job options arrive', async () => {
    render(<EstimateForm />);

    const submitButton = screen.getByRole('button', { name: /Loading|Create estimate/ });
    // Before the jobs list resolves, Submit must not be a silently-dead
    // clickable button — it is disabled and says so.
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveTextContent(/Loading/i);

    await act(async () => {
      harness.resolveJobs()!({
        data: [{ id: 'job-1', jobNumber: 'J-1001', summary: 'AC repair', customerId: 'cust-1' }],
        total: 1,
      });
      await harness.jobsPromise;
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create estimate' })).toBeEnabled(),
    );
  });

  it('surfaces a visible "Job is required" message when submitted with nothing selected (no silent native block)', async () => {
    render(<EstimateForm />);

    await act(async () => {
      harness.resolveJobs()!({
        data: [{ id: 'job-1', jobNumber: 'J-1001', summary: 'AC repair', customerId: 'cust-1' }],
        total: 1,
      });
      await harness.jobsPromise;
    });

    const submitButton = await screen.findByRole('button', { name: 'Create estimate' });
    expect(submitButton).toBeEnabled();

    // Nothing selected — the job picker still shows its empty placeholder.
    fireEvent.click(submitButton);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Job is required.'));
  });
});
