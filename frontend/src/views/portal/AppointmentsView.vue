<script lang="ts">
// How far ahead the portal asks the backend to expand a client's recurring series into virtual
// occurrences. Without a bounded date_from/date_to the backend never expands series at all, so a
// client would never see an upcoming recurring turno.
export const SERIES_PORTAL_HORIZON_DAYS = 90;
</script>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { toDisplayAppointment } from '@/composables/seriesOccurrence';
import { appointmentFromExtendedProps } from '@/composables/calendarEventPayload';
import { dayISO } from '@/composables/availabilityShading';
import { listRows } from '@/api/crud';
import { getMySettings } from '@/api/business';
import { apiErrorMessage } from '@/i18n/api-errors';
import { canCancelAppointment, DEFAULT_CANCELLATION_CUTOFF_HOURS, isOpenAppointmentState } from '@shared/ssot/domain';
import type { TableRecordMap } from '@shared/ssot/derived';
import type { EventClickArg } from '@fullcalendar/core';
import { PlusIcon } from '@heroicons/vue/24/outline';
import MaterialIcon from '@/components/shared/MaterialIcon.vue';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useCurrency } from '@/composables/useCurrency';
import { useStateLabel } from '@/composables/useStateLabel';
import CalendarView from '@/components/calendar/CalendarView.vue';
import StatusBadge from '@/components/portal/StatusBadge.vue';
import RequestFlow from '@/components/portal/RequestFlow.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';

const { t } = useI18n();
const { stateLabel } = useStateLabel();
const auth = useAuthStore();
const ui = useUiStore();
const { formatDateTime, formatARS } = useCurrency();

// The weekday NAME follows the language toggle (it's a label), unlike the numeric date which stays
// es-AR. Capitalized so it reads as a label in both languages ("Lunes" / "Monday").
function formatWeekday(iso: string): string {
  const locale = ui.language === 'en' ? 'en-US' : 'es-AR';
  const name = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(iso));
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const appointments = ref<Appointment[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  // A bounded range is what makes the backend expand recurring series into virtual occurrences —
  // an unranged request only ever returns materialized rows.
  const res = await listAppointments({
    date_from: dayISO(new Date(), 0),
    date_to: dayISO(new Date(), SERIES_PORTAL_HORIZON_DAYS),
    limit: 100,
  });
  loading.value = false;
  if (res.ok) {
    // Server already scopes to the caller's own appointments for Client role. Virtual (recurring,
    // not-yet-materialized) occurrences are normalized to the same shape as real rows so the rest
    // of this view (and the embedded calendar) render them without a special case.
    appointments.value = res.data.map(toDisplayAppointment);
  }
}

onMounted(load);

// Requesting an appointment is a modal launched from here; the panel unmounts on close,
// so each open starts a fresh flow.
const requestOpen = ref(false);

async function onRequestSuccess() {
  requestOpen.value = false;
  ui.toast('success', 'requestSubmitted');
  await load();
}

// For a client, the professional's name is the informative default — their own name
// (or "Turno #id") says nothing. Full rows, not just labels: the detail panel
// also shows the service name and the professional's bio.
const professionals = ref<TableRecordMap['professionals'][]>([]);
const services = ref<TableRecordMap['services'][]>([]);
onMounted(async () => {
  const [profRes, svcRes] = await Promise.all([listRows('professionals'), listRows('services')]);
  if (profRes.ok) professionals.value = profRes.data;
  if (svcRes.ok) services.value = svcRes.data;
});
const professionalsById = computed(() => new Map(professionals.value.map((p) => [p.id, p])));
const serviceNamesById = computed(() => new Map(services.value.map((s) => [s.id, s.name])));
function professionalFor(appt: Appointment): TableRecordMap['professionals'] | null {
  return professionalsById.value.get(appt.professional_user_id) ?? null;
}
function professionalNameFor(appt: Appointment): string | null {
  return professionalFor(appt)?.display_name ?? null;
}
function serviceNameFor(appt: Appointment): string | null {
  return serviceNamesById.value.get(appt.service_id) ?? null;
}

// Clicking a calendar event opens a read-only detail (clients can't edit/drag/resize).
const selectedAppt = ref<Appointment | null>(null);
const detailOpen = ref(false);
const { calendarOptions } = useAppointmentCalendar(
  appointments,
  computed(() => auth.user),
  {
    onSelect: () => {},
    onEventClick: (arg: EventClickArg) => {
      const appt = appointmentFromExtendedProps(arg.event.extendedProps);
      if (appt) {
        selectedAppt.value = appt;
        detailOpen.value = true;
      }
    },
    onEventDrop: () => {},
    onEventResize: () => {},
  },
  {
    fallbackTitle: professionalNameFor,
    tooltip: (appt) =>
      [professionalNameFor(appt), stateLabel(appt.state)].filter(Boolean).join(' · '),
  },
);

// Cancel is blocked within the business's cutoff of the start. The backend 422 is the real gate;
// the UI disables as a UX layer only, reading the same rule (canCancelAppointment) and the real
// per-business cutoff so the button state can't disagree with what the server will accept.
const cutoffHours = ref(DEFAULT_CANCELLATION_CUTOFF_HOURS);
onMounted(async () => {
  const res = await getMySettings();
  if (res.ok) cutoffHours.value = res.data.cancellation_cutoff_hours;
});

function isCancelable(appt: Appointment): boolean {
  return canCancelAppointment(appt.state, appt.starts_at, cutoffHours.value, Date.now());
}

function cancelBlockedReason(appt: Appointment): string | null {
  // A virtual occurrence is read-only here (no cancel affordance at all), so it never needs
  // the "past the cutoff" explanation either.
  if (appt.is_virtual || appt.state !== 'scheduled' || isCancelable(appt)) return null;
  // Visible explanation, not just a tooltip.
  return t('portal.cancelCutoffWarning', { hours: cutoffHours.value });
}

const cancelTarget = ref<Appointment | null>(null);
const canceling = ref(false);

function requestCancel(appt: Appointment) {
  cancelTarget.value = appt;
}

function requestSelectedCancel() {
  if (!selectedAppt.value) return;
  detailOpen.value = false;
  requestCancel(selectedAppt.value);
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
    // outside_cutoff now carries the real cutoff hours in its detail; resolve it so the client is
    // told the actual number rather than a generic "within the cutoff" line.
    ui.toast('error', apiErrorMessage(res, 'toast.genericError'));
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
    <div class="space-y-4">
      <h1 class="text-2xl font-semibold">{{ t('nav.myAppointments') }}</h1>
      <AppButton size="lg" class="w-full shadow-md" @click="requestOpen = true">
        <PlusIcon class="mr-2 h-5 w-5" aria-hidden="true" />
        {{ t('actions.requestAppointment') }}
      </AppButton>
    </div>

    <div v-if="loading">
      <Skeleton variant="row" :rows="4" />
    </div>

    <EmptyState
      v-else-if="!loading && appointments.length === 0"
      :heading="t('emptyState.noAppointmentsHeading')"
      :body="t('emptyState.noAppointmentsBody')"
    />

    <template v-else>
      <section v-if="upcoming.length > 0" :aria-label="t('portal.upcomingHeading')">
        <h2 class="mb-3 text-lg font-semibold">{{ t('portal.upcomingHeading') }}</h2>
        <ul class="space-y-3">
          <li
            v-for="appt in upcoming"
            :key="appt.id"
            class="virtualized-row rounded-lg border border-border bg-card p-4"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <StatusBadge :state="appt.state" />
                  <!-- Neutral, not accent: it sits beside the status badge and recurrence is not a status. -->
                  <span
                    v-if="appt.is_virtual"
                    class="inline-flex items-center gap-1 rounded-full bg-neutral-tint px-2 py-0.5 text-xs font-semibold text-body"
                    :title="t('calendar.recurringTooltip')"
                  >
                    <MaterialIcon name="repeat" class="h-3.5 w-3.5" />
                    {{ t('portal.recurringBadge') }}
                  </span>
                  <span class="text-sm font-semibold">
                    {{ formatWeekday(appt.starts_at) }} {{ formatDateTime(appt.starts_at) }}
                  </span>
                </div>
                <p class="text-xs text-neutral">
                  {{ formatDateTime(appt.starts_at) }} · {{ appt.duration_minutes }}min
                </p>
                <p v-if="appt.state === 'requested'" class="text-xs italic text-neutral">
                  {{ t('portal.pendingApproval') }}
                </p>
                <p class="text-sm">
                  {{ professionalNameFor(appt) ?? t('portal.appointmentFallback') }}
                  <span v-if="appt.name"> · {{ appt.name }}</span>
                </p>
                <p class="text-xs text-neutral">{{ t('portal.price') }}: {{ formatARS(appt.price) }}</p>

                <p
                  v-if="cancelBlockedReason(appt)"
                  class="mt-1 text-xs text-destructive"
                  role="alert"
                >
                  {{ cancelBlockedReason(appt) }}
                </p>
              </div>

              <!-- Cancel only; clients get no reschedule affordance. A virtual occurrence has no
                   row yet — read-only here, matching the rest of the portal's limited-cancel scope. -->
              <div v-if="isOpenAppointmentState(appt.state) && !appt.is_virtual" class="flex-shrink-0">
                <button
                  v-if="isCancelable(appt)"
                  type="button"
                  class="min-h-[36px] rounded-md border border-destructive px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-destructive-tint hover:text-destructive-strong transition-colors"
                  @click="requestCancel(appt)"
                >
                  {{ appt.state === 'requested' ? t('portal.withdrawRequest') : t('actions.cancel') }}
                </button>
                <!-- Visible disabled state, not tooltip-only. -->
                <button
                  v-else-if="cancelBlockedReason(appt)"
                  type="button"
                  class="min-h-[36px] rounded-md border border-border px-3 py-1.5 text-sm font-semibold text-neutral opacity-50 cursor-not-allowed"
                  disabled
                  aria-disabled="true"
                >
                  {{ t('actions.cancel') }}
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section :aria-label="t('portal.myCalendarLabel')">
        <h2 class="mb-3 text-lg font-semibold">{{ t('nav.calendar') }}</h2>
        <CalendarView :options="calendarOptions" />
      </section>

      <section v-if="past.length > 0" :aria-label="t('portal.historyLabel')">
        <h2 class="mb-3 text-lg font-semibold">{{ t('portal.history') }}</h2>
        <ul class="space-y-2">
          <li
            v-for="appt in past"
            :key="appt.id"
            class="virtualized-row rounded-lg border border-border bg-card p-3"
          >
            <div class="flex items-center gap-3 flex-wrap">
              <StatusBadge :state="appt.state" />
              <span class="text-sm">{{ formatWeekday(appt.starts_at) }} {{ formatDateTime(appt.starts_at) }}</span>
              <span class="text-sm text-neutral">{{ professionalNameFor(appt) ?? t('portal.appointmentFallback') }}</span>
              <span class="text-sm text-neutral">{{ formatARS(appt.price) }}</span>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>

  <DetailPanel
    :open="requestOpen"
    :title="t('actions.requestAppointment')"
    variant="modal"
    size="2xl"
    @close="requestOpen = false"
  >
    <RequestFlow @success="onRequestSuccess" />
  </DetailPanel>

  <DetailPanel
    :open="detailOpen"
    :title="t('portal.appointmentDetail')"
    variant="side"
    @close="detailOpen = false"
    @after-leave="selectedAppt = null"
  >
    <div v-if="selectedAppt" class="space-y-3 text-sm">
      <div class="flex items-center gap-2 flex-wrap">
        <StatusBadge :state="selectedAppt.state" />
        <span
          v-if="selectedAppt.is_virtual"
          class="inline-flex items-center gap-1 rounded-full bg-neutral-tint px-2 py-0.5 text-xs font-semibold text-body"
          :title="t('calendar.recurringTooltip')"
        >
          <MaterialIcon name="repeat" class="h-3.5 w-3.5" />
          {{ t('portal.recurringBadge') }}
        </span>
      </div>
      <div>
        <p class="text-xs text-neutral">{{ t('portal.professional') }}</p>
        <p class="font-semibold">{{ professionalNameFor(selectedAppt) ?? t('portal.appointmentFallback') }}</p>
      </div>
      <div v-if="serviceNameFor(selectedAppt)">
        <p class="text-xs text-neutral">{{ t('portal.service') }}</p>
        <p class="font-semibold">{{ serviceNameFor(selectedAppt) }}</p>
      </div>
      <div>
        <p class="text-xs text-neutral">{{ t('portal.dateTime') }}</p>
        <p class="font-semibold">{{ formatWeekday(selectedAppt.starts_at) }} {{ formatDateTime(selectedAppt.starts_at) }} · {{ selectedAppt.duration_minutes }}min</p>
      </div>
      <div v-if="selectedAppt.state === 'requested'">
        <p class="text-xs text-neutral">{{ t('portal.state') }}</p>
        <p class="font-semibold">{{ t('portal.pendingApproval') }}</p>
      </div>
      <div v-if="selectedAppt.name">
        <p class="text-xs text-neutral">{{ t('portal.detail') }}</p>
        <p>{{ selectedAppt.name }}</p>
      </div>
      <div>
        <p class="text-xs text-neutral">{{ t('portal.price') }}</p>
        <p class="font-semibold">{{ formatARS(selectedAppt.price) }}</p>
      </div>
      <div v-if="professionalFor(selectedAppt)?.bio">
        <p class="text-xs text-neutral">{{ t('portal.professionalBio') }}</p>
        <p>{{ professionalFor(selectedAppt)?.bio }}</p>
      </div>
      <p v-if="cancelBlockedReason(selectedAppt)" class="text-xs text-destructive" role="alert">
        {{ cancelBlockedReason(selectedAppt) }}
      </p>
      <button
        v-if="!selectedAppt.is_virtual && isOpenAppointmentState(selectedAppt.state) && isCancelable(selectedAppt)"
        type="button"
        class="min-h-[36px] w-full rounded-md border border-destructive px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-destructive-tint hover:text-destructive-strong transition-colors"
        @click="requestSelectedCancel"
      >
        {{ selectedAppt.state === 'requested' ? t('portal.withdrawRequest') : t('portal.cancelAppointment') }}
      </button>
    </div>
  </DetailPanel>

  <ConfirmDialog
    :open="cancelTarget !== null"
    :title="t('portal.cancelAppointment')"
    :body="
      cancelTarget?.state === 'requested'
        ? t('portal.withdrawConfirmBody')
        : t('portal.cancelConfirmBody')
    "
    :confirm-label="cancelTarget?.state === 'requested' ? t('portal.withdrawRequest') : t('portal.cancelAppointment')"
    :destructive="true"
    @confirm="confirmCancel"
    @cancel="dismissCancel"
  />
</template>
