// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@ai-service-os/shared';
import type { UseAssistantSession } from '../assistant/useAssistantSession';

const SUPERVISOR_ME: MeResponse = {
  user_id: 'user_clerk_owner',
  internal_user_id: '059f1a36-2d09-4698-954f-e640d61a9237',
  tenant_id: 'tenant-1',
  role: 'owner',
  can_field_serve: false,
  current_mode: 'supervisor',
  mode_changed_at: null,
  permissions: [],
  backup_supervisor_user_id: null,
  timezone: undefined,
  unsupervised_proposal_routing: 'queue_only',
};

const TECH_ME: MeResponse = {
  ...SUPERVISOR_ME,
  user_id: 'user_clerk_tech',
  role: 'technician',
  can_field_serve: true,
  current_mode: 'tech',
};

function baseSession(overrides: Partial<UseAssistantSession> = {}): UseAssistantSession {
  return {
    sessionId: 'sess-1',
    status: 'active',
    state: 'intent_capture',
    turns: [],
    proposalIds: [],
    error: null,
    sttUnavailable: false,
    start: vi.fn(),
    sendText: vi.fn(),
    sendAudio: vi.fn(),
    end: vi.fn(),
    ...overrides,
  };
}

const h = vi.hoisted(() => ({
  me: null as MeResponse | null,
  replace: vi.fn(),
  push: vi.fn(),
  session: null as unknown,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: h.replace }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({ me: h.me, isLoading: false, error: null, switchMode: vi.fn(), refetch: vi.fn() }),
}));
vi.mock('../assistant/useAssistantController', () => ({
  useAssistantController: () => h.session,
}));
vi.mock('../voice/useRecorder', () => ({
  useRecorder: () => ({
    startRecording: h.startRecording,
    stopRecording: h.stopRecording,
    cancel: h.cancel,
  }),
}));

// eslint-disable-next-line import/first
import AssistantScreen from '../../app/assistant';

beforeEach(() => {
  vi.clearAllMocks();
  h.me = { ...SUPERVISOR_ME };
  h.session = baseSession();
  h.stopRecording.mockResolvedValue('file:///turn.m4a');
});

afterEach(() => cleanup());

describe('Assistant screen', () => {
  it('renders the assistant surface for a supervisor', () => {
    const { getByText } = render(createElement(AssistantScreen));
    expect(getByText('Assistant')).toBeTruthy();
    expect(getByText('Hold to talk')).toBeTruthy();
  });

  it('redirects the technician persona to Today and renders nothing', () => {
    h.me = { ...TECH_ME };
    const { container } = render(createElement(AssistantScreen));
    expect(h.replace).toHaveBeenCalledWith('/(tabs)/today');
    expect(container.firstChild).toBeNull();
  });

  it('renders the conversation turns', () => {
    h.session = baseSession({
      turns: [
        { id: 't0', role: 'assistant', text: 'How can I help?' },
        { id: 't1', role: 'user', text: 'what is my balance' },
      ],
    });
    const { getByText } = render(createElement(AssistantScreen));
    expect(getByText('How can I help?')).toBeTruthy();
    expect(getByText('what is my balance')).toBeTruthy();
  });

  it('falls back to text input (no mic) when per-turn STT is unavailable (501)', () => {
    h.session = baseSession({ sttUnavailable: true });
    const { getByText, queryByText, getByPlaceholderText } = render(createElement(AssistantScreen));
    expect(getByText(/Voice isn't available/)).toBeTruthy();
    expect(queryByText('Hold to talk')).toBeNull();
    // Text input still works.
    const input = getByPlaceholderText('Type a message');
    fireEvent.change(input, { target: { value: 'invoice acme' } });
    fireEvent.click(getByText('Send').closest('button')!);
    expect((h.session as UseAssistantSession).sendText).toHaveBeenCalledWith('invoice acme');
  });

  it('deep-links a proposal chip into the existing review screen (F2 gate intact)', () => {
    h.session = baseSession({ proposalIds: ['prop-42'] });
    const { getAllByText } = render(createElement(AssistantScreen));
    const chip = getAllByText('Review proposal')[0].closest('button')!;
    fireEvent.click(chip);
    // Goes to the EXISTING /proposals/[id] review screen — no bespoke approve path.
    expect(h.push).toHaveBeenCalledWith('/proposals/prop-42');
  });

  it('shows a "start a new one" affordance for an expired (reaped) session', () => {
    h.session = baseSession({ status: 'expired' });
    const { getByText } = render(createElement(AssistantScreen));
    expect(getByText(/This session ended/)).toBeTruthy();
    fireEvent.click(getByText('Start a new one').closest('button')!);
    expect((h.session as UseAssistantSession).start).toHaveBeenCalledTimes(1);
  });

  it('sends a held voice turn through STT (transcribe → turn)', async () => {
    const { getByText } = render(createElement(AssistantScreen));
    const mic = getByText('Hold to talk').closest('button')!;
    fireEvent.mouseDown(mic);
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(mic);
    // stopRecording resolves the uri asynchronously, then sendAudio fires.
    await Promise.resolve();
    await Promise.resolve();
    expect((h.session as UseAssistantSession).sendAudio).toHaveBeenCalledWith('file:///turn.m4a');
  });
});
