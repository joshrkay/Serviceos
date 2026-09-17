interface ApiErrorBody {
  message?: unknown;
  details?: {
    fields?: Record<string, unknown>;
  };
}

function fieldLabel(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Turn the API error envelope into actionable operator-facing copy. */
export function formatApiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;

  const errorBody = body as ApiErrorBody;
  const fields = errorBody.details?.fields;
  if (fields && typeof fields === 'object') {
    const fieldMessages = Object.entries(fields).flatMap(([field, value]) => {
      const messages = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      return messages.map((message) => `${fieldLabel(field)}: ${message}`);
    });
    if (fieldMessages.length > 0) return fieldMessages.join('; ');
  }

  return typeof errorBody.message === 'string' && errorBody.message.trim().length > 0
    ? errorBody.message
    : fallback;
}
