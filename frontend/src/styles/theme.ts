export const THEMES = ['light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];

// index.html stamps data-theme before first paint using this same key; keep them in step.
export const THEME_STORAGE_KEY = 'theme';

function isSupportedTheme(value: string | null): value is Theme {
  return value !== null && THEMES.some((theme) => theme === value);
}

// Plain function, not a store — the pre-paint bootstrap in index.html and stores/ui.ts both
// need the startup theme without either one owning the other's read.
// Light is the product default; dark applies only once the user has chosen it.
export function readStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return isSupportedTheme(stored) ? stored : 'light';
}

export function persistTheme(theme: Theme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
