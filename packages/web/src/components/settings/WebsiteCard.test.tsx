/**
 * WebsiteCard — Settings → Website (D-044 / #1768, #1769). Mocks apiFetch by
 * URL for the /api/tenant-site and /api/proposals endpoints and asserts on the
 * DOM.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebsiteCard } from './WebsiteCard';

const apiFetchMock = vi.fn();

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SITE_URL = 'https://joes-plumbing.sites.example.com';

const INFO = {
  enabled: true,
  baseDomain: 'sites.example.com',
  site: null,
  suggestedSlug: 'joes-plumbing',
  websiteUrl: null,
};

const NO_ABOUT = { current: null, pending: null };

type Handler = (init?: RequestInit) => Response | Promise<Response>;

/** Answers each request by "METHOD path"; anything unlisted is a 404. */
function serve(routes: Record<string, Handler | Response | unknown>) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    const hit = routes[key];
    if (hit === undefined) return json({ message: `no route ${key}` }, 404);
    if (typeof hit === 'function') return (hit as Handler)(init);
    if (hit instanceof Response) return hit;
    return json({ data: hit });
  });
}

const calls = () => apiFetchMock.mock.calls.map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path as string}`);

beforeEach(() => apiFetchMock.mockReset());

describe('WebsiteCard', () => {
  it('suggests an address from the business name and offers to make a site', async () => {
    serve({ 'GET /api/tenant-site': INFO, 'GET /api/tenant-site/about': NO_ABOUT });
    render(<WebsiteCard />);
    expect(await screen.findByLabelText(/site address/i)).toHaveValue('joes-plumbing');
    expect(screen.getByText(/\.sites\.example\.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('hides the make-me-one block until hosted sites are switched on', async () => {
    serve({
      'GET /api/tenant-site': { ...INFO, enabled: false, baseDomain: null },
      'GET /api/tenant-site/about': NO_ABOUT,
    });
    render(<WebsiteCard />);
    await screen.findByLabelText(/i have a website/i);
    expect(screen.queryByTestId('website-make-one')).toBeNull();
  });

  it('shows the server message when an address is taken', async () => {
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': NO_ABOUT,
      'PUT /api/tenant-site/address': json(
        { error: 'CONFLICT', message: 'That address is already taken. Pick another one' },
        409,
      ),
    });
    render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already taken');
  });

  it('previews in a sandboxed frame, then publishes', async () => {
    const draft = { slug: 'joes-plumbing', published: false, publishedAt: null, url: SITE_URL };
    const live = { ...draft, published: true, publishedAt: '2026-10-22T00:00:00Z' };
    let published = false;
    serve({
      'GET /api/tenant-site': () => json({ data: { ...INFO, site: published ? live : draft } }),
      'GET /api/tenant-site/about': NO_ABOUT,
      'GET /api/tenant-site/preview': { html: '<p>hi</p>' },
      'POST /api/tenant-site/publish': () => {
        published = true;
        return json({ data: live });
      },
    });
    render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByTestId('website-preview')).toHaveAttribute('sandbox', '');

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
    expect(calls()).toContain('POST /api/tenant-site/publish');
    expect(screen.getByLabelText(/site address/i)).toBeDisabled();
  });

  it('keeps every button and field at least 44px tall (min-h-11)', async () => {
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': { current: null, pending: { proposalId: 'p-1', aboutText: 'Draft text.' } },
    });
    render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);
    await screen.findByLabelText(/draft \(edit it/i);
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0));
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
    }
    for (const field of [/site address/i, /i have a website/i, /draft \(edit it/i]) {
      expect(screen.getByLabelText(field).className).toContain('min-h-11');
    }
  });
});

describe('WebsiteCard — AI-drafted about text (#1769)', () => {
  const PENDING = { current: null, pending: { proposalId: 'p-1', aboutText: 'We fix pipes in Austin.' } };

  it('shows an empty state with a draft button when there is no about text', async () => {
    serve({ 'GET /api/tenant-site': INFO, 'GET /api/tenant-site/about': NO_ABOUT });
    render(<WebsiteCard />);
    expect(await screen.findByTestId('website-about-empty')).toHaveTextContent('no About section');
    expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeInTheDocument();
  });

  it('drafting shows the proposal text for the owner to read, with nothing approved yet', async () => {
    let drafted = false;
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': () => json({ data: drafted ? PENDING : NO_ABOUT }),
      'POST /api/tenant-site/about/draft': () => {
        drafted = true;
        return json({ data: { proposalId: 'p-1', aboutText: 'We fix pipes in Austin.' } }, 201);
      },
    });
    render(<WebsiteCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft with AI' }));
    expect(await screen.findByLabelText(/draft \(edit it/i)).toHaveValue('We fix pipes in Austin.');
    expect(calls().some((c) => c.includes('/approve'))).toBe(false);
  });

  it('approving as drafted approves without an edit call', async () => {
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': PENDING,
      'POST /api/proposals/p-1/approve': { id: 'p-1', status: 'approved' },
    });
    render(<WebsiteCard />);
    await screen.findByLabelText(/draft \(edit it/i);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Approved');
    expect(calls()).toContain('POST /api/proposals/p-1/approve');
    expect(calls().some((c) => c.startsWith('PUT /api/proposals'))).toBe(false);
  });

  it('an owner edit is saved before the approval', async () => {
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': PENDING,
      'PUT /api/proposals/p-1': { proposal: {}, editedFields: ['aboutText'] },
      'POST /api/proposals/p-1/approve': { id: 'p-1', status: 'approved' },
    });
    render(<WebsiteCard />);
    const box = await screen.findByLabelText(/draft \(edit it/i);
    fireEvent.change(box, { target: { value: 'Family-run plumbers in Austin.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('status');

    const order = calls().filter((c) => c.includes('/api/proposals/'));
    expect(order).toEqual(['PUT /api/proposals/p-1', 'POST /api/proposals/p-1/approve']);
    const put = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
      edits: { aboutText: 'Family-run plumbers in Austin.' },
    });
  });

  it('a failed edit does not approve', async () => {
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': PENDING,
      'PUT /api/proposals/p-1': json({ error: 'VALIDATION_ERROR' }, 400),
    });
    render(<WebsiteCard />);
    const box = await screen.findByLabelText(/draft \(edit it/i);
    fireEvent.change(box, { target: { value: 'x'.repeat(10) } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls()).toContain('PUT /api/proposals/p-1'));
    expect(calls()).not.toContain('POST /api/proposals/p-1/approve');
  });

  it('discarding rejects the draft and leaves the site without an about section', async () => {
    let rejected = false;
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': () => json({ data: rejected ? NO_ABOUT : PENDING }),
      'POST /api/proposals/p-1/reject': () => {
        rejected = true;
        return json({ id: 'p-1', status: 'rejected' });
      },
    });
    render(<WebsiteCard />);
    await screen.findByLabelText(/draft \(edit it/i);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByTestId('website-about-empty')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('without an About section');
  });

  it('shows the approved about text', async () => {
    serve({
      'GET /api/tenant-site': INFO,
      'GET /api/tenant-site/about': { current: 'Family-run plumbers in Austin.', pending: null },
    });
    render(<WebsiteCard />);
    expect(await screen.findByTestId('website-about-current')).toHaveTextContent('Family-run plumbers');
    expect(screen.getByRole('button', { name: 'Draft a new one' })).toBeInTheDocument();
  });
});

describe('WebsiteCard — connect a domain you own (#1770)', () => {
  const RECORD = { type: 'CNAME', host: 'www.joesplumbing.com', value: 'joes-plumbing.sites.example.com' };
  const domain = (over: Record<string, unknown> = {}) => ({
    domain: 'www.joesplumbing.com',
    status: 'pending_dns',
    verified: false,
    record: RECORD,
    error: null,
    checkedAt: null,
    verifiedAt: null,
    url: 'https://www.joesplumbing.com',
    ...over,
  });
  const info = (siteDomain: unknown, over: Record<string, unknown> = {}) => ({
    ...INFO,
    domainConnectEnabled: true,
    site: { slug: 'joes-plumbing', published: true, publishedAt: null, url: SITE_URL, domain: siteDomain },
    ...over,
  });

  it('is hidden when no certificate provider is configured, or there is no site yet', async () => {
    serve({ 'GET /api/tenant-site': info(null, { domainConnectEnabled: false }), 'GET /api/tenant-site/about': NO_ABOUT });
    const { unmount } = render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);
    expect(screen.queryByTestId('website-domain')).not.toBeInTheDocument();
    unmount();

    serve({ 'GET /api/tenant-site': { ...INFO, domainConnectEnabled: true }, 'GET /api/tenant-site/about': NO_ABOUT });
    render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);
    expect(screen.queryByTestId('website-domain')).not.toBeInTheDocument();
  });

  it('connects a domain: sends it, then shows the one record to add', async () => {
    let current: unknown = null;
    serve({
      'GET /api/tenant-site': () => json({ data: info(current) }),
      'GET /api/tenant-site/about': NO_ABOUT,
      'PUT /api/tenant-site/domain': (init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({ domain: 'www.joesplumbing.com' });
        current = domain({ error: { code: 'dns_missing', message: "We can't find the CNAME record yet." } });
        return json({ data: {} });
      },
    });
    render(<WebsiteCard />);
    fireEvent.change(await screen.findByLabelText(/your domain/i), { target: { value: 'www.joesplumbing.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByTestId('website-domain-record')).toHaveTextContent('joes-plumbing.sites.example.com');
    expect(screen.getByTestId('website-domain-status')).toHaveTextContent('Waiting for your DNS record');
    expect(screen.getByTestId('website-domain-error')).toHaveTextContent("can't find the CNAME");
  });

  it('shows a refusal from the server in plain words', async () => {
    serve({
      'GET /api/tenant-site': info(null),
      'GET /api/tenant-site/about': NO_ABOUT,
      'PUT /api/tenant-site/domain': json({ message: 'Use a name like www.yourbusiness.com.' }, 400),
    });
    render(<WebsiteCard />);
    fireEvent.change(await screen.findByLabelText(/your domain/i), { target: { value: 'yourbusiness.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByTestId('website-domain-problem')).toHaveTextContent('Use a name like www.yourbusiness.com.');
  });

  it('checks again and removes', async () => {
    serve({
      'GET /api/tenant-site': info(domain({ status: 'failed', error: { code: 'dns_wrong', message: 'It points somewhere else.' } })),
      'GET /api/tenant-site/about': NO_ABOUT,
      'POST /api/tenant-site/domain/check': { ok: true },
      'DELETE /api/tenant-site/domain': { ok: true },
    });
    render(<WebsiteCard />);
    expect(await screen.findByTestId('website-domain-status')).toHaveTextContent('Needs your attention');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(calls()).toContain('POST /api/tenant-site/domain/check'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls()).toContain('DELETE /api/tenant-site/domain'));
  });

  it('a verified domain says verified and secure, with no record to add', async () => {
    serve({
      'GET /api/tenant-site': info(domain({ status: 'verified', verified: true, verifiedAt: '2026-10-22T12:00:00Z' })),
      'GET /api/tenant-site/about': NO_ABOUT,
    });
    render(<WebsiteCard />);
    expect(await screen.findByTestId('website-domain-status')).toHaveTextContent('Verified and secure');
    expect(screen.queryByTestId('website-domain-record')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://www.joesplumbing.com' })).toBeInTheDocument();
  });

  it('keeps every domain button and field at least 44px tall (min-h-11)', async () => {
    serve({ 'GET /api/tenant-site': info(null), 'GET /api/tenant-site/about': NO_ABOUT });
    const first = render(<WebsiteCard />);
    const section = await screen.findByTestId('website-domain');
    for (const el of [...section.querySelectorAll('button'), ...section.querySelectorAll('input')]) {
      expect(el.className).toContain('min-h-11');
    }
    first.unmount();

    serve({
      'GET /api/tenant-site': info(domain({ error: { code: 'dns_missing', message: 'x' } })),
      'GET /api/tenant-site/about': NO_ABOUT,
    });
    render(<WebsiteCard />);
    const withDomain = await screen.findByTestId('website-domain-state');
    expect(withDomain.querySelectorAll('button').length).toBe(3);
    for (const button of withDomain.querySelectorAll('button')) {
      expect(button.className).toContain('min-h-11');
    }
    // Long values wrap instead of widening the page.
    expect(screen.getByTestId('website-domain-record').innerHTML).toContain('break-all');
  });
});
