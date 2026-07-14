<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LanguageToggle from '@/components/settings/LanguageToggle.vue';

const { t } = useI18n();
</script>

<template>
  <div class="max-w-2xl">
    <h1 class="text-2xl font-semibold mb-6">
      {{ t('nav.settings') }}
    </h1>

    <section class="mb-8">
      <h2 class="text-lg font-semibold text-heading mb-4">
        {{ t('nav.preferences') }}
      </h2>

      <div class="rounded-lg border border-border bg-card p-5">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-semibold text-heading">
              {{ t('settings.interfaceLanguage') }}
            </div>
            <div class="mt-1 text-sm text-neutral">
              {{ t('settings.languageHint') }}
            </div>
          </div>
          <!-- The only place the language changes. -->
          <LanguageToggle />
        </div>
      </div>
    </section>
  </div>
</template>
