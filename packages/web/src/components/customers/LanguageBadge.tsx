/**
 * P11-002 — Compact pill badge that surfaces a customer's preferred
 * spoken language on detail views. Renders nothing when the customer
 * has no preference set so existing pages stay visually unchanged.
 */
import type { ReactElement } from 'react';

export type Language = 'en' | 'es';

export interface LanguageBadgeProps {
  language?: Language | null;
  className?: string;
}

const LABEL: Record<Language, string> = {
  en: 'English',
  es: 'Español',
};

export function LanguageBadge({
  language,
  className,
}: LanguageBadgeProps): ReactElement | null {
  if (language !== 'en' && language !== 'es') return null;
  const base =
    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';
  return (
    <span
      data-testid="language-badge"
      data-language={language}
      aria-label={`Preferred language: ${LABEL[language]}`}
      className={[base, className].filter(Boolean).join(' ')}
    >
      {LABEL[language]}
    </span>
  );
}

export default LanguageBadge;
