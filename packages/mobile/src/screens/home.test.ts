// @vitest-environment jsdom
// Screen tests live under src/ (NOT app/) so expo-router's file-based routing
// doesn't treat them as routes and Metro doesn't bundle vitest into the app.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  signOut: vi.fn(),
  switchMode: vi.fn().mockResolvedValue(undefined),
  me: {
    user_id: 'u',
    tenant_id: 't1',
    role: 'supervisor',
    can_field_serve: true,
    current_mode: 'both',
    mode_changed_at: null,
    permissions: [] as string[],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_only' as const,
  } as unknown,
  isLoading: false,
  error: null as Error | null,
}));

vi.mock('../push/useSignOut', () => ({ useSignOut: () => h.signOut }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({
    me: h.me,
    isLoading: h.isLoading,
    error: h.error,
    switchMode: h.switchMode,
    refetch: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first
import Home from '../../app/index';

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoading = false;
  h.error = null;
  h.switchMode = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

function clickText(text: string): void {
  const node = render(createElement(Home)).getByText(text).closest('button');
  if (!node) throw new Error(`no button wrapping "${text}"`);
  fireEvent.click(node);
}

describe('Home screen', () => {
  it('renders every tap target at the >=44px contract (min-h-11)', () => {
    const { container } = render(createElement(Home));
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(5); // 3 modes + speak + approvals + sign out
    for (const b of buttons) {
      expect(b.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('navigates to the voice screen from "Speak an action"', () => {
    clickText('Speak an action');
    expect(h.push).toHaveBeenCalledWith('/voice');
  });

  it('navigates to the approvals inbox', () => {
    clickText('Approvals');
    expect(h.push).toHaveBeenCalledWith('/approvals');
  });

  it('shows a loading spinner and no actions while /api/me is loading', () => {
    h.isLoading = true;
    const { container } = render(createElement(Home));
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders the error message when /api/me fails', () => {
    h.error = new Error('me failed');
    const { getByText } = render(createElement(Home));
    expect(getByText('me failed')).toBeTruthy();
  });

  it('surfaces a mode-switch failure inline instead of swallowing it', async () => {
    h.switchMode = vi.fn().mockRejectedValue(new Error('Not allowed for your role'));
    const { getByText, findByText } = render(createElement(Home));
    fireEvent.click(getByText('tech').closest('button')!);
    expect(await findByText('Not allowed for your role')).toBeTruthy();
  });
});
