import { describe, it, expect, vi } from 'vitest';
import { shouldRegisterServiceWorker, registerServiceWorker } from './register-sw';

const swNav = { serviceWorker: {} } as unknown as Pick<Navigator, 'serviceWorker'>;
const https = { protocol: 'https:', hostname: 'app.rivet.com' };
const localhost = { protocol: 'http:', hostname: 'localhost' };

describe('shouldRegisterServiceWorker (R4)', () => {
  it('registers in a production https context', () => {
    expect(shouldRegisterServiceWorker({ prod: true }, { navigator: swNav, location: https })).toBe(true);
  });

  it('registers on http localhost (treated as secure for dev/preview)', () => {
    expect(
      shouldRegisterServiceWorker({ prod: true }, { navigator: swNav, location: localhost }),
    ).toBe(true);
  });

  it('does not register in dev builds', () => {
    expect(shouldRegisterServiceWorker({ prod: false }, { navigator: swNav, location: https })).toBe(false);
  });

  it('does not register without service worker support', () => {
    expect(
      shouldRegisterServiceWorker({ prod: true }, { navigator: {} as never, location: https }),
    ).toBe(false);
  });

  it('does not register on insecure non-localhost origins', () => {
    expect(
      shouldRegisterServiceWorker(
        { prod: true },
        { navigator: swNav, location: { protocol: 'http:', hostname: 'app.rivet.com' } },
      ),
    ).toBe(false);
  });
});

describe('registerServiceWorker (R4)', () => {
  it('calls navigator.serviceWorker.register with the root scope when eligible', async () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' });
    const nav = { serviceWorker: { register } } as unknown as Pick<Navigator, 'serviceWorker'>;
    const reg = await registerServiceWorker({ prod: true }, { navigator: nav, location: https });
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(reg).toEqual({ scope: '/' });
  });

  it('returns null (and does not throw) when registration fails', async () => {
    const register = vi.fn().mockRejectedValue(new Error('boom'));
    const nav = { serviceWorker: { register } } as unknown as Pick<Navigator, 'serviceWorker'>;
    const reg = await registerServiceWorker({ prod: true }, { navigator: nav, location: https });
    expect(reg).toBeNull();
  });

  it('skips registration entirely in dev', async () => {
    const register = vi.fn();
    const nav = { serviceWorker: { register } } as unknown as Pick<Navigator, 'serviceWorker'>;
    const reg = await registerServiceWorker({ prod: false }, { navigator: nav, location: https });
    expect(register).not.toHaveBeenCalled();
    expect(reg).toBeNull();
  });
});
