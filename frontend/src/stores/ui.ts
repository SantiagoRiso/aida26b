import { defineStore } from 'pinia';
import { i18n } from '@/i18n';
import { readStoredLanguage, persistLanguage } from '@/i18n/language';
import { readStoredTheme, persistTheme, applyTheme } from '@/styles/theme';
import type { Theme } from '@/styles/theme';
import type { Language } from '@shared/types/languages';

export type ToastKind = 'info' | 'error' | 'success';

export interface Toast {
  id: number;
  kind: ToastKind;
  messageKey: string;
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    language: readStoredLanguage(),
    theme: readStoredTheme(),
    toasts: [] as Toast[],
    sessionExpired: false,
  }),
  actions: {
    setLanguage(lang: Language) {
      this.language = lang;
      persistLanguage(lang);
      // Keep vue-i18n in lockstep — ui store is the single source of language truth.
      i18n.global.locale.value = lang;
    },
    setTheme(theme: Theme) {
      this.theme = theme;
      persistTheme(theme);
      // Stamping the document is what actually repaints the app, so it happens here and
      // nowhere else — ui store is the single source of theme truth.
      applyTheme(theme);
    },
    flagSessionExpired() {
      this.sessionExpired = true;
      this.toast('error', 'sessionExpired');
    },
    toast(kind: ToastKind, messageKey: string) {
      this.toasts.push({ id: Date.now(), kind, messageKey });
    },
    dismissToast(id: number) {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    },
  },
});
