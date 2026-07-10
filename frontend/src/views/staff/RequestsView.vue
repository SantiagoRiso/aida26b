<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLabel } from '@/composables/useLabel';
import { useCurrency } from '@/composables/useCurrency';
import { useToast } from '@/composables/useToast';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { getRow } from '@/api/crud';
import { getBalance } from '@/api/ledger';
import { listAppointments, approveAppointment, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { getAvailability } from '@/api/scheduling';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import type { TableRecordMap } from '@shared/types/types';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { latticeFromFreeSlots } from '@/composables/calendarGrid';
import type { AuthUser } from '@/stores/auth';
import type { EventContentArg } from '@fullcalendar/core';
import AppButton from '@/components/shared/AppButton.vue';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import CalendarView from '@/components/calendar/CalendarView.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';

// The server scopes /appointments by role (Admin: all, Professional: own,
// Receptionist: granted), so the requested rows returned here already respect
// who may see which requests.
const { t } = useI18n();
const { label } = useLabel();
const { formatDateTime, formatARS } = useCurrency();
const toast = useToast();

const requests = ref<Appointment[]>([]);
const loading = ref(false);
const acting = ref(false);

async function load() {
  loading.value = true;
  const res = await listAppointments({ state: 'requested', limit: 200 });
  loading.value = false;
  if (res.ok) {
    requests.value = res.data
      .slice()
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }
}
onMounted(load);

const { labelFor: clientLabelFor } = useForeignKeyOptions({ table: 'clients', valueField: 'id', labelField: 'display_name' });
const { labelFor: professionalLabelFor } = useForeignKeyOptions({ table: 'professionals', valueField: 'id', labelField: 'display_name' });
const { labelFor: serviceLabelFor } = useForeignKeyOptions({ table: 'services', valueField: 'id', labelField: 'name' });

function clientName(a: Appointment): string {
  return clientLabelFor(a.client_user_id) ?? a.name ?? `Turno #${a.id}`;
}
function professionalName(a: Appointment): string {
  return professionalLabelFor(a.professional_user_id) ?? '—';
}
function serviceName(a: Appointment): string {
  return serviceLabelFor(a.service_id) ?? '—';
}

// Detail drawer: full client context so a request can be triaged without leaving the list.
const detailAppt = ref<Appointment | null>(null);
const detailOpen = ref(false);
const clientProfile = ref<TableRecordMap['clients'] | null>(null);
const clientBalance = ref<string | null>(null);
const clientAppts = ref<Appointment[]>([]);
const loadingDetail = ref(false);

// The professional's whole day around the requested slot — shown as a read-only day calendar
// so the request can be judged against that day's existing schedule.
const dayAppts = ref<Appointment[]>([]);
// The professional's slot lattice for that day, so the day-calendar grid rows land on real slots.
const daySlotStarts = ref<number[] | null>(null);
const daySlotMinutes = ref<number | null>(null);

function dayAfter(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function openDetail(appt: Appointment) {
  detailAppt.value = appt;
  detailOpen.value = true;
  clientProfile.value = null;
  clientBalance.value = null;
  clientAppts.value = [];
  dayAppts.value = [];
  daySlotStarts.value = null;
  daySlotMinutes.value = null;
  const cid = appt.client_user_id;
  loadingDetail.value = true;
  const day = appt.starts_at.slice(0, 10);
  // Ledger reads are allowed for anyone who can see the request (the request itself is the
  // relationship). The appointment history is the caller's own scoped view of this client.
  const [prof, bal, appts, proDay, avail] = await Promise.all([
    cid != null ? getRow('clients', cid) : Promise.resolve(null),
    cid != null ? getBalance(cid) : Promise.resolve(null),
    cid != null ? listAppointments({ client_user_id: cid, limit: 500 }) : Promise.resolve(null),
    listAppointments({
      professional_user_id: appt.professional_user_id,
      date_from: day,
      date_to: dayAfter(day),
      limit: 200,
    }),
    getAvailability(`prof:${appt.professional_user_id}`, day),
  ]);
  if (prof && prof.ok) clientProfile.value = prof.data;
  clientBalance.value = bal && bal.ok ? bal.data.balance_ars : null;
  clientAppts.value = appts && appts.ok ? appts.data : [];
  dayAppts.value = proDay.ok ? proDay.data : [];
  if (avail.ok) {
    const grid = latticeFromFreeSlots(avail.data.slots);
    daySlotStarts.value = grid.starts;
    daySlotMinutes.value = grid.minutes;
  }
  loadingDetail.value = false;
}

function closeDetail() {
  detailOpen.value = false;
}

// Clear the loaded data only after the close animation, so the panel keeps its content
// through the leave transition instead of blanking mid-close.
function onDetailAfterLeave() {
  detailAppt.value = null;
  clientProfile.value = null;
  clientBalance.value = null;
  clientAppts.value = [];
  dayAppts.value = [];
  daySlotStarts.value = null;
  daySlotMinutes.value = null;
}

// Read-only day calendar for the request's professional + date. Null viewer keeps it
// non-editable; a fresh :key per request re-applies initialDate on open.
const nullViewer = ref<AuthUser | null>(null);
const fineDrag = ref(false);
const { calendarOptions: dayCalendarBase } = useAppointmentCalendar(
  dayAppts,
  nullViewer,
  { onSelect: () => {}, onEventClick: () => {}, onEventDrop: () => {}, onEventResize: () => {} },
  { fallbackTitle: (a) => clientLabelFor(a.client_user_id) },
  { fine: fineDrag, slotStartsMinutes: daySlotStarts, slotMinutes: daySlotMinutes },
);
const dayCalendarOptions = computed(() => ({
  ...dayCalendarBase.value,
  initialView: 'timeGridDay',
  initialDate: detailAppt.value ? detailAppt.value.starts_at.slice(0, 10) : undefined,
  headerToolbar: false as const,
  // Fill the calendar column instead of a short fixed block (parent gives it the height).
  height: '100%' as const,
  expandRows: true,
  selectable: false,
  editable: false,
  eventClassNames: (arg: EventContentArg) =>
    detailAppt.value && arg.event.id === String(detailAppt.value.id) ? ['fc-current-request'] : [],
}));

const balancePositive = computed(
  () => clientBalance.value != null && parseFloat(clientBalance.value) > 0,
);
const detailHistory = computed(() =>
  [...clientAppts.value].sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
);
const canceledCount = computed(() => clientAppts.value.filter((a) => a.state === 'canceled').length);
const noShowCount = computed(() => clientAppts.value.filter((a) => a.state === 'no_show').length);
const completedCount = computed(() => clientAppts.value.filter((a) => a.state === 'completed').length);

// Approve routes through the conflict-aware endpoint: a full slot warns first (override)
// instead of silently failing — same warn-then-confirm flow as the calendar.
const conflictVerdict = ref<ConflictVerdict | null>(null);
const conflictOpen = ref(false);
const conflictRetryFn = ref<((override: boolean) => Promise<void>) | null>(null);

async function approve(appt: Appointment, override = false) {
  acting.value = true;
  const result = await approveAppointment(appt.id, override);
  acting.value = false;
  if (!result.ok) {
    toast.error('genericError');
    return;
  }
  const payload = result.data;
  if (!payload.saved) {
    conflictVerdict.value = payload.verdict;
    conflictRetryFn.value = (ov) => approve(appt, ov);
    conflictOpen.value = true;
    return;
  }
  toast.success('requestApproved');
  closeDetail();
  await load();
}

function onOverrideConfirm() {
  conflictOpen.value = false;
  const retry = conflictRetryFn.value;
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
  if (retry) void retry(true);
}
function onOverrideCancel() {
  conflictOpen.value = false;
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
}

const rejectTarget = ref<Appointment | null>(null);
async function confirmReject() {
  const appt = rejectTarget.value;
  rejectTarget.value = null;
  if (!appt) return;
  acting.value = true;
  const result = await transitionAppointment(appt.id, 'rejected');
  acting.value = false;
  if (result.ok) {
    toast.success('requestRejected');
    closeDetail();
    await load();
  } else {
    toast.error('genericError');
  }
}
</script>

<template>
  <div class="p-6">
    <h1 class="text-[28px] font-semibold leading-tight text-heading mb-6">
      {{ label({ es: 'Solicitudes', en: 'Requests' }) }}
    </h1>

    <div v-if="loading">
      <Skeleton variant="row" :rows="4" />
    </div>

    <EmptyState
      v-else-if="requests.length === 0"
      :heading="label({ es: 'Sin solicitudes pendientes', en: 'No pending requests' })"
      :body="label({ es: 'Cuando un cliente pida un turno, va a aparecer acá.', en: 'When a client requests an appointment, it shows up here.' })"
    />

    <ul v-else class="space-y-3">
      <li
        v-for="appt in requests"
        :key="appt.id"
        class="cursor-pointer rounded-lg border border-border bg-card p-4 transition-colors hover:border-accent/50 hover:bg-accent/5"
        role="button"
        tabindex="0"
        @click="openDetail(appt)"
        @keydown.enter="openDetail(appt)"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex-1 space-y-1">
            <p class="text-sm font-semibold text-heading">{{ clientName(appt) }}</p>
            <p class="text-sm text-neutral">
              {{ formatDateTime(appt.starts_at) }} · {{ appt.duration_minutes }} min
            </p>
            <p class="text-sm text-neutral">
              {{ professionalName(appt) }} · {{ serviceName(appt) }}
            </p>
            <p class="text-xs text-neutral">{{ formatARS(appt.price) }}</p>
          </div>

          <div class="flex flex-shrink-0 gap-2">
            <AppButton variant="primary" :loading="acting" @click.stop="approve(appt)">
              {{ label({ es: 'Aprobar', en: 'Approve' }) }}
            </AppButton>
            <AppButton variant="destructive" :disabled="acting" @click.stop="rejectTarget = appt">
              {{ label({ es: 'Rechazar', en: 'Reject' }) }}
            </AppButton>
          </div>
        </div>
      </li>
    </ul>

    <DetailPanel
      :open="detailOpen"
      :title="label({ es: 'Detalle de la solicitud', en: 'Request detail' })"
      size="5xl"
      @close="closeDetail"
      @after-leave="onDetailAfterLeave"
    >
      <div v-if="detailAppt" class="flex flex-col gap-5">
        <div class="grid gap-6 lg:grid-cols-2">
          <div class="flex flex-col gap-5">
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-neutral">{{ label({ es: 'Solicitud', en: 'Request' }) }}</h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-neutral">{{ t('calendar.dateLabel') }}</dt>
            <dd>{{ formatDateTime(detailAppt.starts_at) }} · {{ detailAppt.duration_minutes }} min</dd>
            <dt class="text-neutral">{{ t('calendar.professionalLabel') }}</dt>
            <dd>{{ professionalName(detailAppt) }}</dd>
            <dt class="text-neutral">{{ t('calendar.serviceLabel') }}</dt>
            <dd>{{ serviceName(detailAppt) }}</dd>
            <dt class="text-neutral">{{ t('calendar.priceLabel') }}</dt>
            <dd>{{ formatARS(detailAppt.price) }}</dd>
            <template v-if="detailAppt.name">
              <dt class="text-neutral">Título</dt>
              <dd>{{ detailAppt.name }}</dd>
            </template>
            <template v-if="detailAppt.description">
              <dt class="text-neutral">Descripción</dt>
              <dd class="whitespace-pre-line">{{ detailAppt.description }}</dd>
            </template>
          </dl>
        </section>

        <div v-if="loadingDetail">
          <Skeleton variant="row" :rows="3" />
        </div>

        <template v-else>
          <section class="flex flex-col gap-2 border-t border-border pt-4">
            <h3 class="text-sm font-semibold text-neutral">{{ label({ es: 'Cliente', en: 'Client' }) }}</h3>
            <p class="text-base font-semibold text-heading">{{ clientProfile?.display_name ?? clientName(detailAppt) }}</p>
            <p class="text-sm text-neutral">{{ clientProfile?.email ?? '—' }} · {{ clientProfile?.phone ?? '—' }}</p>
          </section>

          <section class="flex flex-col gap-2">
            <div
              class="flex items-center justify-between rounded-lg border p-3"
              :class="balancePositive ? 'border-destructive bg-red-50' : 'border-border bg-card'"
            >
              <span class="text-sm font-semibold text-heading">{{ label({ es: 'Saldo / deuda', en: 'Balance / debt' }) }}</span>
              <span
                class="text-lg font-semibold tabular-nums"
                :class="balancePositive ? 'text-destructive' : 'text-success'"
              >
                {{ clientBalance != null ? formatARS(clientBalance) : '—' }}
              </span>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-neutral">{{ label({ es: 'Historial', en: 'History' }) }}</h3>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded-full bg-surface px-2 py-1">{{ label({ es: 'Turnos', en: 'Appointments' }) }}: {{ clientAppts.length }}</span>
              <span class="rounded-full bg-green-100 px-2 py-1 text-success">{{ label({ es: 'Completados', en: 'Completed' }) }}: {{ completedCount }}</span>
              <span class="rounded-full bg-red-100 px-2 py-1 text-destructive">{{ label({ es: 'Cancelados', en: 'Canceled' }) }}: {{ canceledCount }}</span>
              <span class="rounded-full bg-yellow-100 px-2 py-1 text-warning">{{ label({ es: 'Ausencias', en: 'No-shows' }) }}: {{ noShowCount }}</span>
            </div>

            <EmptyState
              v-if="detailHistory.length === 0"
              :heading="label({ es: 'Sin turnos previos', en: 'No previous appointments' })"
              body=""
            />
            <ul v-else class="divide-y divide-border rounded-lg border border-border">
              <li
                v-for="a in detailHistory"
                :key="a.id"
                class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span class="tabular-nums text-neutral">{{ formatDateTime(a.starts_at) }}</span>
                <span class="flex-1 truncate">{{ serviceName(a) }} · {{ professionalName(a) }}</span>
                <span class="rounded-full bg-surface px-2 py-0.5 text-xs">{{ t(`status.${a.state}`) }}</span>
              </li>
            </ul>
          </section>
        </template>
          </div>

          <div class="flex min-h-0 flex-col gap-2 lg:h-[72vh]">
            <h3 class="text-sm font-semibold text-neutral">
              {{ label({ es: 'Agenda del día', en: "That day's schedule" }) }}
            </h3>
            <div class="min-h-[420px] flex-1 overflow-hidden rounded-lg border border-border">
              <CalendarView :key="detailAppt.id" :options="dayCalendarOptions" />
            </div>
          </div>
        </div>

        <div class="flex gap-2 border-t border-border pt-4">
          <AppButton variant="primary" :loading="acting" class="flex-1" @click="approve(detailAppt)">
            {{ label({ es: 'Aprobar', en: 'Approve' }) }}
          </AppButton>
          <AppButton variant="destructive" :disabled="acting" class="flex-1" @click="rejectTarget = detailAppt">
            {{ label({ es: 'Rechazar', en: 'Reject' }) }}
          </AppButton>
        </div>
      </div>
    </DetailPanel>

    <ConfirmDialog
      :open="rejectTarget !== null"
      :title="label({ es: 'Rechazar solicitud', en: 'Reject request' })"
      :body="label({ es: '¿Rechazás esta solicitud de turno? Esta acción no se puede deshacer.', en: 'Reject this appointment request? This cannot be undone.' })"
      :confirm-label="label({ es: 'Rechazar', en: 'Reject' })"
      :destructive="true"
      @confirm="confirmReject"
      @cancel="rejectTarget = null"
    />

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />
  </div>
</template>

<style scoped>
/* Let the embedded day calendar fill its (definite-height) column so it uses the modal height. */
:deep(.fc-wrapper) {
  height: 100%;
}

/* The request under review: a thick accent border on the event's own box (border-box, so it
   stays INSIDE the block and never bleeds onto the abutting blocks above/below), full opacity,
   and a gentle colour pulse for attention. */
:deep(.fc-current-request) {
  opacity: 1 !important;
  border: 3px solid rgb(37, 99, 235) !important;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.65);
  animation: currentReqPulse 1.5s ease-in-out infinite;
}

@keyframes currentReqPulse {
  0%, 100% { border-color: rgb(37, 99, 235); }
  50% { border-color: rgb(125, 170, 255); }
}
</style>
