<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useCurrency } from '@/composables/useCurrency';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import CalendarView from '@/components/calendar/CalendarView.vue';
import StatusBadge from '@/components/portal/StatusBadge.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';

const { t } = useI18n();
const auth = useAuthStore();
const ui = useUiStore();
const { formatDateTime, formatARS } = useCurrency();

const appointments = ref<Appointment[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  const res = await listAppointments({ limit: 100 });
  loading.value = false;
  if (res.ok) {
    // Server already scopes to the caller's own appointments for Client role.
    appointments.value = res.data;
  }
}

onMounted(load);

// For a client, the professional's name is the informative default — their own name
// (or "Turno #id") says nothing.
const { options: professionalOptions } = useForeignKeyOptions({
  table: 'professionals', valueField: 'id', labelField: 'display_name',
});
function professionalNameFor(appt: Appointment): string | null {
  return professionalOptions.value.find((o) => o.value === String(appt.professional_user_id))?.label ?? null;
}

// Clients cannot create, drag, or resize — read-only calendar, handlers are no-ops.
const { calendarOptions } = useAppointmentCalendar(
  appointments,
  computed(() => auth.user),
  {
    onSelect: () => {},
    onEventClick: () => {},
    onEventDrop: () => {},
    onEventResize: () => {},
  },
  {
    fallbackTitle: professionalNameFor,
    tooltip: (appt) =>
      [professionalNameFor(appt), t(`status.${appt.state}`)].filter(Boolean).join(' · '),
  },
);

// Cancel is blocked within cutoff hours of the start. The backend 422 is the real gate;
// the UI disables as a UX layer only. No client settings endpoint, so fall back to 24h.
const CUTOFF_HOURS_FALLBACK = 24;

function isCancelable(appt: Appointment): boolean {
  if (appt.state === 'requested') return true; // withdraw anytime
  if (appt.state !== 'scheduled') return false;
  const startsAt = new Date(appt.starts_at);
  const hoursUntil = (startsAt.getTime() - Date.now()) / (1000 * 60 * 60);
  return hoursUntil > CUTOFF_HOURS_FALLBACK;
}

function cancelBlockedReason(appt: Appointment): string | null {
  if (appt.state === 'requested') return null;
  if (appt.state !== 'scheduled') return null;
  const startsAt = new Date(appt.starts_at);
  const hoursUntil = (startsAt.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil <= CUTOFF_HOURS_FALLBACK) {
    // Visible explanation, not just a tooltip.
    return `Ya pasó el plazo para cancelar este turno (${CUTOFF_HOURS_FALLBACK}h antes del inicio).`;
  }
  return null;
}

const cancelTarget = ref<Appointment | null>(null);
const canceling = ref(false);

function requestCancel(appt: Appointment) {
  cancelTarget.value = appt;
}

function dismissCancel() {
  cancelTarget.value = null;
}

async function confirmCancel() {
  if (!cancelTarget.value) return;
  canceling.value = true;
  const res = await transitionAppointment(cancelTarget.value.id, 'canceled');
  canceling.value = false;
  cancelTarget.value = null;

  if (res.ok) {
    await load();
  } else {
    const msg =
      res.code === 'outside_cutoff'
        ? 'No se puede cancelar: el turno ya está dentro del plazo de cancelación.'
        : t('toast.genericError');
    ui.toast('error', 'genericError');
    console.warn('Cancel failed:', msg);
  }
}

const now = new Date();
const upcoming = computed(() =>
  appointments.value
    .filter((a) => new Date(a.starts_at) >= now || a.state === 'requested')
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()),
);
const past = computed(() =>
  appointments.value
    .filter((a) => new Date(a.starts_at) < now && a.state !== 'requested')
    .sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()),
);
</script>

<template>
  <div class="space-y-8">
    <h1 class="text-2xl font-bold">{{ t('nav.myAppointments') }}</h1>

    <div v-if="loading">
      <Skeleton variant="row" :rows="4" />
    </div>

    <EmptyState
      v-else-if="!loading && appointments.length === 0"
      :heading="t('emptyState.noAppointmentsHeading')"
      :body="t('emptyState.noAppointmentsBody')"
    />

    <template v-else>
      <section v-if="upcoming.length > 0" aria-label="Próximos turnos">
        <h2 class="mb-3 text-lg font-semibold">Próximos turnos</h2>
        <ul class="space-y-3">
          <li
            v-for="appt in upcoming"
            :key="appt.id"
            class="rounded-lg border border-border bg-card p-4"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <StatusBadge :state="appt.state" />
                  <span class="text-sm font-semibold">
                    {{ appt.state === 'requested' ? 'Pendiente de aprobación' : formatDateTime(appt.starts_at) }}
                  </span>
                </div>
                <p v-if="appt.state !== 'requested'" class="text-xs text-neutral">
                  {{ formatDateTime(appt.starts_at) }} · {{ appt.duration_minutes }}min
                </p>
                <p class="text-sm">
                  {{ professionalNameFor(appt) ?? `Turno #${appt.id}` }}
                  <span v-if="appt.name"> · {{ appt.name }}</span>
                </p>
                <p class="text-xs text-neutral">Precio: {{ formatARS(appt.price) }}</p>

                <p
                  v-if="cancelBlockedReason(appt)"
                  class="mt-1 text-xs text-destructive"
                  role="alert"
                >
                  {{ cancelBlockedReason(appt) }}
                </p>
              </div>

              <!-- Cancel only; clients get no reschedule affordance. -->
              <div v-if="['requested', 'scheduled'].includes(appt.state)" class="flex-shrink-0">
                <button
                  v-if="isCancelable(appt)"
                  type="button"
                  class="min-h-[36px] rounded-md border border-destructive px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-red-50 transition-colors"
                  @click="requestCancel(appt)"
                >
                  {{ appt.state === 'requested' ? 'Retirar solicitud' : 'Cancelar' }}
                </button>
                <!-- Visible disabled state, not tooltip-only. -->
                <button
                  v-else-if="cancelBlockedReason(appt)"
                  type="button"
                  class="min-h-[36px] rounded-md border border-border px-3 py-1.5 text-sm font-semibold text-neutral opacity-50 cursor-not-allowed"
                  disabled
                  aria-disabled="true"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section aria-label="Calendario de mis turnos">
        <h2 class="mb-3 text-lg font-semibold">Calendario</h2>
        <CalendarView :options="calendarOptions" />
      </section>

      <section v-if="past.length > 0" aria-label="Historial de turnos">
        <h2 class="mb-3 text-lg font-semibold">Historial</h2>
        <ul class="space-y-2">
          <li
            v-for="appt in past"
            :key="appt.id"
            class="rounded-lg border border-border bg-card p-3"
          >
            <div class="flex items-center gap-3 flex-wrap">
              <StatusBadge :state="appt.state" />
              <span class="text-sm">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="text-sm text-neutral">{{ professionalNameFor(appt) ?? `Turno #${appt.id}` }}</span>
              <span class="text-sm text-neutral">{{ formatARS(appt.price) }}</span>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>

  <ConfirmDialog
    :open="cancelTarget !== null"
    title="Cancelar turno"
    :body="
      cancelTarget?.state === 'requested'
        ? '¿Retirás tu solicitud de turno? Esta acción no se puede deshacer.'
        : '¿Cancelás este turno? Esta acción no se puede deshacer.'
    "
    :confirm-label="cancelTarget?.state === 'requested' ? 'Retirar solicitud' : 'Cancelar turno'"
    :destructive="true"
    @confirm="confirmCancel"
    @cancel="dismissCancel"
  />
</template>
