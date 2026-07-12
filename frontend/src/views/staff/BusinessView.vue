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
import AccordionSection from '@/components/shared/AccordionSection.vue';
import ResourcesSection from '@/components/settings/ResourcesSection.vue';
import ProfessionalPicker from '@/components/schedule/ProfessionalPicker.vue';
import CalendarGrantsSection from '@/components/settings/CalendarGrantsSection.vue';

const { t } = useI18n();
const auth = useAuthStore();
const ui = useUiStore();
const { label } = useLabel();

const businessId = computed(() => auth.user?.business_id);

const grantProfessionalId = ref<number | null>(null);

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
  <div class="p-6 space-y-8">
    <h1 class="text-[28px] font-semibold leading-tight text-heading">
      {{ label({ es: 'Negocio', en: 'Business' }) }}
    </h1>

    <AccordionSection :title="label({ es: 'General', en: 'General' })" default-open>
      <div class="max-w-2xl space-y-5">
        <div>
          <label for="biz-cutoff" class="block text-sm font-semibold text-heading mb-1">
            {{ label({ es: 'Plazo de cancelación (horas)', en: 'Cancellation cutoff (hours)' }) }}
          </label>
          <p class="mb-2 text-sm text-neutral">
            {{ label({ es: 'Los clientes no pueden cancelar turnos programados con menos de este tiempo de anticipación.', en: 'Clients cannot cancel scheduled appointments within this many hours of the start time.' }) }}
          </p>
          <input id="biz-cutoff" v-model.number="cutoffHours" type="number" min="0" step="1"
            class="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="biz-min-days" class="block text-sm font-semibold text-heading mb-1">
              {{ label({ es: 'Anticipación mínima (días)', en: 'Min booking days' }) }}
            </label>
            <p class="mb-2 text-sm text-neutral">
              {{ label({ es: 'Días desde hoy antes de que un cliente pueda reservar.', en: 'Days from today before a client can book.' }) }}
            </p>
            <input id="biz-min-days" v-model.number="minDays" type="number" min="0" step="1"
              class="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
          </div>
          <div>
            <label for="biz-max-days" class="block text-sm font-semibold text-heading mb-1">
              {{ label({ es: 'Anticipación máxima (días)', en: 'Max booking days' }) }}
            </label>
            <p class="mb-2 text-sm text-neutral">
              {{ label({ es: 'Máximo de días a futuro reservables. Vacío = sin límite.', en: 'Furthest bookable date. Empty = no cap.' }) }}
            </p>
            <input id="biz-max-days" v-model.number="maxDays" type="number" min="0" step="1"
              :placeholder="label({ es: 'Sin límite', en: 'No cap' })"
              class="w-32 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
          </div>
        </div>

        <FieldError :message="formError" />
        <AppButton id="biz-settings-save" variant="primary" :loading="saving" @click="saveSettings">
          {{ t('actions.save') }}
        </AppButton>
      </div>
    </AccordionSection>

    <AccordionSection :title="label({ es: 'Servicios', en: 'Services' })">
      <CrudSection
        table-key="services"
        :panel-title="{ es: 'Servicio', en: 'Service' }"
        :delete-label="{ es: 'Eliminar servicio', en: 'Delete service' }"
        :delete-body="{ es: 'Esta acción no se puede deshacer. ¿Confirmás?', en: 'This action cannot be undone. Confirm?' }"
      />
    </AccordionSection>

    <AccordionSection :title="label({ es: 'Servicios por profesional', en: 'Service bindings' })">
      <p class="mb-3 text-sm text-neutral">
        {{ label({ es: 'Qué servicios ofrece cada profesional. Para cambiar un vínculo, eliminá y volvé a crear.', en: 'Which services each professional offers. To change a binding, remove and re-create it.' }) }}
      </p>
      <CrudSection
        table-key="professional_services"
        :panel-title="{ es: 'Servicio del Profesional', en: 'Professional Service' }"
        :delete-label="{ es: 'Eliminar vínculo', en: 'Remove binding' }"
        :delete-body="{ es: 'Se quitará este servicio del profesional. ¿Confirmás?', en: 'This service will be removed from the professional. Confirm?' }"
      />
    </AccordionSection>

    <AccordionSection :title="label({ es: 'Recursos', en: 'Resources' })">
      <ResourcesSection />
    </AccordionSection>

    <AccordionSection :title="label({ es: 'Permisos de calendario', en: 'Calendar permissions' })">
      <div class="space-y-4">
        <ProfessionalPicker v-model="grantProfessionalId" />
        <CalendarGrantsSection :professional-user-id="grantProfessionalId" />
      </div>
    </AccordionSection>
  </div>
</template>
