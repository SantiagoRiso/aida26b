<script setup lang="ts">
// The client's own reachable language control — no staff screen involved.

import { useI18n } from 'vue-i18n';
import LanguageToggle from '@/components/settings/LanguageToggle.vue';

const { t } = useI18n();
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">{{ t('nav.preferences') }}</h1>

    <section class="rounded-lg border border-border bg-card p-6 space-y-4">
      <!-- Bilingual heading so a user stuck in the wrong language still finds the toggle. -->
      <h2 class="text-base font-semibold">{{ t('portal.languageHeading') }}</h2>
      <p class="text-sm text-neutral">
        {{ t('portal.languageBody') }}
      </p>
      <!-- The only place the language changes. -->
      <LanguageToggle />
    </section>
  </div>
</template>
