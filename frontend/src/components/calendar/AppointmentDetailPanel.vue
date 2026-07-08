<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { TRANSITION_MAP, TERMINAL_STATES, assertValidTransition } from '@shared/ssot/domain/scheduling';
import type { Appointment } from '@/api/appointments';
import { transitionAppointment, patchAppointment } from '@/api/appointments';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import AppButton from '@/components/shared/AppButton.vue';

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
}>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

const staffNoteEdit = ref('');
const editingNote = ref(false);
const saving = ref(false);

// Names for the appointment's ids. Clients cannot list the clients table (and don't
// need their own name repeated), so that lookup is staff-only.
const isStaffViewer = auth.user?.role !== 'Client';
const { options: professionalOptions } = useForeignKeyOptions({
  table: 'professionals', valueField: 'id', labelField: 'display_name',
});
const { options: serviceOptions } = useForeignKeyOptions({
  table: 'services', valueField: 'id', labelField: 'name',
});
const { options: clientOptions } = isStaffViewer
  ? useForeignKeyOptions({ table: 'clients', valueField: 'id', labelField: 'display_name' })
  : { options: ref([]) };

function nameFor(options: { value: string; label: string }[], id: number | null): string | null {
  if (id == null) return null;
  return options.find((o) => o.value === String(id))?.label ?? null;
}

const clientName = computed(() => nameFor(clientOptions.value, props.appointment?.client_user_id ?? null));
const professionalName = computed(() => nameFor(professionalOptions.value, props.appointment?.professional_user_id ?? null));
const serviceName = computed(() => nameFor(serviceOptions.value, props.appointment?.service_id ?? null));

const availableTransitions = computed((): string[] => {
  const appt = props.appointment;
  if (!appt) return [];
  const targets = TRANSITION_MAP[appt.state];
  if (!targets) return [];
  return targets.filter((to) => {
    const check = assertValidTransition(appt.state, to);
    if (!check.ok) return false;
    // Clients may only cancel; staff see all transitions.
    if (auth.user?.role === 'Client') return to === 'canceled';
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
  const result = await patchAppointment(props.appointment.id, { staff_note: staffNoteEdit.value });
  saving.value = false;
  if (result.ok) {
    editingNote.value = false;
    emit('mutated', result.data);
  } else {
    toast.error('toast.genericError');
  }
}

async function doTransition(to: string) {
  if (!props.appointment) return;
  saving.value = true;
  const result = await transitionAppointment(props.appointment.id, to);
  saving.value = false;
  if (result.ok) {
    emit('mutated', result.data);
  } else {
    // Defensive: the button guard should already exclude illegal transitions the server 422s.
    toast.error('toast.genericError');
  }
}

function handleApprove() {
  if (props.appointment) emit('approve', props.appointment);
}

function handleReschedule() {
  if (props.appointment) emit('reschedule', props.appointment);
}

// es-AR date/time formatting (DD/MM/YYYY, 24h) regardless of language toggle.
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ARS currency: $ X.XXX,XX
function fmtPrice(price: string): string {
  const n = parseFloat(price);
  if (isNaN(n)) return `$ ${price}`;
  return `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABEL: Record<string, string> = {
  requested: 'Solicitado',
  scheduled: 'Programado',
  completed: 'Completado',
  canceled: 'Cancelado',
  no_show: 'Ausente',
  rejected: 'Rechazado',
};

const TRANSITION_LABEL: Record<string, string> = {
  scheduled: 'Aprobar',
  rejected: 'Rechazar',
  canceled: 'Cancelar',
  completed: 'Completado',
  no_show: 'Ausente',
};

function transitionVariant(to: string): 'primary' | 'destructive' | 'neutral' {
  if (to === 'scheduled') return 'primary';
  if (to === 'rejected' || to === 'canceled') return 'destructive';
  return 'neutral';
}
</script>

<template>
  <DetailPanel :open="open" :title="t('calendar.detailTitle')" @close="emit('close')">
    <div v-if="appointment" class="flex flex-col gap-4">
      <div class="flex items-center gap-2">
        <span
          class="rounded-full px-3 py-0.5 text-xs font-semibold"
          :class="{
            'bg-info/10 text-info': appointment.state === 'requested',
            'bg-accent/10 text-accent': appointment.state === 'scheduled',
            'bg-success/10 text-success': appointment.state === 'completed',
            'bg-neutral/10 text-neutral': ['canceled','no_show','rejected'].includes(appointment.state),
          }"
        >
          {{ STATUS_LABEL[appointment.state] ?? appointment.state }}
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

        <dt class="font-semibold text-neutral">{{ t('calendar.dateLabel') }}</dt>
        <dd>{{ fmtDate(appointment.starts_at) }}</dd>

        <dt class="font-semibold text-neutral">{{ t('calendar.timeLabel') }}</dt>
        <dd>{{ fmtTime(appointment.starts_at) }} – {{ fmtTime(appointment.ends_at) }}</dd>

        <dt class="font-semibold text-neutral">{{ t('calendar.durationLabel') }}</dt>
        <dd>{{ appointment.duration_minutes }} min</dd>

        <dt class="font-semibold text-neutral">{{ t('calendar.priceLabel') }}</dt>
        <dd>{{ fmtPrice(appointment.price) }}</dd>

        <template v-if="appointment.name">
          <dt class="font-semibold text-neutral">Título</dt>
          <dd>{{ appointment.name }}</dd>
        </template>

        <template v-if="appointment.description">
          <dt class="font-semibold text-neutral">Descripción</dt>
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
          {{ appointment.staff_note || '—' }}
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
          v-for="to in availableTransitions.filter((t) => t !== 'scheduled')"
          :key="to"
          :variant="transitionVariant(to)"
          :loading="saving"
          @click="doTransition(to)"
        >
          {{ TRANSITION_LABEL[to] ?? to }}
        </AppButton>
      </div>

      <p v-if="isTerminal && !canEditNote" class="text-sm text-neutral italic">
        Este turno está cerrado.
      </p>
    </div>
  </DetailPanel>
</template>
