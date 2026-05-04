export type SendgridProvisionSuccess = {
  ok: true;
  apiKeyId: string;
  secretRef: string;
};

export type SendgridProvisionFailure = {
  ok: false;
  error: {
    code: 'SENDGRID_ENCRYPTION_FAILED' | 'SENDGRID_STORAGE_FAILED';
    message: string;
    details?: Record<string, unknown>;
  };
};

export type SendgridProvisionResult = SendgridProvisionSuccess | SendgridProvisionFailure;
function classifySendgridError(error: unknown): SendgridProvisioningResult<never>['failure'] {
  const e = error as { code?: string | number; message?: string; status?: number };
  const status = e.status ?? 0;
  if (status === 401 || status === 403) return { code: 'AUTH', message: e.message ?? 'Unauthorized', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status === 404) return { code: 'NOT_FOUND', message: e.message ?? 'Resource not found', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status === 409) return { code: 'CONFLICT', message: e.message ?? 'Conflict', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status === 429) return { code: 'RATE_LIMIT', message: e.message ?? 'Rate limited', retriable: true, providerCode: e.code ? String(e.code) : undefined };
  if (status >= 400 && status < 500) return { code: 'VALIDATION', message: e.message ?? 'Validation failed', retriable: false, providerCode: e.code ? String(e.code) : undefined };
  if (status >= 500) return { code: 'NETWORK', message: e.message ?? 'Provider unavailable', retriable: true, providerCode: e.code ? String(e.code) : undefined };
  return { code: 'UNKNOWN', message: e.message ?? 'Unknown SendGrid error', retriable: true, providerCode: e.code ? String(e.code) : undefined };
}

type ProvisionDeps = {
  encryptApiKey: (rawApiKey: string) => Promise<{ ciphertext: string; keyId: string }>;
  storeSecret: (payload: { ciphertext: string; keyId: string }) => Promise<{ secretRef: string }>;
};

const SENSITIVE_FIELD_NAMES = new Set(['apiKey', 'rawApiKey', 'token', 'authorization', 'secret']);

export function redactSensitiveFields<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SENSITIVE_FIELD_NAMES.has(key) ? '[REDACTED]' : value;
  }
  return out as T;
}

function sanitizeText(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function sanitizeDetails(details: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const redacted = redactSensitiveFields(details);
  return Object.fromEntries(
    Object.entries(redacted).map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, sanitizeText(value, secrets)];
      }
      return [key, value];
    }),
  );
}

export async function provisionSendgridApiKey(
  apiKeyId: string,
  rawApiKey: string,
  deps: ProvisionDeps,
): Promise<SendgridProvisionResult> {
  try {
    const encrypted = await deps.encryptApiKey(rawApiKey);
    try {
      const stored = await deps.storeSecret(encrypted);
      return {
        ok: true,
        apiKeyId,
        secretRef: stored.secretRef,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'SENDGRID_STORAGE_FAILED',
          message: 'Failed to persist encrypted SendGrid API key',
          details: sanitizeDetails(
            {
            apiKeyId,
            rawApiKey,
            reason: (error instanceof Error ? error.message : String(error)).split(rawApiKey).join('[REDACTED]'),
            },
            [rawApiKey],
          ),
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SENDGRID_ENCRYPTION_FAILED',
        message: 'Failed to encrypt SendGrid API key',
        details: sanitizeDetails(
          {
            apiKeyId,
            rawApiKey,
            reason: error instanceof Error ? error.message : String(error),
          },
          [rawApiKey],
        ),
      },
    };
  }
}
