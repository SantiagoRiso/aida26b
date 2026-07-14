import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import LanguageToggle from '@/components/settings/LanguageToggle.vue';

// setLanguage/i18n-lockstep at the store level is already covered by i18n-label.test.ts;
// this file drives the actual toggle component (clicks, aria-pressed, default read) and the
// readStoredLanguage/persistLanguage helpers it relies on.

beforeEach(() => {
  localStorage.removeItem('language');
});

function mountToggle() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  const wrapper = mount(LanguageToggle, { global: { plugins: [pinia, i18n] } });
  return { wrapper, pinia };
}

describe('readStoredLanguage — default ES', () => {
  it('defaults to es when nothing is stored', async () => {
    const { readStoredLanguage } = await import('@/i18n/language');
    expect(readStoredLanguage()).toBe('es');
  });

  it('returns the stored language when it is a supported value', async () => {
    localStorage.setItem('language', 'en');
    const { readStoredLanguage } = await import('@/i18n/language');
    expect(readStoredLanguage()).toBe('en');
  });

  it('falls back to es for an unsupported stored value', async () => {
    localStorage.setItem('language', 'fr');
    const { readStoredLanguage } = await import('@/i18n/language');
    expect(readStoredLanguage()).toBe('es');
  });
});

describe('LanguageToggle — default state', () => {
  it('renders with Spanish pressed and English not pressed by default', () => {
    const { wrapper } = mountToggle();
    expect(wrapper.get('[data-testid="lang-es"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="lang-en"]').attributes('aria-pressed')).toBe('false');
  });
});

describe('LanguageToggle — switching persists and flips vue-i18n live', () => {
  it('clicking English updates the ui store, persists to localStorage, and flips aria-pressed', async () => {
    const { wrapper, pinia } = mountToggle();
    const { useUiStore } = await import('@/stores/ui');
    const ui = useUiStore(pinia);

    await wrapper.get('[data-testid="lang-en"]').trigger('click');

    expect(ui.language).toBe('en');
    expect(localStorage.getItem('language')).toBe('en');
    expect(wrapper.get('[data-testid="lang-en"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="lang-es"]').attributes('aria-pressed')).toBe('false');
  });

  it('flips the live vue-i18n singleton locale, not just the local plugin instance', async () => {
    const { i18n: appI18n } = await import('@/i18n');
    appI18n.global.locale.value = 'es'; // reset from any prior test in this file

    const { wrapper } = mountToggle();
    await wrapper.get('[data-testid="lang-en"]').trigger('click');

    // LanguageToggle -> ui.setLanguage -> i18n.global.locale.value assigns the APP singleton
    // (imported directly in stores/ui.ts), independent of the local plugin instance mounted here.
    expect(appI18n.global.locale.value).toBe('en');

    appI18n.global.locale.value = 'es'; // leave the singleton clean for later test files
  });

  it('clicking Español after English switches back', async () => {
    const { wrapper } = mountToggle();
    await wrapper.get('[data-testid="lang-en"]').trigger('click');
    await wrapper.get('[data-testid="lang-es"]').trigger('click');

    expect(wrapper.get('[data-testid="lang-es"]').attributes('aria-pressed')).toBe('true');
    expect(localStorage.getItem('language')).toBe('es');
  });
});
