import React, { useRef } from 'react';
import { renderHook, act, render } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useConversationDraft, useScrollRecovery } from './useConversationDraft';

describe('P3-011 — useConversationDraft', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('hydrates an existing draft from localStorage', () => {
    window.localStorage.setItem('serviceos.draft.conv-1', 'unsent message');
    const { result } = renderHook(() => useConversationDraft('conv-1'));
    expect(result.current.draft).toBe('unsent message');
  });

  it('persists draft changes to localStorage', () => {
    const { result } = renderHook(() => useConversationDraft('conv-1'));
    act(() => {
      result.current.setDraft('typing...');
    });
    expect(window.localStorage.getItem('serviceos.draft.conv-1')).toBe('typing...');
  });

  it('removes the draft key when cleared', () => {
    window.localStorage.setItem('serviceos.draft.conv-1', 'hi');
    const { result } = renderHook(() => useConversationDraft('conv-1'));
    act(() => {
      result.current.clearDraft();
    });
    expect(window.localStorage.getItem('serviceos.draft.conv-1')).toBeNull();
  });

  it('removes the draft key when setDraft is called with an empty string', () => {
    window.localStorage.setItem('serviceos.draft.conv-1', 'hi');
    const { result } = renderHook(() => useConversationDraft('conv-1'));
    act(() => {
      result.current.setDraft('');
    });
    expect(window.localStorage.getItem('serviceos.draft.conv-1')).toBeNull();
  });

  it('isolates drafts per conversationId', () => {
    const a = renderHook(() => useConversationDraft('conv-a'));
    const b = renderHook(() => useConversationDraft('conv-b'));
    act(() => a.result.current.setDraft('A-text'));
    act(() => b.result.current.setDraft('B-text'));
    expect(window.localStorage.getItem('serviceos.draft.conv-a')).toBe('A-text');
    expect(window.localStorage.getItem('serviceos.draft.conv-b')).toBe('B-text');
  });

  it('returns an empty draft when conversationId is undefined', () => {
    const { result } = renderHook(() => useConversationDraft(undefined));
    expect(result.current.draft).toBe('');
    act(() => result.current.setDraft('should not persist'));
    // No key should be written when no conversationId.
    expect(window.localStorage.getItem('serviceos.draft.undefined')).toBeNull();
  });
});

describe('P3-011 — useScrollRecovery', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function Harness({ conversationId }: { conversationId: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useScrollRecovery(conversationId, ref);
    return (
      <div
        ref={ref}
        data-testid="scroll-container"
        style={{ height: 100, overflow: 'auto' }}
      >
        <div style={{ height: 1000 }}>long content</div>
      </div>
    );
  }

  it('restores the saved scroll offset on mount', () => {
    window.localStorage.setItem('serviceos.scroll.conv-1', '250');
    const { getByTestId } = render(<Harness conversationId="conv-1" />);
    const el = getByTestId('scroll-container') as HTMLDivElement;
    expect(el.scrollTop).toBe(250);
  });

  it('persists scroll offset on scroll events', () => {
    const { getByTestId } = render(<Harness conversationId="conv-2" />);
    const el = getByTestId('scroll-container') as HTMLDivElement;
    el.scrollTop = 123;
    el.dispatchEvent(new Event('scroll'));
    expect(window.localStorage.getItem('serviceos.scroll.conv-2')).toBe('123');
  });
});
