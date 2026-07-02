import { useUiStore } from '@/stores/ui';
import type { LocalizedText } from '@shared/types/types';

// SSOT LocalizedText resolver. Bound to the ui store's reactive language so a single
// setLanguage() call switches both SSOT entity/field labels and vue-i18n UI chrome together.
export function useLabel() {
  const ui = useUiStore();

  function label(text?: LocalizedText | string): string {
    if (!text) return '';
    if (typeof text === 'string') return text;
    return text[ui.language] ?? text.es ?? text.en ?? '';
  }

  return { label };
}
