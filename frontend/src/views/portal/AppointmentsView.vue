<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { listRows } from '@/api/crud';
import { getMySettings } from '@/api/business';
import { canCancelAppointment, DEFAULT_CANCELLATION_CUTOFF_HOURS, isOpenAppointmentState } from '@shared/ssot/domain';
import type { TableRecordMap } from '@shared/types/types';
import type { EventClickArg } from '@fullcalendar/core';
import { PlusIcon } from '@heroicons/vue/24/outline';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useCurrency } from '@/composables/useCurrency';
import CalendarView from '@/components/calendar/CalendarView.vue';
import StatusBadge from '@/components/portal/StatusBadge.vue';
import RequestFlow from '@/components/portal/RequestFlow.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';

const { t } = useI18n();
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
  const res = await listAppointments({ limit: 100 });
  loading.value = false;
  if (res.ok) {
    // Server already scopes to the caller's own appointments for Client role.
    appointments.value = res.data;
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
function professionalFor(appt: Appointment): TableRecordMap['professionals'] | null {
  return professionals.value.find((p) => String(p.id) === String(appt.professional_user_id)) ?? null;
}
function professionalNameFor(appt: Appointment): string | null {
  return professionalFor(appt)?.display_name ?? null;
}
function serviceNameFor(appt: Appointment): string | null {
  return services.value.find((s) => String(s.id) === String(appt.service_id))?.name ?? null;
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
      const appt = arg.event.extendedProps['appointment'] as Appointment | undefined;
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
      [professionalNameFor(appt), t(`status.${appt.state}`)].filter(Boolean).join(' · '),
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
  if (appt.state !== 'scheduled' || isCancelable(appt)) return null;
  // Visible explanation, not just a tooltip.
  return t('portal.cancelCutoffWarning', { hours: cutoffHours.value });
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
    ui.toast('error', res.code === 'outside_cutoff' ? 'cancelOutsideCutoff' : 'genericError');
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
      <h1 class="text-2xl font-bold">{{ t('nav.myAppointments') }}</h1>
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
            class="rounded-lg border border-border bg-card p-4"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <StatusBadge :state="appt.state" />
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
                  {{ professionalNameFor(appt) ?? t('portal.appointmentFallback', { id: appt.id }) }}
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

              <!-- Cancel only; clients get no reschedule affordance. -->
              <div v-if="isOpenAppointmentState(appt.state)" class="flex-shrink-0">
                <button
                  v-if="isCancelable(appt)"
                  type="button"
                  class="min-h-[36px] rounded-md border border-destructive px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-red-50 transition-colors"
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
            class="rounded-lg border border-border bg-card p-3"
          >
            <div class="flex items-center gap-3 flex-wrap">
              <StatusBadge :state="appt.state" />
              <span class="text-sm">{{ formatWeekday(appt.starts_at) }} {{ formatDateTime(appt.starts_at) }}</span>
              <span class="text-sm text-neutral">{{ professionalNameFor(appt) ?? t('portal.appointmentFallback', { id: appt.id }) }}</span>
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
      <StatusBadge :state="selectedAppt.state" />
      <div>
        <p class="text-xs text-neutral">{{ t('portal.professional') }}</p>
        <p class="font-semibold">{{ professionalNameFor(selectedAppt) ?? t('portal.appointmentFallback', { id: selectedAppt.id }) }}</p>
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
        v-if="isOpenAppointmentState(selectedAppt.state) && isCancelable(selectedAppt)"
        type="button"
        class="min-h-[36px] w-full rounded-md border border-destructive px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-red-50 transition-colors"
        @click="() => { const a = selectedAppt!; detailOpen = false; requestCancel(a); }"
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
