<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { getSettings, updateSettings } from '@/api/business';
import { apiErrorMessage, fieldErrorMessages } from '@/i18n/api-errors';
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

const businessId = computed(() => auth.user?.business_id);

const staffProfessionalId = ref<number | null>(null);

const cutoffHours = ref<number | null>(null);
const minDays = ref<number | null>(null);
// The number input yields '' when cleared; treat that as "no cap" (null).
const maxDays = ref<number | '' | null>(null);
const saving = ref(false);
const formError = ref('');
// Server per-field reasons, keyed by the settings column the backend names (e.g. max_booking_days).
const fieldErrors = reactive<Record<string, string>>({});

function clearFieldErrors() {
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key];
}

onMounted(async () => {
  if (!businessId.value) return;
  const result = await getSettings(businessId.value);
  if (!result.ok) return;
  // A slow load must not overwrite a field the user already edited while it was in flight — each
  // field is still null until the user types or this load fills it.
  if (cutoffHours.value === null) cutoffHours.value = result.data.cancellation_cutoff_hours;
  if (minDays.value === null) minDays.value = result.data.min_booking_days;
  if (maxDays.value === null) maxDays.value = result.data.max_booking_days;
});

function nonNegInt(v: number | null): boolean {
  return v != null && Number.isInteger(v) && v >= 0;
}

async function saveSettings() {
  formError.value = '';
  clearFieldErrors();
  const max = maxDays.value === '' || maxDays.value == null ? null : maxDays.value;

  if (!nonNegInt(cutoffHours.value) || !nonNegInt(minDays.value)) {
    formError.value = t('business.valuesNonNegative');
    return;
  }
  if (max !== null && (!Number.isInteger(max) || max < 0)) {
    formError.value = t('business.maxDaysInvalid');
    return;
  }
  if (max !== null && max < (minDays.value as number)) {
    formError.value = t('business.maxBelowMin');
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

  if (result.ok) {
    ui.toast('success', 'settingsSaved');
    return;
  }
  // Place each server field reason (max-below-min, non-negative integer…) on the field it names;
  // when the rejection carries no per-field detail, fall back to the translated top-level code.
  const serverFieldErrors = fieldErrorMessages(result);
  if (Object.keys(serverFieldErrors).length > 0) {
    Object.assign(fieldErrors, serverFieldErrors);
  } else {
    ui.toast('error', apiErrorMessage(result, 'toast.genericError'));
  }
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">
      {{ t('nav.business') }}
    </h1>

    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('business.generalHeading') }}</h2>
        <div class="flex flex-wrap gap-4">
          <div>
            <label for="biz-cutoff" class="block text-sm font-semibold text-heading mb-1">
              {{ t('business.cancellationCutoff') }}
            </label>
            <input id="biz-cutoff" v-model.number="cutoffHours" type="number" min="0" step="1"
              :class="fieldErrors.cancellation_cutoff_hours ? 'border-destructive' : 'border-border'"
              :aria-invalid="fieldErrors.cancellation_cutoff_hours ? 'true' : undefined"
              :aria-describedby="fieldErrors.cancellation_cutoff_hours ? 'biz-cutoff-error' : undefined"
              class="w-32 rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
            <FieldError id="biz-cutoff-error" :message="fieldErrors.cancellation_cutoff_hours" />
          </div>
          <div>
            <label for="biz-min-days" class="block text-sm font-semibold text-heading mb-1">
              {{ t('business.minBookingDays') }}
            </label>
            <input id="biz-min-days" v-model.number="minDays" type="number" min="0" step="1"
              :class="fieldErrors.min_booking_days ? 'border-destructive' : 'border-border'"
              :aria-invalid="fieldErrors.min_booking_days ? 'true' : undefined"
              :aria-describedby="fieldErrors.min_booking_days ? 'biz-min-days-error' : undefined"
              class="w-32 rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
            <FieldError id="biz-min-days-error" :message="fieldErrors.min_booking_days" />
          </div>
          <div>
            <label for="biz-max-days" class="block text-sm font-semibold text-heading mb-1">
              {{ t('business.maxBookingDays') }}
            </label>
            <input id="biz-max-days" v-model.number="maxDays" type="number" min="0" step="1"
              :placeholder="t('business.noCap')"
              :class="fieldErrors.max_booking_days ? 'border-destructive' : 'border-border'"
              :aria-invalid="fieldErrors.max_booking_days ? 'true' : undefined"
              :aria-describedby="fieldErrors.max_booking_days ? 'biz-max-days-error' : undefined"
              class="w-32 rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums" />
            <FieldError id="biz-max-days-error" :message="fieldErrors.max_booking_days" />
          </div>
        </div>
        <FieldError :message="formError" />
        <AppButton id="biz-settings-save" variant="primary" :loading="saving" @click="saveSettings">
          {{ t('actions.save') }}
        </AppButton>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('business.staffAdminHeading') }}</h2>
        <ProfessionalPicker v-model="staffProfessionalId" />
        <div class="space-y-6">
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-heading">{{ t('business.calendarPermissions') }}</h3>
            <CalendarGrantsSection :professional-user-id="staffProfessionalId" />
          </div>
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-heading">{{ t('business.offeredServices') }}</h3>
            <ProfessionalServicesSection :professional-user-id="staffProfessionalId" />
          </div>
        </div>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('business.roomsHeading') }}</h2>
        <ResourcesSection />
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('business.holidaysHeading') }}</h2>
        <BusinessClosuresSection />
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4 lg:col-span-2">
        <h2 class="text-lg font-semibold text-heading">{{ t('business.servicesHeading') }}</h2>
        <CrudSection
          table-key="services"
          :hide-title="true"
          :hide-filters="true"
          :panel-title="t('calendar.serviceLabel')"
          :delete-label="t('business.deleteService')"
          :delete-body="t('generic.irreversible')"
        />
      </section>
    </div>
  </div>
</template>
