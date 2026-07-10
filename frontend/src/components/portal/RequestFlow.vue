<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n, Translation as I18nT } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { listRows } from '@/api/crud';
import { checkConflict } from '@/api/scheduling';
import { requestAppointment, listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { TableRecordMap } from '@shared/types/types';
import { useCurrency, todayLocalISO } from '@/composables/useCurrency';
import SlotPicker from '@/components/calendar/SlotPicker.vue';
import Selector from '@/components/shared/Selector.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Skeleton from '@/components/shared/Skeleton.vue';

const emit = defineEmits<{
  success: [appt: Appointment];
}>();

const { t } = useI18n();
const auth = useAuthStore();
const ui = useUiStore();
const { formatARS, formatDate } = useCurrency();

type Step = 1 | 2 | 3 | 4;
const step = ref<Step>(1);

type ProfRow = TableRecordMap['professionals'];
type ServiceRow = TableRecordMap['services'];

const professionals = ref<ProfRow[]>([]);
const services = ref<ServiceRow[]>([]);
const profServices = ref<TableRecordMap['professional_services'][]>([]);
// The client's own appointment history — drives the recency ordering of professionals.
const myAppointments = ref<Appointment[]>([]);
const loadingOptions = ref(false);

const selectedProfId = ref<number | null>(null);
const selectedServiceId = ref<string | null>(null);
const selectedService = computed<ServiceRow | null>(() =>
  selectedServiceId.value == null
    ? null
    : services.value.find((s) => String(s.id) === selectedServiceId.value) ?? null,
);

async function loadOptions() {
  loadingOptions.value = true;
  // Services and the professional↔service map are readable by all roles; the appointments list
  // is server-scoped to the calling client.
  const [profRes, svcRes, psRes, apptRes] = await Promise.all([
    listRows('professionals'),
    listRows('services'),
    listRows('professional_services', { limit: 500 }),
    listAppointments({ limit: 200 }),
  ]);
  loadingOptions.value = false;
  if (profRes.ok) professionals.value = profRes.data;
  if (svcRes.ok) services.value = svcRes.data;
  if (psRes.ok) profServices.value = psRes.data;
  if (apptRes.ok) myAppointments.value = apptRes.data;
}

loadOptions();

const serviceNameById = computed(() => {
  const m = new Map<string, string>();
  for (const s of services.value) m.set(String(s.id), s.name);
  return m;
});

const serviceNamesByProf = computed(() => {
  const m = new Map<string, string[]>();
  for (const ps of profServices.value) {
    const name = serviceNameById.value.get(String(ps.service_id));
    if (!name) continue;
    const key = String(ps.professional_user_id);
    const list = m.get(key);
    if (list) list.push(name);
    else m.set(key, [name]);
  }
  return m;
});

// Most-recent interaction (requested or attended) per professional within the last 365 days,
// as an epoch timestamp — higher means more recent, used to rank the picker.
const recencyByProf = computed(() => {
  const cutoff = Date.now() - 365 * 86400000;
  const m = new Map<string, number>();
  for (const a of myAppointments.value) {
    if (a.professional_user_id == null) continue;
    const t = new Date(a.starts_at).getTime();
    if (t < cutoff) continue;
    const key = String(a.professional_user_id);
    const prev = m.get(key);
    if (prev == null || t > prev) m.set(key, t);
  }
  return m;
});

interface ProfOption { value: string; label: string; bio: string | null; services: string }

const professionalOptions = computed<ProfOption[]>(() => {
  const recency = recencyByProf.value;
  const ranked = professionals.value.map((p) => {
    const key = String(p.id);
    return {
      value: key,
      label: p.display_name,
      bio: p.bio ?? null,
      services: (serviceNamesByProf.value.get(key) ?? []).join(', '),
      recency: recency.get(key) ?? null,
    };
  });
  ranked.sort((a, b) => {
    if (a.recency != null && b.recency != null) return b.recency - a.recency;
    if (a.recency != null) return -1;
    if (b.recency != null) return 1;
    return a.label.localeCompare(b.label);
  });
  return ranked.map(({ recency: _r, ...rest }) => rest);
});

// The service list is scoped to what the chosen professional offers (mirrors the staff form);
// with no professional selected, or a professional with no mapping, fall back to every service.
const availableServices = computed<ServiceRow[]>(() => {
  const profId = selectedProfId.value;
  if (profId == null) return services.value;
  const offered = new Set(
    profServices.value
      .filter((ps) => String(ps.professional_user_id) === String(profId))
      .map((ps) => String(ps.service_id)),
  );
  if (offered.size === 0) return services.value;
  return services.value.filter((s) => offered.has(String(s.id)));
});

// Options for the Selector; the component renders a lone service as a read-only label and auto-picks it.
const serviceSelectOptions = computed(() =>
  availableServices.value.map((s) => ({
    value: String(s.id),
    label: `${s.name} (${s.default_duration_minutes}min)`,
  })),
);

// Drop a chosen service the newly picked professional doesn't offer (Selector auto-picks a lone one).
watch(availableServices, (opts) => {
  if (selectedServiceId.value && !opts.some((s) => String(s.id) === selectedServiceId.value)) {
    selectedServiceId.value = null;
  }
});

const selectedDate = ref<string>('');
const selectedStart = ref<string | null>(null);
const selectedSlotDuration = ref<number>(0);

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
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  selectedSlotDuration.value = (eh * 60 + em) - (sh * 60 + sm);
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
    ui.toast('error', 'genericError');
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

function goStep4() {
  step.value = 4;
}

const today = todayLocalISO();
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center gap-2 text-sm text-neutral">
      <span :class="step >= 1 ? 'font-semibold text-accent' : ''">{{ t('portal.step1') }}</span>
      <span>›</span>
      <span :class="step >= 2 ? 'font-semibold text-accent' : ''">{{ t('portal.step2') }}</span>
      <span>›</span>
      <span :class="step >= 3 ? 'font-semibold text-accent' : ''">{{ t('portal.step3') }}</span>
      <span>›</span>
      <span :class="step >= 4 ? 'font-semibold text-accent' : ''">{{ t('portal.step4') }}</span>
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
        <input
          id="date-input"
          v-model="selectedDate"
          type="date"
          :min="today"
          class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <!-- Only free slots shown; busy time is opaque to clients. -->
      <SlotPicker
        :professional-id="selectedProfId"
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
        <p class="text-sm text-neutral">{{ t('portal.professional') }}: <strong class="text-current">{{ professionals.find(p => String(p.id) === String(selectedProfId))?.display_name }}</strong></p>
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

      <div class="flex gap-3">
        <AppButton variant="neutral" @click="step = 2">{{ t('portal.back') }}</AppButton>
        <AppButton :disabled="!canConfirm" @click="goStep4">{{ t('portal.confirmRequest') }}</AppButton>
      </div>
    </section>

    <section v-if="step === 4" class="space-y-4">
      <h2 class="text-lg font-semibold">{{ t('portal.confirmRequestHeading') }}</h2>

      <div class="rounded-lg border border-border bg-card p-4 space-y-2">
        <p class="text-sm text-neutral">{{ t('portal.professional') }}: <strong class="text-current">{{ professionals.find(p => String(p.id) === String(selectedProfId))?.display_name }}</strong></p>
        <p class="text-sm text-neutral">{{ t('portal.service') }}: <strong class="text-current">{{ selectedService?.name }}</strong></p>
        <p class="text-sm text-neutral">{{ t('portal.date') }}: <strong class="text-current">{{ selectedDate ? formatDate(selectedDate) : '-' }}</strong></p>
        <p class="text-sm text-neutral">{{ t('portal.time') }}: <strong class="text-current">{{ selectedStart }}</strong></p>
        <p class="text-sm font-semibold">{{ t('portal.estimatedCost') }}: <span class="text-accent">{{ effectivePrice ? formatARS(effectivePrice) : '—' }}</span></p>
      </div>

      <I18nT keypath="portal.requestPendingNote" tag="p" class="text-sm text-neutral">
        <template #status>
          <strong>{{ t('status.requested') }}</strong>
        </template>
      </I18nT>

      <div class="flex gap-3">
        <AppButton variant="neutral" @click="step = 3">{{ t('portal.back') }}</AppButton>
        <AppButton :loading="submitting" @click="submitRequest">
          {{ t('actions.requestAppointment') }}
        </AppButton>
      </div>
    </section>
  </div>
</template>
