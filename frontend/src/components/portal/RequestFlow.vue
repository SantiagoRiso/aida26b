<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n, Translation as I18nT } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { checkConflict } from '@/api/scheduling';
import { requestAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { TableRecordMap } from '@shared/ssot/derived';
import { useCurrency } from '@/composables/useCurrency';
import { addDaysISO, intervalMinutes } from '@/composables/bookingForm';
import { useBookingOptions } from '@/composables/useBookingOptions';
import { useBookingWindow } from '@/composables/useBookingWindow';
import SlotPicker from '@/components/calendar/SlotPicker.vue';
import Selector from '@/components/shared/Selector.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Skeleton from '@/components/shared/Skeleton.vue';
import DateField from '@/components/shared/DateField.vue';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/20/solid';
import { useStateLabel } from '@/composables/useStateLabel';

const emit = defineEmits<{
  success: [appt: Appointment];
}>();

const { t } = useI18n();
const { stateLabel } = useStateLabel();
const auth = useAuthStore();
const ui = useUiStore();
const { formatARS, formatDate } = useCurrency();

type Step = 1 | 2 | 3;
const step = ref<Step>(1);

type ServiceRow = TableRecordMap['services'];

const selectedProfId = ref<number | null>(null);
const selectedServiceId = ref<string | null>(null);

const {
  loading: loadingOptions,
  professionals,
  services,
  rankedProfessionals,
  serviceNamesByProfessional,
  availableServices,
} = useBookingOptions({
  rankByRecency: true,
  selectedProfessionalId: () => (selectedProfId.value != null ? String(selectedProfId.value) : null),
});

const servicesById = computed(() => new Map(services.value.map((service) => [service.id, service])));
const professionalsById = computed(() => new Map(professionals.value.map((professional) => [professional.id, professional])));
const selectedService = computed<ServiceRow | null>(() =>
  selectedServiceId.value == null
    ? null
    : servicesById.value.get(selectedServiceId.value) ?? null,
);

interface ProfOption { value: string; label: string; bio: string | null; services: string }

const professionalOptions = computed<ProfOption[]>(() =>
  rankedProfessionals.value.map((p) => ({
    value: p.id,
    label: p.display_name,
    bio: p.bio ?? null,
    services: (serviceNamesByProfessional.value.get(p.id) ?? []).join(', '),
  })),
);

// Options for the Selector; the component renders a lone service as a read-only label and auto-picks it.
const serviceSelectOptions = computed(() =>
  availableServices.value.map((s) => ({
    value: s.id,
    label: `${s.name} (${s.default_duration_minutes}min)`,
  })),
);

// Drop a chosen service the newly picked professional doesn't offer (Selector auto-picks a lone one).
watch(availableServices, (opts) => {
  if (selectedServiceId.value && !opts.some((s) => s.id === selectedServiceId.value)) {
    selectedServiceId.value = null;
  }
});

const selectedDate = ref<string>('');
const selectedStart = ref<string | null>(null);
const selectedSlotDuration = ref<number>(0);

const { windowMax, minDate } = useBookingWindow(
  selectedProfId,
  computed(() => (selectedService.value ? Number(selectedService.value.id) : null)),
);

watch([selectedProfId, selectedService], () => {
  selectedDate.value = '';
  selectedStart.value = null;
  selectedSlotDuration.value = 0;
});

watch(selectedDate, () => {
  selectedStart.value = null;
  selectedSlotDuration.value = 0;
});

function onSlotSelected(slot: { start: string; end: string }) {
  selectedStart.value = slot.start;
  selectedSlotDuration.value = intervalMinutes(slot.start, slot.end);
}

const effectivePrice = ref<string | null>(null);
const loadingPrice = ref(false);
const priceError = ref(false);

async function loadEffectivePrice() {
  if (!selectedProfId.value || !selectedService.value || !selectedDate.value || !selectedStart.value) return;
  if (!auth.user) return;

  loadingPrice.value = true;
  priceError.value = false;

  // /conflict-check REQUIRES duration_minutes — supply the service default.
  const res = await checkConflict({
    professional_user_id: selectedProfId.value,
    service_id: Number(selectedService.value.id),
    client_user_id: auth.user.id,
    date: selectedDate.value,
    start: selectedStart.value,
    duration_minutes: selectedService.value.default_duration_minutes,
  });

  loadingPrice.value = false;

  if (res.ok) {
    effectivePrice.value = res.data.effective_price;
  } else {
    // Fallback to the service default price (display-only — /request captures the authoritative price).
    effectivePrice.value = selectedService.value.default_price_ars;
    priceError.value = true;
  }
}

const submitting = ref(false);
// Flag, not a message string, so the warning re-renders on language switch.
const slotConflict = ref(false);

async function submitRequest() {
  if (!selectedProfId.value || !selectedService.value || !selectedDate.value || !selectedStart.value) return;

  submitting.value = true;
  slotConflict.value = false;

  // Duration is the service default — clients cannot set a custom one; no resource/override.
  const res = await requestAppointment({
    professional_user_id: selectedProfId.value,
    service_id: Number(selectedService.value.id),
    date: selectedDate.value,
    start: selectedStart.value,
    duration_minutes: selectedService.value.default_duration_minutes,
  });

  submitting.value = false;

  if (!res.ok) {
    // The window can move between load and submit; name that reason instead of a generic failure.
    ui.toast('error', res.code === 'outside_booking_window' ? 'outsideBookingWindow' : 'genericError');
    return;
  }

  // If the server returns a conflict verdict (saved=false), the slot is gone.
  // Clients CANNOT override — reload slots and show a message.
  if (!res.data.saved) {
    slotConflict.value = true;
    step.value = 2;
    selectedStart.value = null;
    return;
  }

  emit('success', res.data.appointment);
}

const canGoStep2 = computed(() => !!selectedProfId.value && !!selectedService.value);
const canGoStep3 = computed(() => canGoStep2.value && !!selectedDate.value && !!selectedStart.value);
const canConfirm = computed(() => canGoStep3.value && !loadingPrice.value);

function goStep2() {
  if (canGoStep2.value) step.value = 2;
}

function goStep3() {
  if (canGoStep3.value) {
    step.value = 3;
    loadEffectivePrice();
  }
}


// Prev/next day arrows for the date field (mirrors the staff appointment form), clamped to the
// booking window so clients can't step into the past or past the window's far end. From empty,
// stepping starts at min.
function stepDate(days: number): void {
  let next = addDaysISO(selectedDate.value || minDate.value, days);
  if (next < minDate.value) next = minDate.value;
  if (windowMax.value && next > windowMax.value) next = windowMax.value;
  selectedDate.value = next;
}
const atMinDate = computed(() => (selectedDate.value || minDate.value) <= minDate.value);
const atMaxDate = computed(() => windowMax.value != null && (selectedDate.value || minDate.value) >= windowMax.value);
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center gap-2 text-sm text-neutral">
      <span :class="step >= 1 ? 'font-semibold text-accent' : ''">{{ t('portal.step1') }}</span>
      <span>›</span>
      <span :class="step >= 2 ? 'font-semibold text-accent' : ''">{{ t('portal.step2') }}</span>
      <span>›</span>
      <span :class="step >= 3 ? 'font-semibold text-accent' : ''">{{ t('portal.step3') }}</span>
    </div>

    <section v-if="step === 1" class="space-y-4">
      <h2 class="text-lg font-semibold">{{ t('portal.chooseProfService') }}</h2>

      <div v-if="loadingOptions">
        <Skeleton :rows="2" />
      </div>

      <div v-else class="space-y-4">
        <div>
          <label class="mb-1 block text-sm font-medium" for="prof-select">{{ t('portal.professional') }}</label>
          <Selector
            id="prof-select"
            searchable
            :model-value="selectedProfId != null ? String(selectedProfId) : null"
            :options="professionalOptions"
            :extra-search="(o) => `${o.services} ${o.bio ?? ''}`"
            :placeholder="t('portal.professionalSearchPlaceholder')"
            @update:model-value="selectedProfId = $event ? Number($event) : null"
          >
            <template #option="{ option }">
              <div class="flex items-baseline gap-2">
                <span class="flex-shrink-0 font-medium">{{ option.label }}</span>
                <span v-if="option.bio" class="min-w-0 truncate text-xs text-neutral">{{ option.bio }}</span>
              </div>
              <div v-if="option.services" class="truncate text-sm text-accent">{{ option.services }}</div>
            </template>
          </Selector>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium" for="svc-select">{{ t('portal.service') }}</label>
          <Selector
            id="svc-select"
            :model-value="selectedServiceId"
            :options="serviceSelectOptions"
            :placeholder="t('portal.servicePlaceholder')"
            @update:model-value="selectedServiceId = $event"
          />
        </div>

        <AppButton :disabled="!canGoStep2" @click="goStep2">
          {{ t('portal.next') }}
        </AppButton>
      </div>
    </section>

    <section v-if="step === 2" class="space-y-4">
      <h2 class="text-lg font-semibold">{{ t('portal.chooseDateTime') }}</h2>

      <div v-if="slotConflict" class="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800" role="alert">
        {{ t('portal.slotNoLongerAvailable') }}
      </div>

      <div>
        <label class="mb-1 block text-sm font-medium" for="date-input">{{ t('portal.date') }}</label>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-border text-neutral hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="atMinDate"
            :aria-label="t('calendar.prevDay')"
            @click="stepDate(-1)"
          >
            <ChevronLeftIcon class="h-5 w-5" />
          </button>
          <DateField id="date-input" v-model="selectedDate" :min="minDate" :max="windowMax" class="flex-1" />
          <button
            type="button"
            class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-border text-neutral hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="atMaxDate"
            :aria-label="t('calendar.nextDay')"
            @click="stepDate(1)"
          >
            <ChevronRightIcon class="h-5 w-5" />
          </button>
        </div>
      </div>

      <!-- Only free slots shown; busy time is opaque to clients. -->
      <SlotPicker
        :professional-id="selectedProfId"
        :service-id="selectedService ? Number(selectedService.id) : null"
        :date="selectedDate"
        :model-value="selectedStart"
        @update:model-value="selectedStart = $event"
        @slot-selected="onSlotSelected"
      />

      <div class="flex gap-3">
        <AppButton variant="neutral" @click="step = 1">{{ t('portal.back') }}</AppButton>
        <AppButton :disabled="!canGoStep3" @click="goStep3">{{ t('portal.viewPrice') }}</AppButton>
      </div>
    </section>

    <section v-if="step === 3" class="space-y-4">
      <h2 class="text-lg font-semibold">{{ t('portal.estimatedCost') }}</h2>

      <div v-if="loadingPrice">
        <Skeleton :rows="1" />
      </div>

      <div v-else class="rounded-lg border border-border bg-card p-4 space-y-2">
        <p class="text-sm text-neutral">{{ t('portal.professional') }}: <strong class="text-current">{{ professionalsById.get(String(selectedProfId))?.display_name }}</strong></p>
        <p class="text-sm text-neutral">{{ t('portal.service') }}: <strong class="text-current">{{ selectedService?.name }}</strong></p>
        <p class="text-sm text-neutral">{{ t('portal.date') }}: <strong class="text-current">{{ selectedDate ? formatDate(selectedDate) : '-' }}</strong></p>
        <p class="text-sm text-neutral">{{ t('portal.time') }}: <strong class="text-current">{{ selectedStart }}</strong></p>
        <div class="border-t border-border mt-3 pt-3">
          <p class="text-base font-semibold">
            {{ t('portal.estimatedCost') }}:
            <span class="text-accent">{{ effectivePrice ? formatARS(effectivePrice) : '—' }}</span>
          </p>
          <!-- Framed as expected cost, not an invoice. -->
          <p class="text-xs text-neutral mt-1">
            {{ t('portal.costDisclaimer') }}
          </p>
          <p v-if="priceError" class="text-xs text-amber-600 mt-1">
            {{ t('portal.priceFallbackNote') }}
          </p>
        </div>
      </div>

      <I18nT keypath="portal.requestPendingNote" tag="p" class="text-sm text-neutral">
        <template #status>
          <strong>{{ stateLabel('requested') }}</strong>
        </template>
      </I18nT>

      <div class="flex gap-3">
        <AppButton variant="neutral" @click="step = 2">{{ t('portal.back') }}</AppButton>
        <AppButton :disabled="!canConfirm" :loading="submitting" @click="submitRequest">
          {{ t('actions.requestAppointment') }}
        </AppButton>
      </div>
    </section>
  </div>
</template>
