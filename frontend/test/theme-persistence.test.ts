import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import ThemeToggle from '@/components/settings/ThemeToggle.vue';
import { THEME_STORAGE_KEY } from '@/styles/theme';

// jsdom has no matchMedia, so the OS-preference branch is driven explicitly.
function stubPrefersDark(dark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({ matches: dark }),
  });
}

beforeEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
});

function mountToggle() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  const wrapper = mount(ThemeToggle, { global: { plugins: [pinia, i18n] } });
  return { wrapper, pinia };
}

describe('readStoredTheme — light is the default until the user chooses dark', () => {
  it('returns the stored theme when it is a supported value', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    stubPrefersDark(false);
    const { readStoredTheme } = await import('@/styles/theme');
    expect(readStoredTheme()).toBe('dark');
  });

  it('honours a stored light choice even on a dark operating system', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    stubPrefersDark(true);
    const { readStoredTheme } = await import('@/styles/theme');
    expect(readStoredTheme()).toBe('light');
  });

  it('stays light when nothing is stored, even on a dark operating system', async () => {
    stubPrefersDark(true);
    const { readStoredTheme } = await import('@/styles/theme');
    expect(readStoredTheme()).toBe('light');
  });

  it('falls back to light rather than trusting an unsupported stored value', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    stubPrefersDark(true);
    const { readStoredTheme } = await import('@/styles/theme');
    expect(readStoredTheme()).toBe('light');
  });

  it('defaults to light where matchMedia is unavailable', async () => {
    const { readStoredTheme } = await import('@/styles/theme');
    expect(readStoredTheme()).toBe('light');
  });
});

describe('setTheme — the single mutation point', () => {
  it('updates the store, persists, and stamps the document together', async () => {
    stubPrefersDark(false);
    setActivePinia(createPinia());
    const { useUiStore } = await import('@/stores/ui');
    const ui = useUiStore();

    expect(ui.theme).toBe('light');

    ui.setTheme('dark');

    expect(ui.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('round-trips: a persisted choice is what a fresh store reads back', async () => {
    stubPrefersDark(true);
    setActivePinia(createPinia());
    const { useUiStore } = await import('@/stores/ui');
    useUiStore().setTheme('light');

    setActivePinia(createPinia());
    expect(useUiStore().theme).toBe('light');
  });
});

describe('ThemeToggle', () => {
  it('presses the active option and leaves the other unpressed', async () => {
    stubPrefersDark(false);
    const { wrapper } = mountToggle();
    expect(wrapper.get('[data-testid="theme-light"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="theme-dark"]').attributes('aria-pressed')).toBe('false');
  });

  it('labels its options from the message bundle', async () => {
    stubPrefersDark(false);
    const { wrapper } = mountToggle();
    expect(wrapper.get('[data-testid="theme-light"]').text()).toBe(es.theme.light);
    expect(wrapper.get('[data-testid="theme-dark"]').text()).toBe(es.theme.dark);
    expect(wrapper.get('[data-testid="theme-toggle"]').attributes('aria-label')).toBe(es.theme.label);
  });

  it('clicking dark updates the store, persists, stamps the document and flips aria-pressed', async () => {
    stubPrefersDark(false);
    const { wrapper, pinia } = mountToggle();
    const { useUiStore } = await import('@/stores/ui');
    const ui = useUiStore(pinia);

    await wrapper.get('[data-testid="theme-dark"]').trigger('click');

    expect(ui.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(wrapper.get('[data-testid="theme-dark"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="theme-light"]').attributes('aria-pressed')).toBe('false');
  });

  it('clicking back to light switches back', async () => {
    stubPrefersDark(false);
    const { wrapper } = mountToggle();
    await wrapper.get('[data-testid="theme-dark"]').trigger('click');
    await wrapper.get('[data-testid="theme-light"]').trigger('click');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

// The pre-paint bootstrap cannot import the module it mirrors, so the two are checked
// against each other rather than left to drift into a flash of the wrong theme.
describe('pre-paint bootstrap in index.html', () => {
  const html = readFileSync(join(__dirname, '../index.html'), 'utf-8');

  it('reads the same storage key the app writes', () => {
    expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });

  it('stamps data-theme and defaults to light without consulting the OS', () => {
    expect(html).toContain('document.documentElement.dataset.theme');
    expect(html).not.toContain('prefers-color-scheme');
  });

  it('runs before the app bundle', () => {
    expect(html.indexOf('dataset.theme')).toBeLessThan(html.indexOf('/src/main.ts'));
  });
});
