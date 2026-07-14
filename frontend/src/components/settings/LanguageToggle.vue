<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUiStore } from '@/stores/ui';
import type { Language } from '@shared/types/languages';

const ui = useUiStore();
const { t } = useI18n();

const current = computed(() => ui.language);

function select(lang: Language) {
  if (lang !== current.value) {
    // setLanguage is the ONLY place the language changes: it flips both
    // SSOT labels (useLabel) and vue-i18n simultaneously.
    ui.setLanguage(lang);
  }
}
</script>

<template>
  <div
    data-testid="language-toggle"
    class="inline-flex rounded-md border border-border overflow-hidden"
    role="group"
    :aria-label="t('settings.language')"
  >
    <button
      type="button"
      data-testid="lang-es"
      class="px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :class="current === 'es'
        ? 'bg-accent text-white'
        : 'bg-card text-neutral hover:bg-surface'"
      :aria-pressed="current === 'es'"
      @click="select('es')"
    >
      Español
    </button>
    <button
      type="button"
      data-testid="lang-en"
      class="px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent border-l border-border"
      :class="current === 'en'
        ? 'bg-accent text-white'
        : 'bg-card text-neutral hover:bg-surface'"
      :aria-pressed="current === 'en'"
      @click="select('en')"
    >
      English
    </button>
  </div>
</template>
