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
      <h2 class="text-base font-semibold">Idioma / Language</h2>
      <p class="text-sm text-neutral">
        Elegí el idioma de la interfaz. Sólo afecta los textos del sistema — tu información personal queda igual.
      </p>
      <!-- The only place the language changes. -->
      <LanguageToggle />
    </section>
  </div>
</template>
