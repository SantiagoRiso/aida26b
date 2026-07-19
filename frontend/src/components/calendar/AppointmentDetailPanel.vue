<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  TRANSITION_MAP,
  TERMINAL_STATES,
  assertValidTransition,
  canCancelAppointment,
  canMarkNoShow,
  canCompleteAppointment,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
} from '@shared/ssot/domain/appointment-lifecycle';
import { structure } from '@shared/ssot/structure';
import type { Appointment } from '@/api/appointments';
import { transitionAppointment, patchAppointment, ignoreAppointmentConflict } from '@/api/appointments';
import { getMySettings } from '@/api/business';
import { resolveActionable } from '@/composables/seriesOccurrence';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { useCurrency } from '@/composables/useCurrency';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { useLabel } from '@/composables/useLabel';
import MaterialIcon from '@/components/shared/MaterialIcon.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import AppButton from '@/components/shared/AppButton.vue';
import StatusBadge from '@/components/portal/StatusBadge.vue';

const props = defineProps<{
  appointment: Appointment | null;
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
  mutated: [appt: Appointment];
  reschedule: [appt: Appointment];
  // Approve may surface a conflict — parent handles the override dialog.
  approve: [appt: Appointment];
  // Canceling a series-bound appointment needs a scope choice — parent hosts that dialog.
  'cancel-series': [appt: Appointment];
  // Rescheduling a series-bound appointment needs the same scope choice, made before any
  // materialize/reschedule call (unlike 'this', 'future'/'whole' never touch this one row).
  'reschedule-series': [appt: Appointment];
  // Opens the recurrence-rule editor (frequency/interval/end) — parent fetches the series.
  'edit-series-rule': [appt: Appointment];
}>();

const { t } = useI18n();
const { label } = useLabel();
const auth = useAuthStore();
const toast = useToast();
const { formatARS, formatDate, formatTime } = useCurrency();

const nameColumnLabel = structure.tables.appointments.columns.name.label;
const descriptionColumnLabel = structure.tables.appointments.columns.description.label;

const staffNoteEdit = ref('');
const editingNote = ref(false);
const saving = ref(false);

// Names for the appointment's ids. Clients cannot list the clients table (and don't
// need their own name repeated), so that lookup is staff-only.
const isStaffViewer = auth.user?.role !== 'Client';
const { labelFor: professionalLabelFor } = useForeignKeyOptions({
  table: 'professionals', valueField: 'id', labelField: 'display_name',
});
const { labelFor: serviceLabelFor } = useForeignKeyOptions({
  table: 'services', valueField: 'id', labelField: 'name',
});
const { labelFor: resourceLabelFor } = useForeignKeyOptions({
  table: 'resources', valueField: 'id', labelField: 'name',
});
const { labelFor: clientLabelFor } = isStaffViewer
  ? useForeignKeyOptions({ table: 'clients', valueField: 'id', labelField: 'display_name' })
  : { labelFor: () => null };

const clientName = computed(() => clientLabelFor(props.appointment?.client_user_id ?? null));
const professionalName = computed(() => professionalLabelFor(props.appointment?.professional_user_id ?? null));
const serviceName = computed(() => serviceLabelFor(props.appointment?.service_id ?? null));
const resourceName = computed(() => resourceLabelFor(props.appointment?.resource_id ?? null));

// The backend 422 is the real gate; the button reads the same rule (canCancelAppointment) and the
// real per-business cutoff so its state can't disagree with what the server will accept.
const cutoffHours = ref(DEFAULT_CANCELLATION_CUTOFF_HOURS);
onMounted(async () => {
  const res = await getMySettings();
  if (res.ok) cutoffHours.value = res.data.cancellation_cutoff_hours;
});

const availableTransitions = computed((): string[] => {
  const appt = props.appointment;
  if (!appt) return [];
  // TRANSITION_MAP's keys are a literal union ('requested' | 'scheduled'); appt.state is a
  // plain string, so the lookup needs the same widening assertValidTransition uses internally.
  const targets = (TRANSITION_MAP as Partial<Record<string, readonly string[]>>)[appt.state];
  if (!targets) return [];
  return targets.filter((to) => {
    const check = assertValidTransition(appt.state, to);
    if (!check.ok) return false;
    // Clients may only cancel, and only within the business's cancellation cutoff.
    if (auth.user?.role === 'Client') {
      return to === 'canceled'
        && canCancelAppointment(appt.state, appt.starts_at, cutoffHours.value, Date.now());
    }
    if (to === 'no_show') {
      return canMarkNoShow(appt.state, appt.starts_at, cutoffHours.value, Date.now());
    }
    if (to === 'completed') {
      return canCompleteAppointment(appt.state, appt.starts_at, Date.now());
    }
    return true;
  });
});

const isTerminal = computed(() =>
  props.appointment ? TERMINAL_STATES.has(props.appointment.state) : false,
);

const canEditNote = computed(() => auth.user?.role !== 'Client');
// requested→scheduled routes through the conflict-aware approve endpoint, not a plain transition.
const showApprove = computed(
  () => props.appointment?.state === 'requested' && auth.user?.role !== 'Client',
);

function startEditNote() {
  staffNoteEdit.value = props.appointment?.staff_note ?? '';
  editingNote.value = true;
}

async function saveNote() {
  if (!props.appointment) return;
  saving.value = true;
  const actionable = await resolveActionable(props.appointment);
  if (!actionable) {
    saving.value = false;
    toast.error('genericError');
    return;
  }
  const result = await patchAppointment(actionable.id, { staff_note: staffNoteEdit.value });
  saving.value = false;
  if (result.ok) {
    editingNote.value = false;
    emit('mutated', result.data);
  } else {
    toast.error('genericError');
  }
}

async function doTransition(to: string) {
  if (!props.appointment) return;
  const appt = props.appointment;
  // Canceling a series-bound turno needs a scope choice (this / this-and-future / whole series);
  // the parent hosts that chooser and drives the actual calls.
  if (to === 'canceled' && appt.series_id != null) {
    emit('cancel-series', appt);
    return;
  }
  saving.value = true;
  const actionable = await resolveActionable(appt);
  if (!actionable) {
    saving.value = false;
    toast.error('genericError');
    return;
  }
  const result = await transitionAppointment(actionable.id, to);
  saving.value = false;
  if (result.ok) {
    emit('mutated', result.data);
  } else if (result.code === 'too_early') {
    toast.error('completeTooEarly');
  } else {
    // Defensive: the button guard should already exclude illegal transitions the server 422s.
    toast.error('genericError');
  }
}

function handleApprove() {
  if (props.appointment) emit('approve', props.appointment);
}

// A virtual occurrence has no row to reschedule yet — materialize it first, then hand the
// (now real) appointment to the parent's reschedule form. A series-bound appointment needs a scope
// choice first (this / this-and-future / whole series) — the parent hosts that chooser and only
// materializes/opens the single-appointment form for the 'this' choice.
async function handleReschedule() {
  if (!props.appointment) return;
  const appt = props.appointment;
  if (appt.series_id != null) {
    emit('reschedule-series', appt);
    return;
  }
  saving.value = true;
  const actionable = await resolveActionable(appt);
  saving.value = false;
  if (!actionable) {
    toast.error('genericError');
    return;
  }
  emit('reschedule', actionable);
}

function handleEditSeriesRule() {
  if (props.appointment) emit('edit-series-rule', props.appointment);
}

const isStaff = auth.user?.role !== 'Client';

async function doIgnore(ignored: boolean) {
  if (!props.appointment) return;
  saving.value = true;
  const actionable = await resolveActionable(props.appointment);
  if (!actionable) {
    saving.value = false;
    toast.error('genericError');
    return;
  }
  const result = await ignoreAppointmentConflict(actionable.id, ignored);
  saving.value = false;
  if (result.ok) emit('mutated', result.data);
  else toast.error('genericError');
}

// The state → i18n action-key map for transition buttons; state labels themselves come from
// stateLabel() (SSOT), not this map.
const TRANSITION_KEY: Record<string, string> = {
  scheduled: 'calendar.approve',
  rejected: 'calendar.reject',
  canceled: 'calendar.cancel',
  completed: 'calendar.complete',
  no_show: 'calendar.noShow',
};

function transitionLabel(to: string): string {
  const key = TRANSITION_KEY[to];
  return key ? t(key) : to;
}

function transitionVariant(to: string): 'primary' | 'destructive' | 'neutral' {
  if (to === 'scheduled') return 'primary';
  if (to === 'rejected' || to === 'canceled') return 'destructive';
  return 'neutral';
}
</script>

<template>
  <DetailPanel :open="open" :title="t('calendar.detailTitle')" variant="side" @close="emit('close')">
    <div v-if="appointment" class="flex flex-col gap-4">
      <div class="flex items-center gap-2">
        <StatusBadge :state="appointment.state" />
        <span
          v-if="appointment.in_conflict"
          class="rounded-full bg-destructive/10 px-3 py-0.5 text-xs font-semibold text-destructive"
          :title="t('calendar.inConflictTooltip')"
        >
          {{ t('calendar.inConflictBadge') }}
        </span>
      </div>

      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <template v-if="clientName">
          <dt class="font-semibold text-neutral">{{ t('calendar.clientLabel') }}</dt>
          <dd>{{ clientName }}</dd>
        </template>

        <template v-if="professionalName">
          <dt class="font-semibold text-neutral">{{ t('calendar.professionalLabel') }}</dt>
          <dd>{{ professionalName }}</dd>
        </template>

        <template v-if="serviceName">
          <dt class="font-semibold text-neutral">{{ t('calendar.serviceLabel') }}</dt>
          <dd>{{ serviceName }}</dd>
        </template>

        <template v-if="resourceName">
          <dt class="font-semibold text-neutral">{{ t('calendar.resourceLabel') }}</dt>
          <dd>{{ resourceName }}</dd>
        </template>

        <dt class="font-semibold text-neutral">{{ t('calendar.dateLabel') }}</dt>
        <dd>{{ formatDate(appointment.starts_at) }}</dd>

        <dt class="font-semibold text-neutral">{{ t('calendar.timeLabel') }}</dt>
        <dd>{{ formatTime(appointment.starts_at) }} - {{ formatTime(appointment.ends_at) }}</dd>

        <dt class="font-semibold text-neutral">{{ t('calendar.durationLabel') }}</dt>
        <dd>{{ appointment.duration_minutes }} min</dd>

        <dt class="font-semibold text-neutral">{{ t('calendar.priceLabel') }}</dt>
        <dd>{{ formatARS(appointment.price) }}</dd>

        <template v-if="appointment.name">
          <dt class="font-semibold text-neutral">{{ label(nameColumnLabel) }}</dt>
          <dd>{{ appointment.name }}</dd>
        </template>

        <template v-if="appointment.description">
          <dt class="font-semibold text-neutral">{{ label(descriptionColumnLabel) }}</dt>
          <dd class="whitespace-pre-line">{{ appointment.description }}</dd>
        </template>
      </dl>

      <div v-if="canEditNote" class="border-t border-border pt-3">
        <div class="flex items-center justify-between mb-1">
          <span class="text-sm font-semibold text-neutral">{{ t('calendar.staffNote') }}</span>
          <button
            v-if="!editingNote"
            type="button"
            class="text-xs text-accent hover:underline"
            @click="startEditNote"
          >
            {{ t('calendar.editNote') }}
          </button>
        </div>
        <template v-if="editingNote">
          <textarea
            v-model="staffNoteEdit"
            rows="3"
            class="w-full rounded border border-border px-3 py-2 text-sm"
          />
          <div class="mt-2 flex gap-2">
            <AppButton variant="primary" :loading="saving" @click="saveNote">
              {{ t('actions.save') }}
            </AppButton>
            <AppButton variant="neutral" @click="editingNote = false">
              {{ t('actions.cancel') }}
            </AppButton>
          </div>
        </template>
        <p v-else class="text-sm text-neutral whitespace-pre-line min-h-[1.5rem]">
          {{ appointment.staff_note || t('generic.emptyValue') }}
        </p>
      </div>

      <div v-if="!isTerminal" class="border-t border-border pt-3 flex flex-col gap-2">
        <AppButton
          v-if="showApprove"
          variant="primary"
          :loading="saving"
          @click="handleApprove"
        >
          {{ t('calendar.approve') }}
        </AppButton>

        <AppButton
          v-if="auth.user?.role !== 'Client'"
          variant="neutral"
          @click="handleReschedule"
        >
          {{ t('calendar.reschedule') }}
        </AppButton>

        <AppButton
          v-if="isStaff && appointment.in_conflict"
          variant="neutral"
          :loading="saving"
          @click="doIgnore(true)"
        >
          {{ t('calendar.ignoreConflict') }}
        </AppButton>
        <AppButton
          v-else-if="isStaff && appointment.conflict_ignored"
          variant="neutral"
          :loading="saving"
          @click="doIgnore(false)"
        >
          {{ t('calendar.reflagConflict') }}
        </AppButton>

        <AppButton
          v-for="to in availableTransitions.filter((t) => t !== 'scheduled')"
          :key="to"
          :variant="transitionVariant(to)"
          :loading="saving"
          @click="doTransition(to)"
        >
          {{ transitionLabel(to) }}
        </AppButton>
      </div>

      <!-- Always available while the series is bound, regardless of this occurrence's own state —
           the underlying recurrence keeps generating other occurrences either way. -->
      <div v-if="isStaff && appointment.series_id != null" class="border-t border-border pt-3 space-y-2">
        <span
          class="inline-flex items-center gap-1 text-xs font-semibold text-accent"
          :title="t('calendar.recurringTooltip')"
        >
          <MaterialIcon name="repeat" class="h-4 w-4" />
          {{ t('calendar.recurringLabel') }}
        </span>
        <AppButton variant="neutral" @click="handleEditSeriesRule">
          {{ t('calendar.editSeries') }}
        </AppButton>
      </div>

      <p v-if="isTerminal && !canEditNote" class="text-sm text-neutral italic">
        {{ t('calendar.appointmentClosed') }}
      </p>
    </div>
  </DetailPanel>
</template>
