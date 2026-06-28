import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MarketingCampaignsSheet,
  type MarketingCampaignsSheetApi,
} from './MarketingCampaignsSheet';
import type { Campaign } from '../../api/marketing';

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: 'c1',
  tenantId: 'tn',
  name: 'Spring promo',
  subject: '20% off',
  bodyText: 'Book now',
  bodyHtml: null,
  segmentTag: null,
  status: 'draft',
  recipientCount: 0,
  sentCount: 0,
  failedCount: 0,
  sentAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<MarketingCampaignsSheetApi> = {}): MarketingCampaignsSheetApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(campaign()),
    send: vi.fn().mockResolvedValue(campaign({ status: 'sent', sentCount: 3 })),
    ...over,
  };
}

describe('MarketingCampaignsSheet (MKT)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists campaigns with send results', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([campaign({ status: 'sent', sentCount: 5 })]),
    });
    render(<MarketingCampaignsSheet onClose={() => {}} api={api} />);
    expect(await screen.findByText('Spring promo')).toBeInTheDocument();
    expect(screen.getByText(/Sent to 5/)).toBeInTheDocument();
  });

  it('creates a campaign with an optional segment', async () => {
    const api = mockApi();
    render(<MarketingCampaignsSheet onClose={() => {}} api={api} />);
    fireEvent.change(await screen.findByLabelText('Campaign name'), {
      target: { value: 'Summer' },
    });
    fireEvent.change(screen.getByLabelText('Email subject'), { target: { value: 'Hot deals' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Body copy' } });
    fireEvent.change(screen.getByLabelText('Segment tag'), { target: { value: 'vip' } });
    fireEvent.click(screen.getByText('Create campaign'));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        name: 'Summer',
        subject: 'Hot deals',
        bodyText: 'Body copy',
        segmentTag: 'vip',
      }),
    );
  });

  it('blocks creating without required fields', async () => {
    const api = mockApi();
    render(<MarketingCampaignsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByText('Create campaign'));
    expect(await screen.findByText(/Name, subject, and message are required/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('sends a draft campaign', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([campaign()]) });
    render(<MarketingCampaignsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByText('Send'));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('c1'));
  });
});
