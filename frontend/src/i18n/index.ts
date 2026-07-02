import { createI18n } from 'vue-i18n';
import { es } from './es';
import { en } from './en';

// The Pinia ui store is the single source of current language.
// This instance's locale is kept in lockstep via setLanguage in the ui store — never set directly.
export const i18n = createI18n({
  legacy: false,
  locale: (localStorage.getItem('language') === 'en' ? 'en' : 'es') as 'es' | 'en',
  fallbackLocale: 'es',
  messages: { es, en },
});
