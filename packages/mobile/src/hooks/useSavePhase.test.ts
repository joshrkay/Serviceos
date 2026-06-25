// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSavePhase } from './useSavePhase';

describe('useSavePhase', () => {
  it('transitions idle → saving → saved on success', async () => {
    const { result } = renderHook(() => useSavePhase());
    await act(async () => {
      await result.current.run(async () => {
        /* noop */
      });
    });
    expect(result.current.phase).toBe('saved');
  });

  it('transitions to error when the mutation throws', async () => {
    const { result } = renderHook(() => useSavePhase());
    await act(async () => {
      await result.current.run(async () => {
        throw new Error('save failed');
      });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('save failed');
  });

  it('resets back to idle', async () => {
    const { result } = renderHook(() => useSavePhase());
    await act(async () => {
      await result.current.run(async () => {});
      result.current.reset();
    });
    expect(result.current.phase).toBe('idle');
  });
});
