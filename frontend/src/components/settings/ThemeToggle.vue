<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUiStore } from '@/stores/ui';
import type { Theme } from '@/styles/theme';

const ui = useUiStore();
const { t } = useI18n();

const current = computed(() => ui.theme);

function select(theme: Theme) {
  if (theme !== current.value) {
    // setTheme is the ONLY place the theme changes: it persists the choice and
    // restamps the document in one step.
    ui.setTheme(theme);
  }
}
</script>

<template>
  <div
    data-testid="theme-toggle"
    class="inline-flex rounded-md border border-border overflow-hidden"
    role="group"
    :aria-label="t('theme.label')"
  >
    <button
      type="button"
      data-testid="theme-light"
      class="px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :class="current === 'light'
        ? 'bg-accent text-inverted'
        : 'bg-card text-neutral hover:bg-surface'"
      :aria-pressed="current === 'light'"
      @click="select('light')"
    >
      {{ t('theme.light') }}
    </button>
    <button
      type="button"
      data-testid="theme-dark"
      class="px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent border-l border-border"
      :class="current === 'dark'
        ? 'bg-accent text-inverted'
        : 'bg-card text-neutral hover:bg-surface'"
      :aria-pressed="current === 'dark'"
      @click="select('dark')"
    >
      {{ t('theme.dark') }}
    </button>
  </div>
</template>
