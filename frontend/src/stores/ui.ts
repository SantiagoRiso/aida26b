import { defineStore } from 'pinia';
import { i18n } from '@/i18n';

export type ToastKind = 'info' | 'error' | 'success';

export interface Toast {
  id: number;
  kind: ToastKind;
  messageKey: string;
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    language: (localStorage.getItem('language') === 'en' ? 'en' : 'es') as 'es' | 'en',
    toasts: [] as Toast[],
    sessionExpired: false,
  }),
  actions: {
    setLanguage(lang: 'es' | 'en') {
      this.language = lang;
      localStorage.setItem('language', lang);
      // Keep vue-i18n in lockstep — ui store is the single source of language truth.
      i18n.global.locale.value = lang;
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
