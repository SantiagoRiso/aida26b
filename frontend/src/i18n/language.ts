import { LANGUAGES } from '@shared/types/languages';
import type { Language } from '@shared/types/languages';

// index.html stamps <html lang> before first paint using this same key; keep them in step.
export const LANGUAGE_STORAGE_KEY = 'language';

function isSupportedLanguage(value: string | null): value is Language {
  return value !== null && LANGUAGES.some((language) => language === value);
}

// Plain function, not a store — i18n/index.ts reads this at module init, before Pinia exists.
// stores/ui.ts reads it too, so both the vue-i18n instance and the ui store agree on startup
// language without either one owning the other's read.
export function readStoredLanguage(): Language {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return isSupportedLanguage(stored) ? stored : 'es';
}

export function persistLanguage(lang: Language): void {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
}

// Screen readers pick their pronunciation rules from <html lang>, so a stale value makes the
// content unintelligible rather than merely mislabelled.
export function applyLanguage(lang: Language): void {
  document.documentElement.lang = lang;
}
