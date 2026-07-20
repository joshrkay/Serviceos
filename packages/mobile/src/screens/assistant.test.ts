// @vitest-environment jsdom
// Screen tests live under src/ (NOT app/) so expo-router's file-based routing
// doesn't treat them as routes and Metro doesn't bundle vitest into the app.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantPhase, AssistantTurn } from '../assistant/useAssistantSession';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  sendText: vi.fn().mockResolvedValue(undefined),
  sendClip: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  pressIn: vi.fn().mockResolvedValue(undefined),
  pressOut: vi.fn().mockResolvedValue(undefined),
  phase: 'active' as AssistantPhase,
  turns: [] as AssistantTurn[],
  proposalIds: [] as string[],
  error: null as string | null,
  sttUnavailable: false,
  isSending: false,
  me: {
    role: 'owner',
    current_mode: 'supervisor',
    can_field_serve: false,
  } as unknown,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, replace: h.replace, back: h.back }),
}));
vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ getToken: vi.fn(async () => 'jwt') }) }));
vi.mock('../hooks/useMe', () => ({ useMe: () => ({ me: h.me }) }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => vi.fn() }));
vi.mock('../lib/env', () => ({ API_BASE_URL: 'https://api.test' }));
vi.mock('../assistant/nativeAssistantDeps', () => ({
  streamFetch: vi.fn(),
  playBase64Tts: vi.fn(),
}));
vi.mock('../assistant/useAssistantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistant/useAssistantSession')>()),
  useAssistantSession: () => ({
    phase: h.phase,
    fsmState: 'intent_capture',
    turns: h.turns,
    proposalIds: h.proposalIds,
    error: h.error,
    sttUnavailable: h.sttUnavailable,
    isSending: h.isSending,
    start: h.start,
    sendText: h.sendText,
    sendClip: h.sendClip,
    end: h.end,
  }),
}));
vi.mock('../voice/useHoldToTalkRecorder', () => ({
  useHoldToTalkRecorder: () => ({ pressIn: h.pressIn, pressOut: h.pressOut, cancel: vi.fn() }),
}));

// eslint-disable-next-line import/first
import AssistantScreen from '../../app/assistant';

beforeEach(() => {
  vi.clearAllMocks();
  h.phase = 'active';
  h.turns = [
    { id: 1, role: 'agent', text: 'Hi Mike — what do you need?' },
    { id: 2, role: 'owner', text: "What's my balance?" },
  ];
  h.proposalIds = [];
  h.error = null;
  h.sttUnavailable = false;
  h.isSending = false;
  h.me = { role: 'owner', current_mode: 'supervisor', can_field_serve: false };
});

afterEach(() => cleanup());

describe('Assistant screen', () => {
  it('renders the conversation with a >=44px hold-to-talk target', () => {
    const { getByText } = render(createElement(AssistantScreen));
    expect(getByText('Hi Mike — what do you need?')).toBeTruthy();
    expect(getByText("What's my balance?")).toBeTruthy();
    const mic = getByText('Hold').closest('button')!;
    // The mic is a fixed 80pt circle (h-20 w-20) — comfortably over 44px.
    expect(mic.className).toMatch(/\bh-20\b/);
    fireEvent.mouseDown(mic);
    expect(h.pressIn).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(mic);
    expect(h.pressOut).toHaveBeenCalledTimes(1);
  });

  it('sends a typed turn through sendText', () => {
    const { getByPlaceholderText, getByText } = render(createElement(AssistantScreen));
    fireEvent.change(getByPlaceholderText('Type a message'), {
      target: { value: 'invoice the Hendersons' },
    });
    fireEvent.click(getByText('Send').closest('button')!);
    expect(h.sendText).toHaveBeenCalledWith('invoice the Hendersons');
  });

  it('renders proposal chips that deep-link into the review screen', () => {
    h.proposalIds = ['p42'];
    const { getByText } = render(createElement(AssistantScreen));
    fireEvent.click(getByText('Review proposal').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/proposals/p42');
  });

  it('hides the mic when STT is unavailable (text input remains)', () => {
    h.sttUnavailable = true;
    const { queryByText, getByPlaceholderText } = render(createElement(AssistantScreen));
    expect(queryByText('Hold')).toBeNull();
    expect(getByPlaceholderText('Type a message')).toBeTruthy();
  });

  it('shows the ended state with a start-new affordance', () => {
    h.phase = 'ended';
    const { getByText, queryByText } = render(createElement(AssistantScreen));
    expect(getByText(/start a new one/i)).toBeTruthy();
    expect(queryByText('Hold')).toBeNull();
    fireEvent.click(getByText('Start a new conversation').closest('button')!);
    expect(h.start).toHaveBeenCalled();
  });

  it('redirects the technician persona to Today', () => {
    h.me = { role: 'technician', current_mode: 'tech', can_field_serve: true };
    render(createElement(AssistantScreen));
    expect(h.replace).toHaveBeenCalledWith('/(tabs)/today');
  });
});
