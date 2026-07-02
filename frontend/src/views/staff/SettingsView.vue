<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { updateSettings } from '@/api/business';
import { useLabel } from '@/composables/useLabel';
import LanguageToggle from '@/components/settings/LanguageToggle.vue';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';

const { t } = useI18n();
const auth = useAuthStore();
const ui = useUiStore();
const { label } = useLabel();

const isAdmin = computed(() => auth.user?.role === 'Admin');
const businessId = computed(() => auth.user?.business_id);

const cutoffHours = ref<number | null>(null);
const savingCutoff = ref(false);
const cutoffError = ref('');
const cutoffSaved = ref(false);

async function saveCutoff() {
  cutoffError.value = '';
  cutoffSaved.value = false;

  if (cutoffHours.value == null || !Number.isInteger(cutoffHours.value) || cutoffHours.value < 0) {
    cutoffError.value = label({ es: 'Debe ser un número entero no negativo', en: 'Must be a non-negative integer' });
    return;
  }

  if (!businessId.value) {
    ui.toast('error', 'genericError');
    return;
  }

  savingCutoff.value = true;
  const result = await updateSettings(businessId.value, { cancellation_cutoff_hours: cutoffHours.value });
  savingCutoff.value = false;

  if (!result.ok) {
    if (result.fields?.cancellation_cutoff_hours) {
      cutoffError.value = result.fields.cancellation_cutoff_hours;
    } else {
      ui.toast('error', 'genericError');
    }
  } else {
    cutoffSaved.value = true;
    ui.toast('success', 'settingsSaved');
  }
}
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

    <section v-if="isAdmin">
      <h2 class="text-lg font-semibold text-heading mb-4">
        {{ label({ es: 'Configuración del negocio', en: 'Business settings' }) }}
      </h2>

      <div class="rounded-lg border border-border bg-card p-5">
        <div class="mb-4">
          <label class="block text-sm font-semibold text-heading mb-1">
            {{ label({ es: 'Plazo de cancelación (horas)', en: 'Cancellation cutoff (hours)' }) }}
          </label>
          <p class="mb-2 text-sm text-neutral">
            {{ label({ es: 'Los clientes no pueden cancelar turnos programados con menos de este tiempo de anticipación.', en: 'Clients cannot cancel scheduled appointments within this many hours of the start time.' }) }}
          </p>
          <div class="flex items-start gap-3">
            <input
              v-model.number="cutoffHours"
              type="number"
              min="0"
              step="1"
              class="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums"
              :placeholder="label({ es: 'Ej: 24', en: 'E.g. 24' })"
            />
            <AppButton variant="primary" :loading="savingCutoff" @click="saveCutoff">
              {{ t('actions.save') }}
            </AppButton>
          </div>
          <FieldError :message="cutoffError" />
          <p v-if="cutoffSaved" class="mt-2 text-sm text-success">
            {{ label({ es: 'Guardado correctamente.', en: 'Saved successfully.' }) }}
          </p>
        </div>
      </div>
    </section>
  </div>
</template>
