<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { getSettings, updateSettings } from '@/api/business';
import { useLabel } from '@/composables/useLabel';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import CrudSection from '@/components/generic/CrudSection.vue';
import ResourcesSection from '@/components/settings/ResourcesSection.vue';
import BusinessClosuresSection from '@/components/settings/BusinessClosuresSection.vue';
import ProfessionalPicker from '@/components/schedule/ProfessionalPicker.vue';
import ProfessionalServicesSection from '@/components/settings/ProfessionalServicesSection.vue';
import CalendarGrantsSection from '@/components/settings/CalendarGrantsSection.vue';

const { t } = useI18n();
const auth = useAuthStore();
const ui = useUiStore();
const { label } = useLabel();

const businessId = computed(() => auth.user?.business_id);

const staffProfessionalId = ref<number | null>(null);

const cutoffHours = ref<number | null>(null);
const minDays = ref<number | null>(null);
// The number input yields '' when cleared; treat that as "no cap" (null).
const maxDays = ref<number | '' | null>(null);
const saving = ref(false);
const formError = ref('');

onMounted(async () => {
  if (!businessId.value) return;
  const result = await getSettings(businessId.value);
  if (result.ok) {
    cutoffHours.value = result.data.cancellation_cutoff_hours;
    minDays.value = result.data.min_booking_days;
    maxDays.value = result.data.max_booking_days;
  }
});

function nonNegInt(v: number | null): boolean {
  return v != null && Number.isInteger(v) && v >= 0;
}

async function saveSettings() {
  formError.value = '';
  const max = maxDays.value === '' || maxDays.value == null ? null : maxDays.value;

  if (!nonNegInt(cutoffHours.value) || !nonNegInt(minDays.value)) {
    formError.value = label({ es: 'Los valores deben ser enteros no negativos.', en: 'Values must be non-negative integers.' });
    return;
  }
  if (max !== null && (!Number.isInteger(max) || max < 0)) {
    formError.value = label({ es: 'La anticipación máxima debe ser un entero no negativo o vacía.', en: 'Max booking days must be a non-negative integer or empty.' });
    return;
  }
  if (max !== null && max < (minDays.value as number)) {
    formError.value = label({ es: 'La anticipación máxima debe ser mayor o igual a la mínima.', en: 'Max booking days must be greater than or equal to min.' });
    return;
  }
  if (!businessId.value) {
    ui.toast('error', 'genericError');
    return;
  }

  saving.value = true;
  const result = await updateSettings(businessId.value, {
    cancellation_cutoff_hours: cutoffHours.value as number,
    min_booking_days: minDays.value as number,
    max_booking_days: max,
  });
  saving.value = false;

  if (result.ok) ui.toast('success', 'settingsSaved');
  else ui.toast('error', 'genericError');
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">
      {{ label({ es: 'Negocio', en: 'Business' }) }}
    </h1>

    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ label({ es: 'General', en: 'General' }) }}</h2>
        <div class="flex flex-wrap gap-4">
          <div>
            <label for="biz-cutoff" class="block text-sm font-semibold text-heading mb-1">
              {{ label({ es: 'Plazo de cancelación (horas)', en: 'Cancellation cutoff (hours)' }) }}
            </label>
            <input id="biz-cutoff" v-model.number="cutoffHours" type="number" min="0" step="1"
              class="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
          </div>
          <div>
            <label for="biz-min-days" class="block text-sm font-semibold text-heading mb-1">
              {{ label({ es: 'Anticipación mínima (días)', en: 'Min booking days' }) }}
            </label>
            <input id="biz-min-days" v-model.number="minDays" type="number" min="0" step="1"
              class="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
          </div>
          <div>
            <label for="biz-max-days" class="block text-sm font-semibold text-heading mb-1">
              {{ label({ es: 'Anticipación máxima (días)', en: 'Max booking days' }) }}
            </label>
            <input id="biz-max-days" v-model.number="maxDays" type="number" min="0" step="1"
              :placeholder="label({ es: 'Sin límite', en: 'No cap' })"
              class="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
          </div>
        </div>
        <FieldError :message="formError" />
        <AppButton id="biz-settings-save" variant="primary" :loading="saving" @click="saveSettings">
          {{ t('actions.save') }}
        </AppButton>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ label({ es: 'Administración de Staff', en: 'Staff administration' }) }}</h2>
        <ProfessionalPicker v-model="staffProfessionalId" />
        <div class="space-y-6">
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-heading">{{ label({ es: 'Permisos de calendario', en: 'Calendar permissions' }) }}</h3>
            <CalendarGrantsSection :professional-user-id="staffProfessionalId" />
          </div>
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-heading">{{ label({ es: 'Servicios ofrecidos', en: 'Offered services' }) }}</h3>
            <ProfessionalServicesSection :professional-user-id="staffProfessionalId" />
          </div>
        </div>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ label({ es: 'Salas', en: 'Rooms' }) }}</h2>
        <ResourcesSection />
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ label({ es: 'Días festivos', en: 'Holidays' }) }}</h2>
        <BusinessClosuresSection />
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4 lg:col-span-2">
        <h2 class="text-lg font-semibold text-heading">{{ label({ es: 'Servicios', en: 'Services' }) }}</h2>
        <CrudSection
          table-key="services"
          :hide-title="true"
          :hide-filters="true"
          :panel-title="{ es: 'Servicio', en: 'Service' }"
          :delete-label="{ es: 'Eliminar servicio', en: 'Delete service' }"
          :delete-body="{ es: 'Esta acción no se puede deshacer.', en: 'This action cannot be undone.' }"
        />
      </section>
    </div>
  </div>
</template>
