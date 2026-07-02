<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DateSelectArg, EventClickArg, EventDropArg, EventResizeDoneArg } from '@fullcalendar/core';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { listAppointments, rescheduleAppointment, approveAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import CalendarViewComponent from '@/components/calendar/CalendarView.vue';
import CalendarFilters from '@/components/calendar/CalendarFilters.vue';
import type { FilterState } from '@/components/calendar/CalendarFilters.vue';
import AppointmentDetailPanel from '@/components/calendar/AppointmentDetailPanel.vue';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import AppButton from '@/components/shared/AppButton.vue';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

const appointments = ref<Appointment[]>([]);
const loading = ref(false);

// Updated by FullCalendar datesSet as the user navigates.
const visibleRange = ref<{ from: string; to: string }>({
  from: new Date().toISOString().slice(0, 10),
  to: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
});

const filters = ref<FilterState>({ professional_user_id: null, resource_id: null });

const detailAppt = ref<Appointment | null>(null);
const detailOpen = ref(false);

const formOpen = ref(false);
const formAppt = ref<Appointment | undefined>(undefined); // set for reschedule
const formPrefillDate = ref<string | undefined>();
const formPrefillStart = ref<string | undefined>();
const formPrefillProfId = ref<number | undefined>();

const conflictOpen = ref(false);
const conflictVerdict = ref<ConflictVerdict | null>(null);
// Snap drag/resize back when the user cancels the override.
const conflictRevert = ref<(() => void) | null>(null);
const conflictRetryFn = ref<((override: boolean) => Promise<void>) | null>(null);

async function fetchAppointments() {
  loading.value = true;
  const result = await listAppointments({
    date_from: visibleRange.value.from,
    date_to: visibleRange.value.to,
    professional_user_id: filters.value.professional_user_id ?? undefined,
    resource_id: filters.value.resource_id ?? undefined,
    limit: 200,
  });
  loading.value = false;
  if (result.ok) {
    appointments.value = result.data as Appointment[];
  }
}

watch(filters, fetchAppointments, { immediate: true, deep: true });

const { calendarOptions } = useAppointmentCalendar(
  appointments,
  ref(auth.user),
  {
    onSelect: handleSelect,
    onEventClick: handleEventClick,
    onEventDrop: handleEventDrop,
    onEventResize: handleEventResize,
  },
);

// Must stay a computed (not a plain spread object) — FullCalendar's Vue wrapper only
// re-diffs options when the prop reference changes; a plain object built once at setup
// freezes `events` to whatever appointments held at that instant.
const fullOptions = computed<typeof calendarOptions.value>(() => ({
  ...calendarOptions.value,
  datesSet: (info: { startStr: string; endStr: string }) => {
    visibleRange.value = { from: info.startStr.slice(0, 10), to: info.endStr.slice(0, 10) };
    void fetchAppointments();
  },
}));

function handleSelect(arg: DateSelectArg) {
  formPrefillDate.value = arg.startStr.slice(0, 10);
  formPrefillStart.value = arg.startStr.slice(11, 16) || undefined;
  formPrefillProfId.value = filters.value.professional_user_id ?? undefined;
  formAppt.value = undefined;
  formOpen.value = true;
}

function handleEventClick(arg: EventClickArg) {
  const appt = arg.event.extendedProps['appointment'] as Appointment | undefined;
  if (appt) {
    detailAppt.value = appt;
    detailOpen.value = true;
  }
}

async function handleEventDrop(arg: EventDropArg) {
  const appt = arg.event.extendedProps['appointment'] as Appointment | undefined;
  if (!appt) { arg.revert(); return; }

  const newStart = arg.event.startStr;
  const date = newStart.slice(0, 10);
  const start = newStart.slice(11, 16);

  await doReschedule(appt.id, { date, start }, arg.revert);
}

async function handleEventResize(arg: EventResizeDoneArg) {
  const appt = arg.event.extendedProps['appointment'] as Appointment | undefined;
  if (!appt) { arg.revert(); return; }

  const newStart = arg.event.startStr;
  const newEnd = arg.event.endStr;
  const date = newStart.slice(0, 10);
  const start = newStart.slice(11, 16);
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = newEnd.slice(11, 16).split(':').map(Number);
  const duration_minutes = (eh * 60 + em) - (sh * 60 + sm);

  await doReschedule(appt.id, { date, start, duration_minutes }, arg.revert);
}

async function doReschedule(
  id: number,
  body: { date?: string; start?: string; duration_minutes?: number },
  revertFn?: () => void,
  override = false,
) {
  const result = await rescheduleAppointment(id, { ...body, override });
  if (!result.ok) {
    toast.error('toast.genericError');
    revertFn?.();
    return;
  }
  const payload = result.data;
  if (!payload.saved) {
    // Warn first — open override dialog with revert callback.
    conflictVerdict.value = payload.verdict;
    conflictRevert.value = revertFn ?? null;
    conflictRetryFn.value = (ov: boolean) => doReschedule(id, body, revertFn, ov);
    conflictOpen.value = true;
  } else {
    await fetchAppointments();
  }
}

async function handleApproveRequest(appt: Appointment, override = false) {
  const result = await approveAppointment(appt.id, override);
  if (!result.ok) {
    toast.error('toast.genericError');
    return;
  }
  const payload = result.data;
  if (!payload.saved) {
    conflictVerdict.value = payload.verdict;
    conflictRevert.value = null;
    conflictRetryFn.value = (ov: boolean) => handleApproveRequest(appt, ov);
    conflictOpen.value = true;
  } else {
    detailAppt.value = payload.appointment;
    await fetchAppointments();
  }
}

async function onOverrideConfirm() {
  conflictOpen.value = false;
  if (conflictRetryFn.value) {
    await conflictRetryFn.value(true);
  }
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
  conflictRevert.value = null;
}

function onOverrideCancel() {
  conflictOpen.value = false;
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
  // revert is called inside ConflictOverrideDialog before emitting cancel.
  conflictRevert.value = null;
}

function onFormConflict(verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>) {
  conflictVerdict.value = verdict;
  conflictRevert.value = null;
  conflictRetryFn.value = retryFn;
  conflictOpen.value = true;
}

async function onDetailMutated(appt: Appointment) {
  detailAppt.value = appt;
  await fetchAppointments();
}

function onReschedule(appt: Appointment) {
  formAppt.value = appt;
  formPrefillDate.value = undefined;
  formPrefillStart.value = undefined;
  formPrefillProfId.value = undefined;
  formOpen.value = true;
  detailOpen.value = false;
}

async function onFormSaved(appt: Appointment) {
  formOpen.value = false;
  detailAppt.value = appt;
  detailOpen.value = true;
  await fetchAppointments();
}

function openNewForm() {
  formAppt.value = undefined;
  formPrefillDate.value = undefined;
  formPrefillStart.value = undefined;
  formPrefillProfId.value = filters.value.professional_user_id ?? undefined;
  formOpen.value = true;
}

function onFiltersUpdate(f: FilterState) {
  filters.value = f;
}
</script>

<template>
  <div class="flex flex-col gap-4 h-full">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">{{ t('nav.calendar') }}</h1>
      <AppButton variant="primary" @click="openNewForm">
        {{ t('calendar.newAppointment') }}
      </AppButton>
    </div>

    <CalendarFilters @update:filters="onFiltersUpdate" />

    <div v-if="loading && appointments.length === 0" class="text-sm text-neutral">
      {{ t('loading') }}
    </div>
    <CalendarViewComponent :options="fullOptions" />

    <AppointmentDetailPanel
      :appointment="detailAppt"
      :open="detailOpen"
      @close="detailOpen = false"
      @mutated="onDetailMutated"
      @reschedule="onReschedule"
      @approve="(appt) => handleApproveRequest(appt)"
    />

    <DetailPanel
      :open="formOpen"
      :title="formAppt ? t('calendar.reschedule') : t('calendar.newAppointment')"
      @close="formOpen = false"
    >
      <AppointmentForm
        v-if="formOpen"
        :appointment="formAppt"
        :prefill-date="formPrefillDate"
        :prefill-start="formPrefillStart"
        :prefill-professional-id="formPrefillProfId"
        @saved="onFormSaved"
        @conflict-detected="onFormConflict"
        @cancel="formOpen = false"
      />
    </DetailPanel>

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      :revert="conflictRevert"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />
  </div>
</template>
