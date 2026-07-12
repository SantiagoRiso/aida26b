<script setup lang="ts">
import { useLabel } from '@/composables/useLabel';
import LanguageToggle from '@/components/settings/LanguageToggle.vue';

const { label } = useLabel();
</script>

<template>
  <div class="p-6 max-w-2xl">
    <h1 class="text-[28px] font-semibold leading-tight text-heading mb-6">
      {{ label({ es: 'Configuración', en: 'Settings' }) }}
    </h1>

    <section class="mb-8">
      <h2 class="text-lg font-semibold text-heading mb-4">
        {{ label({ es: 'Preferencias', en: 'Preferences' }) }}
      </h2>

      <div class="rounded-lg border border-border bg-card p-5">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-semibold text-heading">
              {{ label({ es: 'Idioma de la interfaz', en: 'Interface language' }) }}
            </div>
            <div class="mt-1 text-sm text-neutral">
              {{ label({ es: 'Español por defecto. Se guarda por dispositivo.', en: 'Spanish by default. Saved per device.' }) }}
            </div>
          </div>
          <!-- The only place the language changes. -->
          <LanguageToggle />
        </div>
      </div>
    </section>
  </div>
</template>
