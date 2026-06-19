import { describe, it, expect, afterEach } from 'vitest';
import { isNativePlatform, getPlatform } from './capacitorEnv';

type WinWithCap = { Capacitor?: unknown };

afterEach(() => {
  delete (window as unknown as WinWithCap).Capacitor;
});

describe('capacitorEnv', () => {
  it('reports web (not native) when no Capacitor global is present', () => {
    expect(isNativePlatform()).toBe(false);
    expect(getPlatform()).toBe('web');
  });

  it('detects native when window.Capacitor reports it', () => {
    (window as unknown as WinWithCap).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    expect(isNativePlatform()).toBe(true);
    expect(getPlatform()).toBe('ios');
  });

  it('treats a non-native Capacitor global as web', () => {
    (window as unknown as WinWithCap).Capacitor = {
      isNativePlatform: () => false,
      getPlatform: () => 'web',
    };
    expect(isNativePlatform()).toBe(false);
    expect(getPlatform()).toBe('web');
  });
});
