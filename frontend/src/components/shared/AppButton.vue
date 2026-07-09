<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'destructive' | 'neutral';
  size?: 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}>(), {
  variant: 'primary',
  size: 'md',
  loading: false,
  disabled: false,
  type: 'button',
});

const classes = computed(() => {
  const sizing = props.size === 'lg'
    ? 'min-h-[52px] px-6 py-3 text-base'
    : 'min-h-[44px] px-4 py-2 text-sm';
  const base = `inline-flex items-center justify-center ${sizing} rounded-md font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap`;
  if (props.variant === 'primary') {
    return `${base} bg-accent text-white hover:bg-accent-hover focus-visible:ring-accent`;
  }
  if (props.variant === 'destructive') {
    return `${base} bg-destructive text-white hover:bg-destructive-hover focus-visible:ring-destructive`;
  }
  return `${base} bg-card text-neutral border border-border hover:bg-surface focus-visible:ring-neutral`;
});
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading"
  >
    <span v-if="loading" class="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
    <slot />
  </button>
</template>
