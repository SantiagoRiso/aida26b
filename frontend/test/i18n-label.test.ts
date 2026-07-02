import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.removeItem('language');
});

describe('useLabel — SSOT LocalizedText resolution', () => {
  it('resolves es string when language is es', async () => {
    const { useUiStore } = await import('@/stores/ui');
    const { useLabel } = await import('@/composables/useLabel');
    const ui = useUiStore();
    ui.setLanguage('es');

    const { label } = useLabel();
    expect(label({ es: 'Guardar', en: 'Save' })).toBe('Guardar');
  });

  it('resolves en string when language is en', async () => {
    const { useUiStore } = await import('@/stores/ui');
    const { useLabel } = await import('@/composables/useLabel');
    const ui = useUiStore();
    ui.setLanguage('en');

    const { label } = useLabel();
    expect(label({ es: 'Guardar', en: 'Save' })).toBe('Save');
  });

  it('falls back to es when en is missing', async () => {
    const { useUiStore } = await import('@/stores/ui');
    const { useLabel } = await import('@/composables/useLabel');
    const ui = useUiStore();
    ui.setLanguage('en');

    const { label } = useLabel();
    // Cast a missing-en value past the type to exercise the runtime es fallback.
    expect(label({ es: 'Solo español' } as { es: string; en: string })).toBe('Solo español');
  });

  it('returns empty string for undefined input', async () => {
    const { useLabel } = await import('@/composables/useLabel');
    const { label } = useLabel();
    expect(label(undefined)).toBe('');
  });

  it('passes through plain string as-is', async () => {
    const { useLabel } = await import('@/composables/useLabel');
    const { label } = useLabel();
    expect(label('raw string')).toBe('raw string');
  });
});

describe('setLanguage — single-toggle bridge', () => {
  it('updates the ui store language', async () => {
    const { useUiStore } = await import('@/stores/ui');
    const ui = useUiStore();
    ui.setLanguage('en');
    expect(ui.language).toBe('en');
  });

  it('persists to localStorage under the "language" key', async () => {
    const { useUiStore } = await import('@/stores/ui');
    const ui = useUiStore();
    ui.setLanguage('en');
    expect(localStorage.getItem('language')).toBe('en');
  });

  it('updates i18n.global.locale.value in lockstep', async () => {
    const { useUiStore } = await import('@/stores/ui');
    const { i18n } = await import('@/i18n');
    const ui = useUiStore();

    ui.setLanguage('en');
    expect(i18n.global.locale.value).toBe('en');

    ui.setLanguage('es');
    expect(i18n.global.locale.value).toBe('es');
  });
});
