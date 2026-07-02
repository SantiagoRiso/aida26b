<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { listRows } from '@/api/crud';
import { checkConflict } from '@/api/scheduling';
import { requestAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { TableKey } from '@shared/types/types';
import { useCurrency } from '@/composables/useCurrency';
import SlotPicker from '@/components/calendar/SlotPicker.vue';
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

interface ProfRow { id: number; display_name: string }
interface ServiceRow {
  id: number;
  name: string;
  description?: string | null;
  default_duration_minutes: number;
  default_price_ars: string;
}

const professionals = ref<ProfRow[]>([]);
const services = ref<ServiceRow[]>([]);
const loadingOptions = ref(false);

const selectedProfId = ref<number | null>(null);
const selectedService = ref<ServiceRow | null>(null);

async function loadOptions() {
  loadingOptions.value = true;
  // Services are readable by all roles — use the generic CRUD list endpoint.
  const [profRes, svcRes] = await Promise.all([
    listRows<ProfRow>('professionals' as TableKey),
    listRows<ServiceRow>('services' as TableKey),
  ]);
  loadingOptions.value = false;
  if (profRes.ok) professionals.value = profRes.data;
  if (svcRes.ok) services.value = svcRes.data;
}

loadOptions();

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
    service_id: selectedService.value.id,
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
const conflictMessage = ref<string | null>(null);

async function submitRequest() {
  if (!selectedProfId.value || !selectedService.value || !selectedDate.value || !selectedStart.value) return;

  submitting.value = true;
  conflictMessage.value = null;

  // Duration is the service default — clients cannot set a custom one; no resource/override.
  const res = await requestAppointment({
    professional_user_id: selectedProfId.value,
    service_id: selectedService.value.id,
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
    conflictMessage.value = 'Ese horario ya no está disponible. Por favor elegí otro.';
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

const today = new Date().toISOString().slice(0, 10);
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center gap-2 text-sm text-neutral">
      <span :class="step >= 1 ? 'font-semibold text-accent' : ''">1. Profesional</span>
      <span>›</span>
      <span :class="step >= 2 ? 'font-semibold text-accent' : ''">2. Horario</span>
      <span>›</span>
      <span :class="step >= 3 ? 'font-semibold text-accent' : ''">3. Precio</span>
      <span>›</span>
      <span :class="step >= 4 ? 'font-semibold text-accent' : ''">4. Confirmar</span>
    </div>

    <section v-if="step === 1" class="space-y-4">
      <h2 class="text-lg font-semibold">Elegí profesional y servicio</h2>

      <div v-if="loadingOptions">
        <Skeleton :rows="2" />
      </div>

      <div v-else class="space-y-4">
        <div>
          <label class="mb-1 block text-sm font-medium" for="prof-select">Profesional</label>
          <select
            id="prof-select"
            v-model="selectedProfId"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option :value="null" disabled>Seleccioná un profesional</option>
            <option v-for="p in professionals" :key="p.id" :value="p.id">
              {{ p.display_name }}
            </option>
          </select>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium" for="svc-select">Servicio</label>
          <select
            id="svc-select"
            v-model="selectedService"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option :value="null" disabled>Seleccioná un servicio</option>
            <option v-for="s in services" :key="s.id" :value="s">
              {{ s.name }} ({{ s.default_duration_minutes }}min)
            </option>
          </select>
        </div>

        <AppButton :disabled="!canGoStep2" @click="goStep2">
          Siguiente
        </AppButton>
      </div>
    </section>

    <section v-if="step === 2" class="space-y-4">
      <h2 class="text-lg font-semibold">Elegí fecha y horario</h2>

      <div v-if="conflictMessage" class="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800" role="alert">
        {{ conflictMessage }}
      </div>

      <div>
        <label class="mb-1 block text-sm font-medium" for="date-input">Fecha</label>
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
        <AppButton variant="neutral" @click="step = 1">Volver</AppButton>
        <AppButton :disabled="!canGoStep3" @click="goStep3">Ver precio</AppButton>
      </div>
    </section>

    <section v-if="step === 3" class="space-y-4">
      <h2 class="text-lg font-semibold">Costo estimado</h2>

      <div v-if="loadingPrice">
        <Skeleton :rows="1" />
      </div>

      <div v-else class="rounded-lg border border-border bg-card p-4 space-y-2">
        <p class="text-sm text-neutral">Profesional: <strong class="text-current">{{ professionals.find(p => p.id === selectedProfId)?.display_name }}</strong></p>
        <p class="text-sm text-neutral">Servicio: <strong class="text-current">{{ selectedService?.name }}</strong></p>
        <p class="text-sm text-neutral">Fecha: <strong class="text-current">{{ selectedDate ? formatDate(selectedDate) : '-' }}</strong></p>
        <p class="text-sm text-neutral">Horario: <strong class="text-current">{{ selectedStart }}</strong></p>
        <div class="border-t border-border mt-3 pt-3">
          <p class="text-base font-semibold">
            Costo estimado:
            <span class="text-accent">{{ effectivePrice ? formatARS(effectivePrice) : '—' }}</span>
          </p>
          <!-- Framed as expected cost, not an invoice. -->
          <p class="text-xs text-neutral mt-1">
            Este es el costo esperado al momento de la solicitud. El precio final puede variar.
            No es una factura.
          </p>
          <p v-if="priceError" class="text-xs text-amber-600 mt-1">
            (Precio estimado basado en tarifa del servicio — no se pudo obtener el precio personalizado.)
          </p>
        </div>
      </div>

      <div class="flex gap-3">
        <AppButton variant="neutral" @click="step = 2">Volver</AppButton>
        <AppButton :disabled="!canConfirm" @click="goStep4">Confirmar solicitud</AppButton>
      </div>
    </section>

    <section v-if="step === 4" class="space-y-4">
      <h2 class="text-lg font-semibold">Confirmá tu solicitud</h2>

      <div class="rounded-lg border border-border bg-card p-4 space-y-2">
        <p class="text-sm text-neutral">Profesional: <strong class="text-current">{{ professionals.find(p => p.id === selectedProfId)?.display_name }}</strong></p>
        <p class="text-sm text-neutral">Servicio: <strong class="text-current">{{ selectedService?.name }}</strong></p>
        <p class="text-sm text-neutral">Fecha: <strong class="text-current">{{ selectedDate ? formatDate(selectedDate) : '-' }}</strong></p>
        <p class="text-sm text-neutral">Horario: <strong class="text-current">{{ selectedStart }}</strong></p>
        <p class="text-sm font-semibold">Costo estimado: <span class="text-accent">{{ effectivePrice ? formatARS(effectivePrice) : '—' }}</span></p>
      </div>

      <p class="text-sm text-neutral">
        Tu solicitud queda en estado <strong>Solicitado</strong> hasta que el equipo la revise.
        Vas a ver el resultado en "Mis turnos".
      </p>

      <div class="flex gap-3">
        <AppButton variant="neutral" @click="step = 3">Volver</AppButton>
        <AppButton :loading="submitting" @click="submitRequest">
          {{ t('actions.requestAppointment') }}
        </AppButton>
      </div>
    </section>
  </div>
</template>
