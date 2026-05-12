declare global {
  interface Window {
    __APP_CONFIG__?: Record<string, string | undefined>;
  }
}

function readBrowserRuntimeValue(name: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.__APP_CONFIG__?.[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readViteValue(name: string): string | undefined {
  try {
    const value = (import.meta as { env?: Record<string, string | undefined> })
      .env?.[name];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function readProcessValue(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getRuntimeConfigValue(name: string): string | undefined {
  return (
    readBrowserRuntimeValue(name) ??
    readViteValue(name) ??
    readProcessValue(name)
  );
}
