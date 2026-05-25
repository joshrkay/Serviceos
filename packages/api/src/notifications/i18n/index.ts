/**
 * P11-002 — notifications translator. Reuses the shared `makeTranslator`
 * engine (interpolation + EN fallback) from the voice i18n module so the
 * logic lives in one place.
 */
import { makeTranslator } from '../../ai/i18n/i18n';
import { en, type EnglishNotifications } from './en';
import { es } from './es';

export type NotificationKey = keyof EnglishNotifications;

export const tn = makeTranslator({ en, es });
