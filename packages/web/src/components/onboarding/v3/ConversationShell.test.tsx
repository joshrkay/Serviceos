/**
 * ConversationShell against the real hooks with the network stubbed at `fetch`.
 * The draft is a fixture captured from the API (pinned to the shared contract
 * in __fixtures__), so the screens render what the API really sends.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plumbingCleDraftJson } from './__fixtures__';
import { _resetOnboardingStatusCacheForTests } from '../../../hooks/useOnboardingStatus';

const track = vi.hoisted(() => ({ trackFunnel: vi.fn(), track: vi.fn() }));
vi.mock('../../../lib/analytics', () => track);
vi.mock('../../../hooks/useUndoableApproval', () => ({ UNDO_WINDOW_MS: 200 }));
vi.mock('../v2/OnboardingShell', () => ({ OnboardingShell: () => <div>v2 shell</div> }));
vi.mock('../v2/steps/BillingStep', () => ({ BillingStep: () => <div>billing step</div> }));

import { ConversationShell } from './ConversationShell';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const draftJson = plumbingCleDraftJson as Record<string, unknown>;
const approvedJson = { ...draftJson, status: 'approved', version: 2, proposalIds: IDS, approvedAt: '2026-10-18T10:05:00.000Z' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function statusBody(over: Record<string, unknown> = {}) {
  return { steps: [], currentStep: 'identity', isComplete: false, voiceAgentLive: false, tenantId: TENANT, subscriptionStatus: null, ...over };
}

interface Server {
  draft: Record<string, unknown> | null;
  status: Record<string, unknown>;
}

let server: Server;
let requests: Array<{ method: string; path: string; body: unknown }>;

const resolved = (r: Response) => Promise.resolve(r);

function stubNetwork(initial: Server) {
  server = initial;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, path, body });
      if (path === '/api/onboarding/status') return resolved(json(200, server.status));
      if (path === '/api/onboarding/draft' && method === 'GET') {
        return resolved(
          server.draft ? json(200, { draft: server.draft }) : json(404, { error: 'NOT_FOUND', message: 'OnboardingDraft not found' }),
        );
      }
      if (path === '/api/onboarding/draft' && method === 'POST') {
        server.draft = server.draft ?? draftJson;
        return resolved(json(201, { draft: server.draft, created: true }));
      }
      if (path === '/api/onboarding/draft/approve' && method === 'POST') {
        server.draft = approvedJson;
        return resolved(json(200, { draft: approvedJson, proposalIds: IDS, approvedNow: true }));
      }
      throw new Error(`unexpected request ${method} ${path}`);
    }),
  );
}

function renderShell(url = '/onboarding') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/onboarding" element={<ConversationShell />} />
        <Route path="/" element={<div>home page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const draftCalls = () => requests.filter((r) => r.path.startsWith('/api/onboarding/draft')).map((r) => `${r.method} ${r.path}`);

describe('ConversationShell', () => {
  beforeEach(() => {
    _resetOnboardingStatusCacheForTests();
    track.trackFunnel.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on the finished shop when a draft exists, with the header and progress line', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    renderShell();

    expect(await screen.findByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    expect(screen.getByText('About 6 minutes left')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '15');
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
    expect(draftCalls()).toEqual(['GET /api/onboarding/draft']);
    await waitFor(() =>
      expect(track.trackFunnel).toHaveBeenCalledWith(
        'v3_ready_viewed',
        expect.objectContaining({ tenantId: TENANT }),
        expect.objectContaining({ trade: 'plumbing', metro: 'CLE' }),
      ),
    );
  });

  it('goes from Ready to the read-back, then approves with one tap and shows the two saved changes', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Make it mine, 7 choices' }));
    expect(await screen.findByRole('heading', { level: 1, name: "Here's what I've got." })).toBeInTheDocument();
    expect(screen.getByText('Waiting for your OK')).toBeInTheDocument();
    expect(screen.getByText('About 5 minutes left')).toBeInTheDocument();
    expect(track.trackFunnel).toHaveBeenCalledWith('v3_readback_viewed', expect.anything(), expect.anything());
    expect(draftCalls()).not.toContain('POST /api/onboarding/draft/approve');

    await userEvent.click(screen.getByRole('button', { name: "That's right" }));

    expect(await screen.findByText('Saving 2 changes. They go live in a few seconds.')).toBeInTheDocument();
    expect(draftCalls()).toContain('POST /api/onboarding/draft/approve');
    expect(track.trackFunnel).toHaveBeenCalledWith('v3_approved', expect.anything(), expect.objectContaining({ proposal_count: 2 }));
    expect(track.trackFunnel.mock.calls.filter(([e]) => e === 'v3_approved')).toHaveLength(1);
  });

  it('skips the choices from "Looks right as is" straight to the read-back', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: 'Looks right as is, skip the choices' }));
    expect(await screen.findByRole('heading', { level: 1, name: "Here's what I've got." })).toBeInTheDocument();
  });

  it('after the saving window continues into the existing billing step once the choices are live', async () => {
    stubNetwork({ draft: draftJson, status: statusBody({ currentStep: 'billing' }) });
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: 'Looks right as is, skip the choices' }));
    await userEvent.click(await screen.findByRole('button', { name: "That's right" }));

    expect(await screen.findByText(/Saving 2 changes/)).toBeInTheDocument();
    expect(await screen.findByText('billing step')).toBeInTheDocument();
    expect(screen.getByText('About 3 minutes left')).toBeInTheDocument();
  });

  it('keeps waiting, not guessing, while the saved choices have not gone live yet', async () => {
    stubNetwork({ draft: approvedJson, status: statusBody({ currentStep: 'identity' }) });
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: 'Getting your shop ready.' })).toBeInTheDocument();
    expect(screen.queryByText('billing step')).not.toBeInTheDocument();
    expect(screen.queryByText('v2 shell')).not.toBeInTheDocument();
  });

  it('resumes an already-saved shop at billing with no saving window', async () => {
    stubNetwork({ draft: approvedJson, status: statusBody({ currentStep: 'billing' }) });
    renderShell();
    expect(await screen.findByText('billing step')).toBeInTheDocument();
    expect(screen.queryByText(/Saving 2 changes/)).not.toBeInTheDocument();
  });

  it('hands the rest of setup to the existing steps once billing is done', async () => {
    stubNetwork({ draft: approvedJson, status: statusBody({ currentStep: 'phone' }) });
    renderShell();
    expect(await screen.findByText('v2 shell')).toBeInTheDocument();
  });

  it('resumes on the read-back when answers are already staged', async () => {
    stubNetwork({ draft: { ...draftJson, version: 2, choices: { greeting: { option: 'b' } } }, status: statusBody() });
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: "Here's what I've got." })).toBeInTheDocument();
    expect(screen.getByText("Thanks for calling Walsh Plumbing. What's going on today?")).toBeInTheDocument();
  });

  it('asks what to answer as when there is no draft, then creates it with the browser timezone', async () => {
    stubNetwork({ draft: null, status: statusBody() });
    renderShell();

    expect(await screen.findByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh Plumbing');
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    await userEvent.type(screen.getByLabelText('Your cell'), '(216) 555-0142');
    await userEvent.click(screen.getByRole('button', { name: 'Show me my shop' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    const create = requests.find((r) => r.method === 'POST' && r.path === '/api/onboarding/draft');
    expect(create?.body).toEqual({
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      phone: '(216) 555-0142',
      ownerFirstName: 'Ada',
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('says so, and offers a retry, when the setup cannot be loaded', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === '/api/onboarding/status') return resolved(json(200, statusBody()));
        return resolved(json(500, { error: 'INTERNAL', message: 'boom' }));
      }),
    );
    renderShell();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent("I couldn't load your setup.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('sends a finished setup home', async () => {
    stubNetwork({ draft: approvedJson, status: statusBody({ currentStep: null, isComplete: true }) });
    renderShell();
    expect(await screen.findByText('home page')).toBeInTheDocument();
  });

  it('opens the existing shell for an explicit re-run of setup', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    renderShell('/onboarding?rerun=1');
    expect(await screen.findByText('v2 shell')).toBeInTheDocument();
    expect(draftCalls()).toEqual([]);
  });

  it('never shows the owner a screen with more than one h1', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    const { container } = renderShell();
    await screen.findByRole('heading', { level: 1 });
    expect(within(container).getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
