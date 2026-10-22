import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DripCampaignsSheet, buildSteps, type DripCampaignsSheetApi } from './DripCampaignsSheet';
import type { DripSequence } from '../../api/drip-campaigns';

const sequence = (over: Partial<DripSequence> = {}): DripSequence => ({
  id: 's1',
  name: 'Win back',
  targetKind: 'lapsed_customers',
  targetDays: 180,
  steps: [{ channel: 'sms', delayMinutes: 0, body: 'Hi' }],
  status: 'paused',
  stats: { sequenceId: 's1', enrolled: 4, active: 3, completed: 1, booked: 2 },
  ...over,
});

function mockApi(over: Partial<DripCampaignsSheetApi> = {}): DripCampaignsSheetApi {
  return {
    status: vi.fn().mockResolvedValue({ enabled: true }),
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(sequence()),
    setRunning: vi.fn().mockResolvedValue(sequence({ status: 'active' })),
    enroll: vi.fn().mockResolvedValue({ enrolled: 5 }),
    ...over,
  };
}

describe('DripCampaignsSheet (#1735)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('explains itself and hides the builder when the feature flag is off', async () => {
    const api = mockApi({ status: vi.fn().mockResolvedValue({ enabled: false }) });
    render(<DripCampaignsSheet onClose={() => {}} api={api} />);
    expect(await screen.findByText(/not turned on/i)).toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Campaign name')).not.toBeInTheDocument();
  });

  it('lists campaigns with enrollment and booking counts', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([sequence()]) });
    render(<DripCampaignsSheet onClose={() => {}} api={api} />);
    expect(await screen.findByText('Win back')).toBeInTheDocument();
    expect(screen.getByText(/4 enrolled · 3 in progress · 2 booked/)).toBeInTheDocument();
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
  });

  it('resumes a paused campaign and adds matching customers', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([sequence()]) });
    render(<DripCampaignsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.setRunning).toHaveBeenCalledWith('s1', true));
    fireEvent.click(screen.getByRole('button', { name: 'Add matching customers' }));
    await waitFor(() => expect(api.enroll).toHaveBeenCalledWith('s1'));
  });

  it('creates a campaign from the form', async () => {
    const api = mockApi();
    render(<DripCampaignsSheet onClose={() => {}} api={api} />);
    fireEvent.change(await screen.findByLabelText('Campaign name'), { target: { value: 'Spring' } });
    fireEvent.change(screen.getByLabelText('Step 1 message'), { target: { value: 'Hi {{firstName}}' } });
    fireEvent.change(screen.getByLabelText('Step 1 wait (hours)'), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        name: 'Spring',
        targetKind: 'lapsed_customers',
        steps: [{ channel: 'sms', delayMinutes: 1440, body: 'Hi {{firstName}}' }],
      }),
    );
  });

  it('creates a membership-renewal campaign and labels it in the list', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([sequence({ name: 'Renew club', targetKind: 'membership_renewals', targetDays: 30 })]),
    });
    render(<DripCampaignsSheet onClose={() => {}} api={api} />);
    expect(await screen.findByText(/Membership renewals · 1 step/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Renew' } });
    fireEvent.change(screen.getByLabelText('Who to follow up with'), { target: { value: 'membership_renewals' } });
    fireEvent.change(screen.getByLabelText('Step 1 message'), { target: { value: 'Your club renews soon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Renew', targetKind: 'membership_renewals' })),
    );
  });

  it('refuses to create without a name or a message', async () => {
    const api = mockApi();
    render(<DripCampaignsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create campaign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/name/i);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('mobile class contract: every control is a >=44px target and the sheet cannot overflow sideways', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([sequence()]) });
    render(<DripCampaignsSheet onClose={() => {}} api={api} />);
    await screen.findByText('Win back');
    for (const name of ['Resume', 'Add matching customers', 'Add step', 'Create campaign', 'Close']) {
      const cls = screen.getByRole('button', { name }).className;
      expect(cls, name).toMatch(/min-h-11|size-11/);
    }
    for (const label of ['Campaign name', 'Who to follow up with', 'Step 1 type', 'Step 1 wait (hours)']) {
      expect(screen.getByLabelText(label).className, label).toContain('min-h-11');
    }
    const sheet = screen.getByTestId('drip-sheet');
    expect(sheet.className).toContain('min-w-0');
    expect(sheet.className).toContain('overflow-x-hidden');
    expect(sheet.className).not.toMatch(/\bw-\[\d+px\]/);
  });
});

describe('buildSteps', () => {
  const base = { delayHours: '0', text: '', subject: '', agentPhone: '' };

  it('converts hours to minutes and validates each channel', () => {
    expect(buildSteps([{ ...base, channel: 'sms', delayHours: '1.5', text: ' Hi ' }])).toEqual({
      steps: [{ channel: 'sms', delayMinutes: 90, body: 'Hi' }],
    });
    expect(buildSteps([{ ...base, channel: 'email', text: 'b' }])).toHaveProperty('error');
    expect(buildSteps([{ ...base, channel: 'call', agentPhone: '555' }])).toHaveProperty('error');
    expect(buildSteps([{ ...base, channel: 'call', agentPhone: '+15125550100' }])).toEqual({
      steps: [{ channel: 'call', delayMinutes: 0, agentPhone: '+15125550100' }],
    });
    expect(buildSteps([{ ...base, channel: 'sms', delayHours: '-1', text: 'x' }])).toHaveProperty('error');
  });
});
