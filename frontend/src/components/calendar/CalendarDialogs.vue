<script setup lang="ts">
// Hosts the calendar's overlays: appointment detail panel, the new/reschedule form panel, the
// move-confirm dialog, and the conflict-override dialog. All state lives in the parent view;
// this component only renders and re-emits.
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Appointment } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import AppointmentDetailPanel from '@/components/calendar/AppointmentDetailPanel.vue';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const props = defineProps<{
  detailAppointment: Appointment | null;
  detailOpen: boolean;
  formOpen: boolean;
  formAppointment?: Appointment;
  prefillDate?: string;
  prefillStart?: string;
  prefillProfessionalId?: number;
  prefillResourceId?: number;
  prefillSobreturno: boolean;
  prefillDuration?: number;
  moveConfirmOpen: boolean;
  moveConfirmBody: string;
  conflictOpen: boolean;
  conflictVerdict: ConflictVerdict | null;
  conflictRevert: (() => void) | null;
}>();

const emit = defineEmits<{
  'detail-close': [];
  'detail-mutated': [appt: Appointment];
  reschedule: [appt: Appointment];
  approve: [appt: Appointment];
  'form-close': [];
  'form-saved': [appt: Appointment];
  'form-conflict': [verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>];
  'move-confirm': [];
  'move-cancel': [];
  'override-confirm': [];
  'override-cancel': [];
}>();

const { t } = useI18n();

// Keep the form mounted through the close animation (cleared on @after-leave) so the panel
// doesn't blank mid-close; opening flips it true via the watcher below.
const formMounted = ref(false);
watch(() => props.formOpen, (open) => { if (open) formMounted.value = true; });
</script>

<template>
  <AppointmentDetailPanel
    :appointment="detailAppointment"
    :open="detailOpen"
    @close="emit('detail-close')"
    @mutated="emit('detail-mutated', $event)"
    @reschedule="emit('reschedule', $event)"
    @approve="(appt) => emit('approve', appt)"
  />

  <DetailPanel
    :open="formOpen"
    :title="formAppointment ? t('calendar.reschedule') : t('calendar.newAppointment')"
    variant="side"
    size="2xl"
    @close="emit('form-close')"
    @after-leave="formMounted = false"
  >
    <AppointmentForm
      v-if="formMounted"
      :appointment="formAppointment"
      :prefill-date="prefillDate"
      :prefill-start="prefillStart"
      :prefill-professional-id="prefillProfessionalId"
      :prefill-resource-id="prefillResourceId"
      :prefill-sobreturno="prefillSobreturno"
      :prefill-duration="prefillDuration"
      @saved="emit('form-saved', $event)"
      @conflict-detected="(verdict, retryFn) => emit('form-conflict', verdict, retryFn)"
      @cancel="emit('form-close')"
    />
  </DetailPanel>

  <ConfirmDialog
    :open="moveConfirmOpen"
    :title="t('calendar.reschedule')"
    :body="moveConfirmBody"
    :confirm-label="t('actions.confirm')"
    @confirm="emit('move-confirm')"
    @cancel="emit('move-cancel')"
  />

  <ConflictOverrideDialog
    :open="conflictOpen"
    :verdict="conflictVerdict"
    :revert="conflictRevert"
    @confirm="emit('override-confirm')"
    @cancel="emit('override-cancel')"
  />
</template>
