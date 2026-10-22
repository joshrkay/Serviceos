/**
 * WebsiteCard — Settings → Website (D-044 / #1768). Mocks apiFetch for the
 * /api/tenant-site endpoints and asserts on the DOM.
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

beforeEach(() => apiFetchMock.mockReset());

describe('WebsiteCard', () => {
  it('suggests an address from the business name and offers to make a site', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ data: INFO }));
    render(<WebsiteCard />);
    expect(await screen.findByLabelText(/site address/i)).toHaveValue('joes-plumbing');
    expect(screen.getByText(/\.sites\.example\.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('hides the make-me-one block until hosted sites are switched on', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ data: { ...INFO, enabled: false, baseDomain: null } }));
    render(<WebsiteCard />);
    await screen.findByLabelText(/i have a website/i);
    expect(screen.queryByTestId('website-make-one')).toBeNull();
  });

  it('shows the server message when an address is taken', async () => {
    apiFetchMock
      .mockResolvedValueOnce(json({ data: INFO }))
      .mockResolvedValueOnce(
        json({ error: 'CONFLICT', message: 'That address is already taken. Pick another one' }, 409),
      );
    render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already taken');
  });

  it('previews in a sandboxed frame, then publishes', async () => {
    const draft = { slug: 'joes-plumbing', published: false, publishedAt: null, url: SITE_URL };
    const live = { ...draft, published: true, publishedAt: '2026-10-22T00:00:00Z' };
    apiFetchMock
      .mockResolvedValueOnce(json({ data: { ...INFO, site: draft } }))
      .mockResolvedValueOnce(json({ data: { html: '<p>hi</p>' } }))
      .mockResolvedValueOnce(json({ data: live }))
      .mockResolvedValueOnce(json({ data: { ...INFO, websiteUrl: SITE_URL, site: live } }));
    render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByTestId('website-preview')).toHaveAttribute('sandbox', '');

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/tenant-site/publish',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByLabelText(/site address/i)).toBeDisabled();
  });

  it('keeps every button and field at least 44px tall (min-h-11)', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ data: INFO }));
    render(<WebsiteCard />);
    await screen.findByLabelText(/site address/i);
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0));
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
    }
    expect(screen.getByLabelText(/site address/i).className).toContain('min-h-11');
    expect(screen.getByLabelText(/i have a website/i).className).toContain('min-h-11');
  });
});
